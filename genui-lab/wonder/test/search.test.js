import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDeck, addItems } from '../public/deck.js';
import { normalizePracticeItem } from '../public/practice-core.js';
import { emptyState } from '../public/store.js';
import {
  fold, queryTokens, markdownToText, lessonText, buildIndex, searchIndex, searchGroups, groupResults, createSearcher, SEARCH_TYPES,
} from '../public/search-core.js';

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/demo');
const plain = (parts) => parts.map((p) => (p.hit ? `[${p.text}]` : p.text)).join('');

const BAYES = `# Bayes' rule

You test positive for a rare disease. How worried should you be?

## Priors matter

Start from the <KeyTerm term="base rate" definition="How common something is before you see any evidence."/>.

<LessonStepper title="Worked example" steps={[{"label":"Step 1","text":"1 in 1,000 people have the disease: the prior."},{"label":"Step 2","text":"The test flags 5% of healthy people: false positives."}]}/>

## Updating on evidence

<box padding={4} background="surface-secondary"><text size="sm">Posterior odds = prior odds × likelihood ratio</text></box>

<math>P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}</math>

<Quiz questions={[{"prompt":"What is x^{2} when x = 3?","options":[{"value":"a","label":"Nine"}],"correct_values":["a"]}]}/>
`;

function state() {
  const d = { ...emptyState(), deck: emptyDeck() };
  d.lessons = {
    bayes: { id: 'bayes', title: "Bayes' rule", topic: 'Bayesian reasoning', markdown: BAYES, status: 'complete', updatedAt: '2026-10-01T00:00:00Z' },
    cafe: { id: 'cafe', title: 'Café culture in Vienna', topic: 'Vienna', markdown: '# Café culture in Vienna\n\nThe Viennese café is a living room.\n\n## Mélange\n\nOrder a Wiener Melange.', updatedAt: '2026-10-02T00:00:00Z' },
    stats: { id: 'stats', title: 'Statistics basics', topic: 'statistics', markdown: '# Statistics basics\n\n## Probability\n\nA prior is what you believe before the data. Bayes comes later.', updatedAt: '2026-10-03T00:00:00Z' },
  };
  d.courses = [{ id: 'c1', title: 'Probability for humans', description: 'From coins to classifiers.', createdAt: '2026-09-01T00:00:00Z',
    sections: [{ title: 'Basics', lessons: [{ title: 'Conditional probability', lessonId: null }, { title: 'Updating beliefs with Bayes', lessonId: 'bayes' }] }] }];
  const items = [
    normalizePracticeItem({ id: 'k1', type: 'flashcard', front: 'What is a **base rate**?', back: 'How common something is before any evidence.' }),
    normalizePracticeItem({ id: 'k2', type: 'mcq', prompt: 'Which one is the posterior?', choices: [{ id: 'a', text: 'P(A|B)', isCorrect: true }, { id: 'b', text: 'P(B)', isCorrect: false }], explanation: 'Updated belief after evidence.' }),
    normalizePracticeItem({ id: 'k3', type: 'cloze', prompt: '____: the belief before evidence', answer: 'prior' }),
  ];
  d.deck = addItems(d.deck, items.slice(0, 2), { lessonId: 'bayes', lessonTitle: "Bayes' rule", now: new Date('2026-10-01T00:00:00Z') }).deck;
  d.deck = addItems(d.deck, items.slice(2), { lessonId: null, now: new Date('2026-10-04T00:00:00Z') }).deck;
  d.teacherThreads = [{ id: 't1', title: 'Exam prep', updatedAt: '2026-10-05T00:00:00Z', messages: [
    { role: 'user', content: 'Can you quiz me on conditional probability?' },
    { role: 'assistant', content: 'Sure. <Callout title="Remember">Bayes flips the condition.</Callout> What is **P(rain | clouds)**?' },
  ] }];
  return d;
}

test('search: folding is case- and accent-insensitive and keeps offsets', () => {
  assert.equal(fold('Café MÉLANGE'), 'cafe melange');
  assert.equal(fold('Ünïcödé').length, 'Ünïcödé'.length);
  assert.deepEqual(queryTokens("  Bayes' RULE "), ['bayes', 'rule']);
  const idx = buildIndex(state());
  assert.equal(searchIndex(idx, 'cafe')[0].id, 'cafe');
  assert.equal(searchIndex(idx, 'MÉLANGE')[0].id, 'cafe');
  assert.equal(plain(searchIndex(idx, 'cafe')[0].title), '[Café] culture in Vienna', 'highlight lands on the accented original');
});

