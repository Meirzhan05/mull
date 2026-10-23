// Cumulative course review: one session that mixes the cards of every lesson in a course.
// Lessons are reviewed one by one elsewhere (#/review, Phase 9 "Refresh"); this asks whether the
// learner can still recall the course's ideas side by side, interleaved, which beats blocked
// review for retention. Pure functions over the store's JSON, tested under node:test.
//
//   courseReviewSession(data, courseId, {now, seed, size}) -> {course, entries, lessons}
//   courseMemory(data, course, now)                         -> per-lesson and course-wide memory
//   courseReviewSuggestion(data, now)                       -> the course to review now, or null
//   courseReviewSummary(data, course, results)              -> recall per lesson + the weakest

import { forgettingCurve, State } from '../../wondering-genui/src/fsrs.js';
import { weakestConcepts, conceptKey } from './mastery-core.js';
import { lessonOutcome } from './outcomes-core.js';
import { dateKey } from './deck.js';

export const COURSE_REVIEW_SIZE = 16; // cards in one session
export const COURSE_REVIEW_MIN_LESSONS = 2; // lessons with reviewed cards before a course review is suggested
// FSRS schedules each card when its recall falls to 90%, so a course kept up to date sits at a
// mean of ~0.93-0.97. Below 0.85 a good share of its cards are overdue: worth a mixed pass.
export const COURSE_FADING_R = 0.85;
const R_STEP = 0.05; // retrievabilities this close count as equally weak (then concept, leech decide)
const DAY = 864e5;

/** FSRS retrievability of a card now; a new card has nothing to recall yet (0). */
export function retrievability(card, now = new Date()) {
  const c = card || {};
  if (c.state === State.New || !c.last_review || !(Number(c.stability) > 0)) return 0;
  const days = Math.max(0, (new Date(now).getTime() - new Date(c.last_review).getTime()) / DAY);
  return forgettingCurve(days, Number(c.stability));
}

/** The course's lessons that exist, in course order: [{lessonId, title}]. */
export function courseLessons(data, course) {
  const out = [];
  const seen = new Set();
  const add = (id, title) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const l = data?.lessons?.[id];
    out.push({ lessonId: id, title: l?.title || l?.topic || title || '' });
  };
  for (const s of course?.sections || []) for (const l of s.lessons || []) add(l.lessonId, l.title);
  // lessons of this course that lost their link in the plan (e.g. recreated) still count
  for (const l of Object.values(data?.lessons || {})) if (l?.courseId === course?.id) add(l.id, l.title);
  return out;
}

const findCourse = (data, c) => (typeof c === 'string' ? (data?.courses || []).find((x) => x.id === c) : c) || null;

/** Per-lesson and course-wide memory: mean retrievability over cards reviewed at least once. */
export function courseMemory(data, courseOrId, now = new Date()) {
  const course = findCourse(data, courseOrId);
  const lessons = courseLessons(data, course);
  const ids = new Set(lessons.map((l) => l.lessonId));
  const t = new Date(now).getTime();
  const byLesson = new Map(lessons.map((l) => [l.lessonId, { ...l, cards: 0, reviewed: 0, due: 0, sum: 0 }]));
  let sum = 0;
  let reviewed = 0;
  let due = 0;
  for (const e of data?.deck?.items || []) {
    if (!ids.has(e.lessonId)) continue;
    const row = byLesson.get(e.lessonId);
    row.cards++;
    if (new Date(e.card?.due).getTime() <= t) { row.due++; due++; }
    if (e.card?.state === State.New || !e.card?.last_review) continue;
    const r = retrievability(e.card, now);
    row.reviewed++;
    row.sum += r;
    reviewed++;
    sum += r;
  }
  const rows = [...byLesson.values()].map(({ sum: s, ...l }) => ({ ...l, memory: l.reviewed ? s / l.reviewed : null }));
  return {
    courseId: course?.id || null,
    title: course?.title || '',
    lessons: rows,
    cards: rows.reduce((a, l) => a + l.cards, 0),
    reviewed,
    reviewedLessons: rows.filter((l) => l.reviewed).length,
    due,
    memory: reviewed ? sum / reviewed : null,
  };
}

/** Is this course worth a whole-course review now? (enough lessons reviewed, memory slipping) */
export function courseIsFading(mem) {
  return !!mem && mem.reviewedLessons >= COURSE_REVIEW_MIN_LESSONS && mem.memory != null && mem.memory < COURSE_FADING_R;
}

/** The course whose memory has dropped furthest, as {courseId, title, memory, due, lessons}, or null. */
export function courseReviewSuggestion(data, now = new Date()) {
  const fading = (data?.courses || []).map((c) => courseMemory(data, c, now)).filter(courseIsFading)
    .sort((a, b) => a.memory - b.memory);
  const m = fading[0];
  return m ? { courseId: m.courseId, title: m.title, memory: m.memory, due: m.due, lessons: m.reviewedLessons } : null;
}

