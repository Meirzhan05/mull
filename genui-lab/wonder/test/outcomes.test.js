import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDeck, addItems, reviewEntry, Rating } from '../public/deck.js';
import { normalizePracticeItem } from '../public/practice-core.js';
import { emptyState } from '../public/store.js';
import {
  lessonOutcome, allOutcomes, fadingLessons, lessonRecipe, pickVariant, variantStats, whatWorks,
  insightsForPrompt, outcomeSnapshot, outcomeLabel, STYLE_VARIANTS, VARIANT_IDS, RECALL_MIN,
} from '../public/outcomes-core.js';
import { createWonderServer } from '../server/app.js';
import { lessonUserMessage, cleanInsights, LESSON_SYSTEM_PROMPT } from '../server/prompts.js';
import { fakeClient } from './helpers.js';

const T0 = new Date('2026-10-01T09:00:00Z');
const days = (n) => new Date(T0.getTime() + n * 864e5);
const card = (lessonId, i) => normalizePracticeItem({ id: `${lessonId}-c${i}`, type: 'flashcard', front: `${lessonId} front ${i}`, back: 'b' });

/** A lesson with `cards` cards; each card reviewed Good on day 0, then `later` ratings at days 2, 6, 15. */
function withLesson(data, id, { cards = 3, later = [], variant, markdown = '# T\n\n## A\n\n## B', finished = true } = {}) {
  data.lessons[id] = { id, title: `Lesson ${id}`, topic: id, markdown, finished, status: 'complete', updatedAt: `2026-10-0${Object.keys(data.lessons).length + 1}T00:00:00Z`, ...(variant ? { variant } : {}) };
  const items = Array.from({ length: cards }, (_, i) => card(id, i));
  data.deck = addItems(data.deck, items, { lessonId: id, lessonTitle: id, now: T0 }).deck;
  for (const it of items) {
    data.deck = reviewEntry(data.deck, it.id, Rating.Good, T0).deck;
    data.deck = reviewEntry(data.deck, it.id, Rating.Good, new Date(T0.getTime() + 10 * 60000)).deck; // same-day learning step
    later.forEach((r, k) => { data.deck = reviewEntry(data.deck, it.id, r, days([2, 6, 15][k])).deck; });
  }
  return data;
}

const fresh = () => ({ ...emptyState(), deck: emptyDeck() });

test('outcomes: same-day reviews are not recall tests; delayed ones are, bucketed by gap', () => {
  const d = withLesson(fresh(), 'a', { later: [Rating.Good, Rating.Again, Rating.Good] });
  const o = lessonOutcome(d, 'a', days(16));
  assert.equal(o.cards, 3);
  assert.equal(o.recall.n, 9, 'three delayed reviews per card; day-0 steps excluded');
  assert.equal(o.recall.hits, 6);
  assert.equal(o.buckets['1-3'].n, 3);
  assert.equal(o.buckets['1-3'].rate, 1);
  assert.equal(o.buckets['4-13'].n, 6, 'gaps of 4 days (day 6) and 9 days (day 15)');
  assert.equal(o.buckets['4-13'].hits, 3, 'the day-6 reviews were Again');
  assert.equal(o.recall.confidence, 'ok');
  assert.ok(o.memoryToday > 0 && o.memoryToday <= 1);
  assert.equal(o.verdict, 'fading', '67% recall');
  assert.equal(outcomeLabel(o), '67% recall');
});

test('outcomes: too few delayed reviews is "unknown", never a verdict', () => {
  const d = withLesson(fresh(), 'a', { cards: 2, later: [] });
  const o = lessonOutcome(d, 'a', days(1));
  assert.equal(o.recall.n, 0);
  assert.equal(o.recall.confidence, 'none');
  assert.equal(o.verdict, 'unknown');
  assert.match(outcomeLabel(o), /^~\d+% memory$/, 'forecast memory is shown until recall is measured');
  const thin = lessonOutcome(withLesson(fresh(), 'b', { cards: 1, later: [Rating.Again, Rating.Again] }), 'b', days(7));
  assert.ok(thin.recall.n < RECALL_MIN);
});