test('search: markdown to text keeps component words and KeyTerms, drops markup', () => {
  const { text, terms } = markdownToText(BAYES);
  assert.deepEqual(terms, ['base rate']);
  assert.match(text, /base rate \(How common something is before you see any evidence\.\)/);
  assert.match(text, /1 in 1,000 people have the disease/, 'LessonStepper step text is searchable');
  assert.match(text, /What is x\^\{2\} when x = 3\?/, 'braces inside strings do not end the tag');
  assert.match(text, /Posterior odds = prior odds/);
  assert.doesNotMatch(text, /surface-secondary|padding|correct_values|<|LessonStepper|"label"/);
  assert.doesNotMatch(text, /\bStep 1\b.*\bStep 1\b/);
  // a stray "<" stays text
  assert.equal(markdownToText('if a < b and b > c').text, 'if a < b and b > c');
});

test('search: Diagram labels and Figure captions are words; geometry and image queries are not', () => {
  const md = '<Diagram title="Light paths" shapes={[{"type":"path","d":"M0 150 Q200 90 Z","fill":"sky","part":"air"},{"type":"text","x":1,"y":2,"text":"Atmosphere","anchor":"start"}]} parts={[{"id":"air","label":"The atmosphere","text":"A shell of air."}]} steps={[{"label":"Noon","text":"Short trip.","show":["air"],"highlight":["air"]}]}/>\n\n<Figure query="cumulus clouds blue sky" caption="Clouds look white." alt="White clouds"/>';
  const { text } = markdownToText(md);
  for (const w of ['Light paths', 'Atmosphere', 'The atmosphere', 'A shell of air.', 'Noon', 'Short trip.', 'Clouds look white.', 'White clouds']) assert.ok(text.includes(w), w);
  assert.doesNotMatch(text, /\bpath\b|M0 150|\bsky\b|\bair\b(?! *\.)|\bstart\b|cumulus/);
});

test('search: a Video\'s caption and questions are words; its search hints and question codes are not', () => {
  const md = '<Video query="sunset in a glass milk flashlight" shows="beam turning orange" caption="Milk droplets scatter light." questions={[{"when":"before","prompt":"What color is the beam?","question_type":"single_select","options":[{"value":"a","label":"Bluish"},{"value":"b","label":"Orange-red"}],"correct_values":["b"],"explanation":"Blue is scattered out."}]}/>\n\n<Timeline events={[{"when":"July 1969","label":"Moon landing"}]}/>';
  const { text } = markdownToText(md);
  for (const w of ['Milk droplets scatter light.', 'What color is the beam?', 'Bluish', 'Orange-red', 'Blue is scattered out.', 'July 1969', 'Moon landing']) assert.ok(text.includes(w), w);
  assert.doesNotMatch(text, /flashlight|turning orange|\bbefore\b|single_select/);
});

