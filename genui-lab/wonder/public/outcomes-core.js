// Phase 9: did each lesson work? Pure helpers (no DOM) shared by the browser and the server.
//
// A lesson's quiz score says what the learner knew a minute after reading it. What matters is
// what they still know days later, and the review deck already measures exactly that: every
// FSRS review of a lesson's cards after a gap of at least a day is a recall test. This module
// turns the deck logs into per-lesson outcomes, runs a balanced teaching-style experiment
// (STYLE_VARIANTS), and summarizes "what works for this learner" with sample sizes and
// thresholds so that small numbers are never presented as findings.

import { forgettingCurve, State } from '../../wondering-genui/src/fsrs.js';

export const RECALL_MIN = 3; // delayed reviews before a lesson's recall is shown
export const FINDING_MIN = 8; // delayed reviews on each side of a comparison
export const FINDING_GAP = 0.10; // recall difference worth reporting
export const FINDING_LESSONS = 2; // lessons on each side: one lesson is an anecdote, not a pattern
export const EXPLOIT_LESSONS = 3; // finished lessons per style before exploiting
export const EXPLOIT_REVIEWS = 5; // delayed reviews per style before exploiting
const DAY = 864e5;

/**
 * Teaching styles under test. `instruction` is appended to the lesson *user* message (the
 * cached system prompt never changes); `standard` adds nothing.
 */
export const STYLE_VARIANTS = Object.freeze({
  standard: { label: 'Standard', hint: 'Idea, then example', instruction: '' },
  'example-first': { label: 'Example first', hint: 'A concrete case before each idea', instruction: 'Teaching style for this lesson: open every page with one concrete, specific example or case (real numbers, a real situation), and only then state the general idea it illustrates.' },
  'predict-first': { label: 'Predict first', hint: 'Guess, then find out', instruction: 'Teaching style for this lesson: open every page with a short question that asks the learner to predict or guess, using a <Reveal> whose answer the rest of the page then explains.' },
});
export const VARIANT_IDS = Object.freeze(Object.keys(STYLE_VARIANTS));
export const isVariant = (v) => typeof v === 'string' && Object.hasOwn(STYLE_VARIANTS, v);

/** Catalog components that can differ between lessons (Cite/Sources/Followups are plumbing). */
export const RECIPE_COMPONENTS = Object.freeze({
  LessonStepper: 'worked example (LessonStepper)',
  Reveal: 'predict-then-reveal (Reveal)',
  CompareToggle: 'side-by-side comparison (CompareToggle)',
  InputOutputSlider: 'what-if slider (InputOutputSlider)',
  Flowchart: 'flowchart',
  Timeline: 'timeline',
  BarChart: 'bar chart',
  ConceptMap: 'concept map',
  Cycle: 'cycle diagram',
  Flashcards: 'in-lesson flashcards',
  FunctionGraph: 'interactive graph (FunctionGraph)',
  Diagram: 'interactive diagram (Diagram)',
  Figure: 'real image (Figure)',
  Callout: 'callout asides',
});

const rate = (hits, n) => (n ? hits / n : null);
const pct = (r) => `${Math.round(r * 100)}%`;
const confidence = (n) => (n < RECALL_MIN ? 'none' : n < 8 ? 'low' : n < 20 ? 'ok' : 'good');
const bucketOf = (days) => (days <= 3 ? '1-3' : days <= 13 ? '4-13' : '14+');

/** A Figure counts only when the server found an image for it (else nothing was shown). */
const showedFigure = (lesson) => Object.values(lesson?.dil?.appData?.opGenui?.componentResults || {}).some((r) => r?.state?.found === true && typeof r.state.src === 'string');