test('outcomes: a long gap without review is forecast as fading; leeches are listed', () => {
  const d = withLesson(fresh(), 'a', { cards: 2 });
  assert.equal(lessonOutcome(d, 'a', days(200)).verdict, 'fading', 'FSRS memory far below 70%');
  const bad = withLesson(fresh(), 'b', { cards: 2, later: [Rating.Again, Rating.Again, Rating.Again] });
  const o = lessonOutcome(bad, 'b', days(16));
  assert.equal(o.verdict, 'weak');
  assert.equal(o.leeches.length, 2);
  assert.equal(o.leeches[0].misses, 3);
  assert.match(o.leeches[0].prompt, /front/);
});

test('outcomes: allOutcomes / fadingLessons order and snapshot', () => {
  let d = withLesson(fresh(), 'good', { later: [Rating.Good, Rating.Good, Rating.Good] });
  d = withLesson(d, 'bad', { later: [Rating.Again, Rating.Again, Rating.Hard] });
  d = withLesson(d, 'meh', { later: [Rating.Good, Rating.Again, Rating.Good] });
  assert.deepEqual(allOutcomes(d, days(16)).map((o) => o.lessonId), ['meh', 'bad', 'good'], 'newest first');
  assert.deepEqual(fadingLessons(d, days(16)).map((o) => o.lessonId), ['bad', 'meh']);
  const snap = outcomeSnapshot(d, days(16));
  assert.equal(snap.fading[0].title, 'Lesson bad');
  assert.equal(snap.fading[0].recall, 33, 'Hard counts as recalled');
  assert.ok(snap.fading[0].hardCards.length >= 1);
  assert.equal(snap.delayedReviews, 27);
});

test('recipe: components, grounding and variant come from the stored lesson', () => {
  const r = lessonRecipe({ markdown: '# T\n\n## A\n\n<LessonStepper steps={[]}/>\n\nx <Cite refs={["t"]}/>\n\n## B\n\n<Reveal items={[]}/>', variant: 'predict-first', tutor: [{ role: 'user' }, { role: 'assistant' }] });
  assert.deepEqual(r.components, ['LessonStepper', 'Reveal']);
  assert.equal(r.pages, 2);
  assert.equal(r.grounded, true);
  assert.equal(r.variant, 'predict-first');
  assert.equal(r.tutorQuestions, 1);
  assert.equal(lessonRecipe({ variant: 'bogus' }).variant, 'standard');
});

test('style experiment: balanced while exploring, then exploits the best style 2/3 of the time', () => {
  const d = fresh();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const v = pickVariant(d);
    seen.push(v);
    d.lessons[`x${i}`] = { id: `x${i}`, variant: v };
  }
  assert.deepEqual(seen, [...VARIANT_IDS, ...VARIANT_IDS], 'round-robin by least data');
  assert.equal(pickVariant({ ...d, settings: { styleExperiment: false } }), 'standard', 'off: always standard');

  let m = fresh();
  for (let i = 0; i < 3; i++) {
    m = withLesson(m, `s${i}`, { cards: 2, variant: 'standard', later: [Rating.Good, Rating.Again, Rating.Again] });
    m = withLesson(m, `e${i}`, { cards: 2, variant: 'example-first', later: [Rating.Good, Rating.Good, Rating.Good] });
    m = withLesson(m, `p${i}`, { cards: 2, variant: 'predict-first', later: [Rating.Good, Rating.Good, Rating.Again] });
  }
  const st = variantStats(m, days(16));
  assert.ok(st.every((s) => s.lessons === 3 && s.n === 18));
  assert.equal(pickVariant(m, { now: days(16), rand: () => 0.1 }), 'example-first');
  assert.equal(pickVariant(m, { now: days(16), rand: () => 0.7 }), 'standard');
  assert.equal(pickVariant(m, { now: days(16), rand: () => 0.99 }), 'predict-first');

  const w = whatWorks(m, days(16));
  assert.equal(w.findings[0].kind, 'variant');
  assert.match(w.findings[0].text, /example first.*100% recall vs 33%.*36 delayed reviews/);
  assert.equal(insightsForPrompt(m, days(16)).length, w.findings.length);
});