test('search: lesson pages map body offsets to "## " pages', () => {
  const { text, pages } = lessonText(BAYES);
  assert.equal(pages.length, 2);
  assert.ok(text.slice(pages[0]).startsWith('Priors matter'));
  assert.ok(text.slice(pages[1]).startsWith('Updating on evidence'));
  assert.doesNotMatch(text, /^Bayes' rule/, 'the "# Title" is indexed as the title, not the body');
  const idx = buildIndex(state());
  const r = searchIndex(idx, 'likelihood ratio')[0];
  assert.equal(r.id, 'bayes');
  assert.equal(r.page, 2);
  assert.equal(searchIndex(idx, 'rare disease')[0].page, 0, 'the intro is page 0');
  assert.equal(searchIndex(idx, 'false positives')[0].page, 1);
});

test('search: title hits outrank body hits, every word must match, prefixes count', () => {
  const idx = buildIndex(state());
  const bayes = searchIndex(idx, 'bayes');
  assert.equal(bayes[0].id, 'bayes', 'title hit first');
  assert.ok(bayes.some((r) => r.id === 'stats'), 'a body mention is still found');
  assert.ok(bayes.findIndex((r) => r.id === 'bayes') < bayes.findIndex((r) => r.id === 'stats'));
  assert.equal(searchIndex(idx, 'bay')[0].id, 'bayes', 'prefix match');
  assert.equal(searchIndex(idx, 'ayes').length, 0, 'mid-word fragments do not match');
  assert.deepEqual(searchIndex(idx, 'bayes vienna'), [], 'all words must match');
  assert.equal(searchIndex(idx, 'stat')[0].id, 'stats');
  assert.deepEqual(searchIndex(idx, '   '), []);
  assert.deepEqual(searchIndex(idx, '!!'), []);
});

test('search: recency breaks ties', () => {
  const d = { ...emptyState(), lessons: {} };
  for (const [id, at] of [['old', '2026-01-01'], ['new', '2026-06-01'], ['mid', '2026-03-01']]) {
    d.lessons[id] = { id, title: `Tides ${id}`, markdown: '# Tides\n\nThe moon pulls the sea.', updatedAt: `${at}T00:00:00Z` };
  }
  assert.deepEqual(searchIndex(buildIndex(d), 'moon').map((r) => r.id), ['new', 'mid', 'old']);
});

test('search: cards, courses and Teacher chats', () => {
  const idx = buildIndex(state());
  const card = searchIndex(idx, 'base rate', { types: ['card'] })[0];
  assert.equal(card.id, 'k1');
  assert.equal(card.href, '#/review/lesson/bayes');
  assert.equal(card.lessonId, 'bayes');
  assert.equal(plain(card.title), 'What is a [base rate]?', 'markdown stripped, phrase highlighted');
  assert.equal(card.sub, "Bayes' rule");
  const mcq = searchIndex(idx, 'posterior', { types: ['card'] })[0];
  assert.equal(mcq.id, 'k2');
  assert.equal(searchIndex(idx, 'P(A|B)', { types: ['card'] })[0].id, 'k2', 'the correct choice is the answer');
  const orphan = searchIndex(idx, 'belief before', { types: ['card'] })[0];
  assert.equal(orphan.id, 'k3');
  assert.equal(orphan.href, '#/review', 'a card without a lesson opens the review queue');
  assert.equal(searchIndex(idx, 'prior', { types: ['card'] })[0].id, 'k3', 'cloze answers are indexed');

  const course = searchIndex(idx, 'conditional', { types: ['course'] })[0];
  assert.equal(course.id, 'c1');
  assert.equal(course.href, '#/course/c1');
  assert.match(plain(course.snippet), /\[Conditional\] probability/);

  const thread = searchIndex(idx, 'flips the condition', { types: ['thread'] })[0];
  assert.equal(thread.id, 't1');
  assert.equal(thread.href, '#/teacher/t1');
  assert.match(plain(thread.snippet), /Bayes \[flips the condition\]/);
});

test('search: snippets are short windows with ellipses around the match', () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const d = { ...emptyState(), lessons: { l: { id: 'l', title: 'Long', markdown: `# Long\n\n${long} needle ${long}`, updatedAt: '2026-01-01T00:00:00Z' } } };
  const r = searchIndex(buildIndex(d), 'needle')[0];
  const s = plain(r.snippet);
  assert.ok(s.startsWith('…') && s.endsWith('…'), s);
  assert.ok(s.length < 200, `snippet stays short (${s.length})`);
  assert.match(s, /word\d+ \[needle\] word0/);
  // a title-only match still gets a (non-highlighted) snippet from the body
  const t = searchIndex(buildIndex(d), 'long')[0];
  assert.ok(t.snippet.length && !t.snippet.some((p) => p.hit));
});

test('search: groupResults groups by type in a fixed order with totals', () => {
  const results = searchIndex(buildIndex(state()), 'bayes');
  const groups = groupResults(results, 1);
  assert.deepEqual(groups.map((g) => g.type), SEARCH_TYPES.filter((t) => results.some((r) => r.type === t)));
  const lessons = groups.find((g) => g.type === 'lesson');
  assert.equal(lessons.results.length, 1);
  assert.equal(lessons.total, results.filter((r) => r.type === 'lesson').length);
  assert.equal(lessons.label, 'Lessons');
});

