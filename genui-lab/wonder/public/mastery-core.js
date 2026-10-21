// Adaptive learner model (Phase 6): a per-concept mastery estimate built from graded evidence.
// Pure functions over plain JSON so the model lives in localStorage next to the deck and is
// tested under node:test. The server never stores it: the client sends a compact summary with
// each lesson / tutor / Teacher request (server/learner-model.js re-validates it).
//
// Shape (store.data.mastery, a map so the multi-tab merge works per concept):
//   { [conceptKey]: { label, topic, events: [{at, score 0..1, weight, source}] } }
//
// Estimate: a Beta(1, 1) prior updated by every event, each weighted by an exponential decay
// with a 21-day half-life, so old evidence fades and the estimate follows forgetting.
//   mastery  = alpha / (alpha + beta)
//   evidence = sum of decayed weights (how much the estimate is based on)

export const HALF_LIFE_DAYS = 21;
export const MAX_EVENTS = 30; // per concept, newest kept
export const MAX_CONCEPTS = 300; // least recently seen dropped
export const SOURCE_WEIGHT = Object.freeze({ quiz: 1, teacher_quiz: 1, review: 1, explain: 1.5 });
export const SOURCES = Object.freeze(Object.keys(SOURCE_WEIGHT));

const DAY_MS = 86400000;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Display label: one line, at most 60 characters. */
export function cleanConcept(label) {
  return String(label ?? '').replace(/\s+/g, ' ').trim().replace(/[.:;,]+$/, '').slice(0, 60).trim();
}

/** Stable key: lowercase, no punctuation or leading article, so "The Mean" and "mean" match. */
export function conceptKey(label) {
  return cleanConcept(label).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/^(the|a|an)\s+/, '').replace(/\s+/g, ' ').trim();
}

/** FSRS rating (1 Again .. 4 Easy) -> evidence score. */
export function ratingScore(rating) {
  return { 1: 0, 2: 0.6, 3: 1, 4: 1 }[rating] ?? 0;
}

/**
 * Add evidence events. Each: {concept, score?: 0..1, correct?: boolean, source, topic?}.
 * Events without a usable concept or score are skipped. Returns a new mastery map.
 */
export function recordEvidence(mastery, events, now = new Date()) {
  const out = { ...(mastery || {}) };
  const at = new Date(now).toISOString();
  for (const ev of Array.isArray(events) ? events : []) {
    const label = cleanConcept(ev?.concept);
    const key = conceptKey(label);
    if (!key) continue;
    const score = typeof ev.score === 'number' && Number.isFinite(ev.score) ? clamp01(ev.score) : typeof ev.correct === 'boolean' ? (ev.correct ? 1 : 0) : null;
    if (score === null) continue;
    const source = SOURCES.includes(ev.source) ? ev.source : 'quiz';
    const prev = out[key] || { label, topic: '', events: [] };
    const topic = cleanConcept(ev.topic) || prev.topic || '';
    const events2 = [...(prev.events || []), { at: ev.at ? new Date(ev.at).toISOString() : at, score: Math.round(score * 100) / 100, weight: SOURCE_WEIGHT[source], source }].slice(-MAX_EVENTS);
    out[key] = { label: prev.label || label, topic, events: events2 };
  }
  const keys = Object.keys(out);
  if (keys.length > MAX_CONCEPTS) {
    const last = (k) => out[k].events?.at(-1)?.at || '';
    for (const k of keys.sort((a, b) => last(a).localeCompare(last(b))).slice(0, keys.length - MAX_CONCEPTS)) delete out[k];
  }
  return out;
}

export function forgetConcept(mastery, key) {
  const out = { ...(mastery || {}) };
  delete out[key];
  return out;
}

/** {mastery, evidence, status, lastAt, attempts} for one concept entry. */
export function estimateConcept(entry, now = new Date()) {
  const t = new Date(now).getTime();
  let alpha = 1;
  let beta = 1;
  let evidence = 0;
  for (const ev of entry?.events || []) {
    const age = Math.max(0, (t - new Date(ev.at).getTime()) / DAY_MS);
    const w = (Number(ev.weight) || 1) * 0.5 ** (age / HALF_LIFE_DAYS);
    const s = clamp01(Number(ev.score) || 0);
    alpha += w * s;
    beta += w * (1 - s);
    evidence += w;
  }
  const mastery = alpha / (alpha + beta);
  const attempts = (entry?.events || []).length;
  let status = 'learning';
  if (mastery >= 0.8 && evidence >= 2.5) status = 'mastered';
  else if (mastery < 0.55 && evidence >= 1.5) status = 'shaky';
  else if (attempts >= 2 && evidence < 1) status = 'fading'; // known once, not practiced lately
  return { mastery: Math.round(mastery * 100) / 100, evidence: Math.round(evidence * 100) / 100, status, lastAt: entry?.events?.at(-1)?.at || null, attempts };
}

/** Every concept with its estimate, weakest first (ties: most evidence first). */
export function masteryList(mastery, now = new Date()) {
  return Object.entries(mastery || {})
    .map(([key, entry]) => ({ key, label: entry.label || key, topic: entry.topic || '', ...estimateConcept(entry, now) }))
    .sort((a, b) => a.mastery - b.mastery || b.evidence - a.evidence || a.label.localeCompare(b.label));
}

export const STATUS_ORDER = Object.freeze(['shaky', 'fading', 'learning', 'mastered']);
export const STATUS_LABEL = Object.freeze({ shaky: 'Shaky', fading: 'Fading', learning: 'Learning', mastered: 'Mastered' });

/**
 * Compact summary sent with requests: up to `max` concepts per status, each
 * {concept, mastery 0..1, topic}. Shaky and fading are weakest first, mastered strongest first.
 */
export function masterySummary(mastery, now = new Date(), { max = 8 } = {}) {
  const list = masteryList(mastery, now);
  const pick = (status, strongestFirst = false) => {
    const xs = list.filter((c) => c.status === status);
    if (strongestFirst) xs.reverse();
    return xs.slice(0, max).map((c) => ({ concept: c.label, mastery: c.mastery, ...(c.topic ? { topic: c.topic } : {}) }));
  };
  return { shaky: pick('shaky'), fading: pick('fading'), learning: pick('learning'), mastered: pick('mastered', true), total: list.length };
}

/** Labels of the weakest concepts worth practicing now (shaky, then fading). */
export function weakestConcepts(mastery, now = new Date(), n = 3) {
  const list = masteryList(mastery, now);
  return [...list.filter((c) => c.status === 'shaky'), ...list.filter((c) => c.status === 'fading')].slice(0, n).map((c) => c.label);
}

/** Evidence events from a finished quiz's results ({prompt, correct, concept}). */
export function quizEvidence(results, { source = 'quiz', topic = '' } = {}) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && cleanConcept(r.concept) && typeof r.correct === 'boolean')
    .map((r) => ({ concept: r.concept, correct: r.correct, source, topic }));
}

/** Record evidence into a Wonder store (store.update), skipping the write when nothing applies. */
export function storeEvidence(store, events, now = new Date()) {
  const list = (Array.isArray(events) ? events : []).filter((e) => conceptKey(e?.concept));
  if (!list.length || !store) return 0;
  store.update((d) => { d.mastery = recordEvidence(d.mastery, list, now); return d; });
  return list.length;
}

/** The summary to send with a request, or undefined when personalization is off or empty. */
export function requestMastery(data, now = new Date()) {
  if (data?.settings?.memoryEnabled === false) return undefined;
  const s = masterySummary(data?.mastery, now);
  return s.total ? s : undefined;
}