test('whatWorks: component findings need enough reviews on both sides and a real gap', () => {
  const step = '# T\n\n## A\n\n<LessonStepper steps={[]}/>';
  const plain = '# T\n\n## A\n\nText.';
  let d = fresh();
  d = withLesson(d, 'w1', { cards: 3, markdown: step, later: [Rating.Good, Rating.Good, Rating.Good] });
  d = withLesson(d, 'n1', { cards: 3, markdown: plain, later: [Rating.Again, Rating.Good, Rating.Again] });
  let w = whatWorks(d, days(16));
  const c = w.components.find((x) => x.name === 'LessonStepper');
  assert.equal(c.with.n, 9);
  assert.equal(c.without.n, 9);
  assert.equal(w.findings.length, 0, 'one lesson per side is an anecdote, even with enough reviews');
  d = withLesson(d, 'w2', { cards: 3, markdown: step, later: [Rating.Good, Rating.Good, Rating.Good] });
  d = withLesson(d, 'n2', { cards: 3, markdown: plain, later: [Rating.Again, Rating.Good, Rating.Again] });
  w = whatWorks(d, days(16));
  assert.equal(w.findings.length, 1);
  assert.match(w.findings[0].text, /worked example \(LessonStepper\) were remembered better: 100% vs 33%/);
  // a thin comparison is not a finding
  let small = fresh();
  small = withLesson(small, 'w1', { cards: 1, markdown: step, later: [Rating.Good, Rating.Good, Rating.Good] });
  small = withLesson(small, 'n1', { cards: 1, markdown: plain, later: [Rating.Again, Rating.Again, Rating.Again] });
  w = whatWorks(small, days(16));
  assert.equal(w.findings.length, 0);
  assert.deepEqual(insightsForPrompt(fresh()), []);
});

test('style variants: standard adds nothing; the others are one instruction line', () => {
  assert.equal(STYLE_VARIANTS.standard.instruction, '');
  for (const id of VARIANT_IDS.slice(1)) assert.ok(STYLE_VARIANTS[id].instruction.length > 40 && !STYLE_VARIANTS[id].instruction.includes('\n'));
});

// ---------------------------------------------------------------- server: variant + insights

test('lesson request: the style goes in the user turn, insights after the cache breakpoint', async () => {
  assert.ok(lessonUserMessage({ topic: 't', variant: 'example-first' }).endsWith(STYLE_VARIANTS['example-first'].instruction));
  assert.equal(lessonUserMessage({ topic: 't', variant: 'standard' }), lessonUserMessage({ topic: 't' }));
  assert.equal(lessonUserMessage({ topic: 't', variant: 'evil' }), lessonUserMessage({ topic: 't' }), 'unknown variants are ignored');
  assert.deepEqual(cleanInsights(['a <b>\nc', 7, '', 'x'.repeat(500), 'd', 'e', 'f']), ['a b c', 'x'.repeat(240), 'd', 'e']);

  const client = fakeClient({ text: '# T\n\nHook.\n\n## A\n\nText.' });
  const server = createWonderServer({ mode: 'claude', client, demoDelayMs: 0, logger: { warn() {}, error() {}, info() {}, log() {} }, memoryFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/lesson/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
  try {
    await post({ topic: 'tides', variant: 'predict-first', useWebSearch: false, learnerInsights: ['Lessons with a timeline were remembered better: 90% vs 60% without (40 delayed reviews).'] });
    let p = client.calls.stream[0].params;
    assert.equal(p.system[0].text, LESSON_SYSTEM_PROMPT, 'cached system prompt unchanged');
    assert.match(p.messages[0].content, /predict/);
    assert.match(p.system[1].text, /recalled earlier lessons days later:\n- Lessons with a timeline/);
    await post({ topic: 'tides', useWebSearch: false, memoryEnabled: false, learnerInsights: ['x'] });
    p = client.calls.stream[1].params;
    assert.ok(!p.system[1] || !/recalled earlier lessons/.test(p.system[1].text), 'memory off: no insights');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