/** What went into a lesson, read from its stored markdown (works for lessons made before Phase 9). */
export function lessonRecipe(lesson) {
  const md = String(lesson?.markdown || '');
  const components = Object.keys(RECIPE_COMPONENTS).filter((name) => new RegExp(`<${name}\\b`).test(md) && (name !== 'Figure' || showedFigure(lesson)));
  return {
    variant: isVariant(lesson?.variant) ? lesson.variant : 'standard',
    components,
    pages: (md.match(/^## /gm) || []).length,
    level: lesson?.level || 'beginner',
    grounded: /<Cite\b/.test(md),
    material: !!lesson?.materialId,
    tutorQuestions: (lesson?.tutor || []).filter((m) => m?.role === 'user').length,
  };
}

/** Delayed-recall reviews (gap of at least a day since that card's previous review) per deck entry. */
function delayedByEntry(deck) {
  const out = new Map();
  for (const log of deck?.logs || []) {
    if (!(Number(log?.elapsed_days) >= 1)) continue;
    const list = out.get(log.entryId) || [];
    list.push(log);
    out.set(log.entryId, list);
  }
  return out;
}

function tally(logs) {
  let n = 0;
  let hits = 0;
  for (const l of logs) { n++; if (Number(l.rating) >= 2) hits++; }
  return { n, hits, rate: rate(hits, n) };
}

/** Mean FSRS retrievability now over cards that have been reviewed at least once. */
function memoryToday(entries, now) {
  const t = new Date(now).getTime();
  const rs = [];
  for (const e of entries) {
    const c = e.card || {};
    if (c.state === State.New || !c.last_review || !(Number(c.stability) > 0)) continue;
    const days = Math.max(0, (t - new Date(c.last_review).getTime()) / DAY);
    rs.push(forgettingCurve(days, Number(c.stability)));
  }
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
}

function verdictOf(recall, mem) {
  if (recall.n >= RECALL_MIN) return recall.rate >= 0.85 ? 'stuck' : recall.rate >= 0.65 ? 'fading' : 'weak';
  if (mem != null && mem < 0.7) return 'fading'; // FSRS forecasts it slipping before any delayed test
  return 'unknown';
}

/**
 * Outcome of one lesson:
 *   {lessonId, title, quiz, recall:{n,hits,rate,confidence}, buckets:{'1-3','4-13','14+'},
 *    memoryToday, cards, reviewed, leeches:[{entryId, prompt, lapses}], verdict}
 */
export function lessonOutcome(data, lessonId, now = new Date(), delayed = delayedByEntry(data?.deck)) {
  const lesson = data?.lessons?.[lessonId] || null;
  const entries = (data?.deck?.items || []).filter((e) => e.lessonId === lessonId);
  const logs = entries.flatMap((e) => delayed.get(e.id) || []);
  const recall = tally(logs);
  const buckets = {};
  for (const key of ['1-3', '4-13', '14+']) buckets[key] = tally(logs.filter((l) => bucketOf(Number(l.elapsed_days)) === key));
  const mem = memoryToday(entries, now);
  // leeches: cards missed (Again) on at least two delayed reviews, or lapsed twice by FSRS
  // (FSRS only counts a lapse from Review state, so misses while relearning need the log)
  const leeches = entries.map((e) => {
    const misses = (delayed.get(e.id) || []).filter((l) => Number(l.rating) === 1).length;
    return { entryId: e.id, prompt: String(e.item?.prompt || e.item?.front || '').slice(0, 200), misses: Math.max(misses, Number(e.card?.lapses) || 0) };
  }).filter((l) => l.misses >= 2).sort((a, b) => b.misses - a.misses);
  return {
    lessonId,
    title: lesson?.title || lesson?.topic || entries[0]?.lessonTitle || '',
    quiz: lesson?.quizScore?.total ? { score: lesson.quizScore.score, total: lesson.quizScore.total } : null,
    recall: { ...recall, confidence: confidence(recall.n) },
    buckets,
    memoryToday: mem,
    cards: entries.length,
    reviewed: entries.filter((e) => e.card?.state !== State.New).length,
    leeches,
    verdict: verdictOf(recall, mem),
  };
}

/** Outcomes of every lesson that has cards in the deck, newest lesson first. */
export function allOutcomes(data, now = new Date()) {
  const delayed = delayedByEntry(data?.deck);
  const ids = [...new Set((data?.deck?.items || []).map((e) => e.lessonId).filter(Boolean))];
  const when = (id) => data?.lessons?.[id]?.updatedAt || '';
  return ids.sort((a, b) => when(b).localeCompare(when(a))).map((id) => lessonOutcome(data, id, now, delayed));
}

/** Lessons that did not stick, worst first (recall when measured, else forecast memory). */
export function fadingLessons(data, now = new Date(), limit = 5) {
  const score = (o) => (o.recall.n >= RECALL_MIN ? o.recall.rate : o.memoryToday ?? 1);
  return allOutcomes(data, now)
    .filter((o) => o.verdict === 'weak' || o.verdict === 'fading' || o.leeches.length)
    .sort((a, b) => score(a) - score(b) || b.leeches.length - a.leeches.length)
    .slice(0, limit);
}

/** Short label for a lesson tile / end panel, or null when nothing is measured yet. */
export function outcomeLabel(o) {
  if (!o) return null;
  if (o.recall.n >= RECALL_MIN) return `${pct(o.recall.rate)} recall`;
  if (o.memoryToday != null && o.reviewed) return `~${pct(o.memoryToday)} memory`;
  return null;
}

// ---------------------------------------------------------------- what works

function groupStats(data, outcomes, keyOf) {
  const out = new Map();
  for (const o of outcomes) {
    const lesson = data?.lessons?.[o.lessonId];
    if (!lesson) continue;
    for (const k of [].concat(keyOf(lesson))) {
      const g = out.get(k) || { lessons: 0, n: 0, hits: 0 };
      g.lessons++;
      g.n += o.recall.n;
      g.hits += o.recall.hits;
      out.set(k, g);
    }
  }
  for (const g of out.values()) g.rate = rate(g.hits, g.n);
  return out;
}

/** Per-style data: lessons assigned (any status), finished lessons, delayed reviews, recall. */
export function variantStats(data, now = new Date()) {
  const outcomes = allOutcomes(data, now);
  const finished = groupStats(data, outcomes.filter((o) => data?.lessons?.[o.lessonId]?.finished), (l) => (isVariant(l.variant) ? l.variant : 'standard'));
  const assigned = {};
  for (const l of Object.values(data?.lessons || {})) if (isVariant(l?.variant)) assigned[l.variant] = (assigned[l.variant] || 0) + 1;
  return VARIANT_IDS.map((id) => {
    const g = finished.get(id) || { lessons: 0, n: 0, hits: 0, rate: null };
    return { id, label: STYLE_VARIANTS[id].label, hint: STYLE_VARIANTS[id].hint, assigned: assigned[id] || 0, lessons: g.lessons, n: g.n, hits: g.hits, rate: g.rate };
  });
}

/**
 * Teaching style for the next lesson. Off: always standard. Otherwise balanced exploration
 * (the style with the least data goes next) until every style has enough measured lessons,
 * then the best-recall style 2/3 of the time and an even split of the rest.
 */
export function pickVariant(data, { now = new Date(), rand = Math.random } = {}) {
  if (data?.settings?.styleExperiment === false) return 'standard';
  const stats = variantStats(data, now);
  const ready = stats.every((s) => s.lessons >= EXPLOIT_LESSONS && s.n >= EXPLOIT_REVIEWS);
  if (!ready) {
    const order = stats.slice().sort((a, b) => a.assigned - b.assigned || a.n - b.n || VARIANT_IDS.indexOf(a.id) - VARIANT_IDS.indexOf(b.id));
    return order[0].id;
  }
  const best = stats.slice().sort((a, b) => b.rate - a.rate || a.n - b.n)[0];
  const r = rand();
  if (r < 2 / 3) return best.id;
  const others = stats.filter((s) => s.id !== best.id);
  return others[Math.min(others.length - 1, Math.floor(((r - 2 / 3) / (1 / 3)) * others.length))].id;
}

/**
 * Recall by teaching style and by component, plus plain-language findings that clear the
 * thresholds (each side ≥ FINDING_LESSONS lessons and ≥ FINDING_MIN delayed reviews, and a gap
 * ≥ FINDING_GAP). These are correlations within one learner's lessons, worded as such.
 */
export function whatWorks(data, now = new Date()) {
  const outcomes = allOutcomes(data, now).filter((o) => data?.lessons?.[o.lessonId]);
  const variants = variantStats(data, now);
  const totalN = outcomes.reduce((a, o) => a + o.recall.n, 0);
  const totalHits = outcomes.reduce((a, o) => a + o.recall.hits, 0);
  const comps = groupStats(data, outcomes, (l) => lessonRecipe(l).components);
  const components = [];
  for (const [name, w] of comps) {
    const without = { lessons: outcomes.length - w.lessons, n: totalN - w.n, hits: totalHits - w.hits };
    without.rate = rate(without.hits, without.n);
    components.push({ name, label: RECIPE_COMPONENTS[name], with: { lessons: w.lessons, n: w.n, rate: w.rate }, without: { lessons: without.lessons, n: without.n, rate: without.rate }, delta: w.rate != null && without.rate != null ? w.rate - without.rate : null });
  }
  components.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const findings = [];
  const measured = variants.filter((v) => v.n >= FINDING_MIN && v.lessons >= FINDING_LESSONS).sort((a, b) => b.rate - a.rate);
  if (measured.length >= 2 && measured[0].rate - measured[measured.length - 1].rate >= FINDING_GAP) {
    const top = measured[0];
    const low = measured[measured.length - 1];
    findings.push({ kind: 'variant', id: top.id, text: `Lessons taught "${top.label.toLowerCase()}" were remembered best: ${pct(top.rate)} recall vs ${pct(low.rate)} for "${low.label.toLowerCase()}" (${top.n + low.n} delayed reviews).` });
  }
  for (const c of components) {
    if (findings.length >= 4) break;
    if (c.with.n < FINDING_MIN || c.without.n < FINDING_MIN || c.with.lessons < FINDING_LESSONS || c.without.lessons < FINDING_LESSONS || Math.abs(c.delta) < FINDING_GAP) continue;
    findings.push(c.delta > 0
      ? { kind: 'component', id: c.name, positive: true, text: `Lessons with a ${c.label} were remembered better: ${pct(c.with.rate)} vs ${pct(c.without.rate)} without (${c.with.n + c.without.n} delayed reviews).` }
      : { kind: 'component', id: c.name, positive: false, text: `Lessons with a ${c.label} were remembered worse: ${pct(c.with.rate)} vs ${pct(c.without.rate)} without (${c.with.n + c.without.n} delayed reviews).` });
  }
  return { totalReviews: totalN, recall: rate(totalHits, totalN), variants, components, findings };
}

/** Findings as prompt lines for the lesson request (`learnerInsights`), [] when there are none. */
export function insightsForPrompt(data, now = new Date()) {
  return whatWorks(data, now).findings.map((f) => f.text).slice(0, 4);
}

/** Compact outcome fields for the Teacher's progress snapshot. */
export function outcomeSnapshot(data, now = new Date()) {
  const fading = fadingLessons(data, now, 4).map((o) => ({
    title: o.title,
    verdict: o.verdict,
    ...(o.recall.n >= RECALL_MIN ? { recall: Math.round(o.recall.rate * 100), reviews: o.recall.n } : {}),
    ...(o.memoryToday != null ? { memoryToday: Math.round(o.memoryToday * 100) } : {}),
    hardCards: o.leeches.slice(0, 2).map((l) => l.prompt),
  }));
  const w = whatWorks(data, now);
  return { fading, whatWorks: w.findings.map((f) => f.text), overallRecall: w.recall == null ? null : Math.round(w.recall * 100), delayedReviews: w.totalReviews };
}