test('search: searchGroups counts every match but builds only the shown results', () => {
  const d = { ...emptyState(), deck: emptyDeck() };
  const items = Array.from({ length: 30 }, (_, i) => normalizePracticeItem({ id: `q${i}`, type: 'flashcard', front: `Tide question ${i}`, back: 'The moon.' }));
  d.deck = addItems(d.deck, items, { lessonId: 'x' }).deck;
  d.lessons = { t: { id: 't', title: 'Tides', markdown: '# Tides\n\nThe moon pulls the sea.', updatedAt: '2026-10-01T00:00:00Z' } };
  const groups = searchGroups(buildIndex(d), 'tide', { perType: 3 });
  assert.deepEqual(groups.map((g) => [g.type, g.total, g.results.length]), [['lesson', 1, 1], ['card', 30, 3]]);
  assert.deepEqual(createSearcher().groups(d, ' ', { revision: 1 }), []);
});

test('search: the searcher caches the index per store revision', () => {
  const d = state();
  const s = createSearcher();
  const a = s.index(d, 1);
  assert.equal(s.index(d, 1), a, 'same revision: cached');
  assert.equal(s.search(d, 'tides', { revision: 1 }).length, 0);
  d.lessons.t = { id: 't', title: 'Tides', markdown: '# Tides', updatedAt: '2026-10-09T00:00:00Z' };
  assert.equal(s.search(d, 'tides', { revision: 1 }).length, 0, 'stale until the revision changes');
  assert.equal(s.search(d, 'tides', { revision: 2 })[0].id, 't');
  assert.notEqual(s.index({ ...d }, 2), a, 'a replaced state object rebuilds too');
  assert.deepEqual(s.search(d, '', { revision: 2 }), []);
});

test('search: demo lessons index cleanly', () => {
  const d = { ...emptyState(), lessons: {} };
  for (const f of ['compound-interest', 'sky-blue', 'transformers']) d.lessons[f] = { id: f, title: f, markdown: fs.readFileSync(path.join(DEMO, `${f}.md`), 'utf8'), updatedAt: '2026-10-01T00:00:00Z' };
  const idx = buildIndex(d);
  for (const doc of idx.docs) {
    const body = doc.fields.find((f) => f.name === 'body').text;
    assert.doesNotMatch(body, /<[A-Za-z]|\{\{|"label":/, `${doc.id} has no leftover markup`);
  }
  const r = searchIndex(idx, 'rule of 72')[0];
  assert.equal(r.id, 'compound-interest');
  assert.match(plain(r.snippet), /\[Rule of 72\]/);
  assert.ok(r.page >= 1);
  assert.equal(searchIndex(idx, 'rayleigh')[0].id, 'sky-blue');
});

test('search: fast enough per keystroke on 200 lessons and 2000 cards', () => {
  const d = { ...emptyState(), deck: emptyDeck() };
  const words = 'light energy wave matrix vector market protein theorem river climate signal neuron orbit enzyme lattice'.split(' ');
  const para = (i) => Array.from({ length: 120 }, (_, k) => words[(i * 7 + k * 3) % words.length] + (k % 11 === 0 ? 's' : '')).join(' ');
  for (let i = 0; i < 200; i++) {
    const pages = Array.from({ length: 6 }, (_, p) => `## Page ${p}\n\n${para(i + p)}\n\n<KeyTerm term="term${i}x${p}" definition="${para(p).slice(0, 80)}"/>`).join('\n\n');
    d.lessons[`l${i}`] = { id: `l${i}`, title: `Lesson ${i} on ${words[i % words.length]}`, markdown: `# Lesson ${i}\n\nIntro.\n\n${pages}`, updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() };
  }
  const items = Array.from({ length: 2000 }, (_, i) => normalizePracticeItem({ id: `c${i}`, type: 'flashcard', front: `Card ${i}: what about ${words[i % words.length]}?`, back: para(i).slice(0, 120) }));
  d.deck = addItems(d.deck, items, { lessonId: 'l1', lessonTitle: 'Lesson 1' }).deck;

  const s = createSearcher();
  let t0 = performance.now();
  s.index(d, 1);
  const build = performance.now() - t0;
  const queries = ['e', 'en', 'ene', 'energ', 'energy w', 'energy wave', 'term150x3', 'protein lattice', 'zzz', 'lesson 1'];
  t0 = performance.now();
  for (const q of queries) s.search(d, q, { revision: 1, limit: 200 });
  const per = (performance.now() - t0) / queries.length;
  assert.ok(build < 1500, `index build ${build.toFixed(0)} ms`);
  assert.ok(per < 60, `per query ${per.toFixed(1)} ms`);
  assert.equal(s.search(d, 'term150x3', { revision: 1 })[0].id, 'l150');
});