/** Day seed: the same course gives the same session all day, a new mix tomorrow. */
export function sessionSeed(courseId, now = new Date()) {
  let h = 2166136261;
  for (const ch of `${courseId}|${dateKey(now)}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Priority of each card, best first: due cards, then the weakest memory (FSRS retrievability,
 * in steps of R_STEP), then cards on a shaky concept (mastery-core), then leeches
 * (outcomes-core), then a seeded coin flip so ties are stable but not always the same card.
 */
function rankCards(data, entries, lessons, now, rand) {
  const t = new Date(now).getTime();
  const shaky = new Set(data?.settings?.memoryEnabled === false ? [] : weakestConcepts(data?.mastery, now, 50).map(conceptKey));
  const leeches = new Set(lessons.flatMap((l) => lessonOutcome(data, l.lessonId, now).leeches.map((x) => x.entryId)));
  const jitter = new Map([...entries].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, rand()]));
  return entries.map((e) => {
    const r = retrievability(e.card, now);
    return {
      e,
      due: new Date(e.card?.due).getTime() <= t,
      r,
      rStep: Math.floor(r / R_STEP),
      shaky: !!(e.item?.concept && shaky.has(conceptKey(e.item.concept))),
      leech: leeches.has(e.id),
      jitter: jitter.get(e.id),
    };
  }).sort((a, b) => (b.due - a.due) || (a.rStep - b.rStep) || (b.shaky - a.shaky) || (b.leech - a.leech) || (a.jitter - b.jitter));
}

/**
 * Order ranked cards so consecutive ones come from different lessons whenever that is possible:
 * each step takes the best-ranked card from a lesson other than the one just shown, unless a
 * lesson holds more than half of what is left (it must go now, or two of its cards would touch).
 */
export function interleave(ranked, lessonOf = (x) => x.entry.lessonId) {
  const queues = new Map();
  ranked.forEach((x, i) => {
    const k = lessonOf(x);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push({ x, i });
  });
  const out = [];
  let prev;
  for (let left = ranked.length; left > 0; left--) {
    let pick = null;
    for (const [k, q] of queues) if (k !== prev && q.length * 2 > left && (!pick || q.length > pick.q.length)) pick = { k, q };
    if (!pick) for (const [k, q] of queues) if (k !== prev && q.length && (!pick || q[0].i < pick.q[0].i)) pick = { k, q };
    if (!pick) pick = { k: prev, q: queues.get(prev) }; // only the last lesson has cards left
    out.push(pick.q.shift().x);
    prev = pick.k;
  }
  return out;
}

/** Every card of the course in priority order, before the cap and interleaving (for tests and tools). */
export function rankCourseCards(data, courseOrId, { now = new Date(), seed } = {}) {
  const course = findCourse(data, courseOrId);
  if (!course) return [];
  const lessons = courseLessons(data, course);
  const ids = new Set(lessons.map((l) => l.lessonId));
  const entries = (data?.deck?.items || []).filter((e) => ids.has(e.lessonId));
  return rankCards(data, entries, lessons, now, rng(seed ?? sessionSeed(course.id, now))).map(({ e, ...why }) => ({ entry: e, ...why }));
}

/**
 * A whole-course review session: up to `size` cards from every lesson of the course, chosen by
 * priority (no lesson takes much more than its share while others have cards), then interleaved.
 * Deterministic for a given seed. Returns {course, entries (deck entries), lessons}.
 */
export function courseReviewSession(data, courseOrId, { now = new Date(), seed, size = COURSE_REVIEW_SIZE } = {}) {
  const course = findCourse(data, courseOrId);
  if (!course) return { course: null, entries: [], lessons: [] };
  const lessons = courseLessons(data, course);
  const ranked = rankCourseCards(data, course, { now, seed });
  const withCards = new Set(ranked.map((x) => x.entry.lessonId)).size;
  const share = Math.max(2, Math.ceil(size / Math.max(1, withCards)) + 1);
  const picked = [];
  const taken = new Set();
  const per = new Map();
  for (const x of ranked) { // first pass: priority order, each lesson capped at its share
    if (picked.length >= size) break;
    const n = per.get(x.entry.lessonId) || 0;
    if (n >= share) continue;
    per.set(x.entry.lessonId, n + 1);
    picked.push(x);
    taken.add(x.entry.id);
  }
  for (const x of ranked) { // second pass: fill what is left
    if (picked.length >= size) break;
    if (!taken.has(x.entry.id)) picked.push(x);
  }
  picked.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  return { course, entries: interleave(picked).map((x) => x.entry), lessons };
}

/**
 * End-of-session summary from review results ([{entry, correct}]): recall per lesson in course
 * order, and the weakest lesson (lowest share correct, then lowest memory) when one slipped.
 */
export function courseReviewSummary(data, courseOrId, results, now = new Date()) {
  const course = findCourse(data, courseOrId);
  const mem = courseMemory(data, course, now);
  const rows = mem.lessons.map((l) => {
    const rs = (results || []).filter((r) => r?.entry?.lessonId === l.lessonId);
    const correct = rs.filter((r) => r.correct).length;
    return { lessonId: l.lessonId, title: l.title, n: rs.length, correct, rate: rs.length ? correct / rs.length : null, memory: l.memory };
  }).filter((l) => l.n);
  const weakest = rows.filter((l) => l.rate < 1)
    .sort((a, b) => a.rate - b.rate || (a.memory ?? 1) - (b.memory ?? 1))[0] || null;
  const n = rows.reduce((a, l) => a + l.n, 0);
  const correct = rows.reduce((a, l) => a + l.correct, 0);
  return { lessons: rows, weakest, n, correct, rate: n ? correct / n : null };
}
