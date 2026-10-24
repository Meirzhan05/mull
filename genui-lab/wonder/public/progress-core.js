// Pure helpers for the Today and You screens (no DOM): the daily XP goal, the week strip, the
// activity heatmap, interest-based topic suggestions and the "Up next" pick. Everything reads
// the plain store state, so it is tested under node:test.

import { dateKey, deckStats, currentStreak } from './deck.js';
import { weakestConcepts } from './mastery-core.js';
import { nextPlanItem } from './plan-core.js'; // Phase 10
import { fadingLessons, RECALL_MIN } from './outcomes-core.js'; // Phase 9
import { courseReviewSuggestion } from './course-review-core.js';

export const DAILY_GOALS = Object.freeze([
  { xp: 10, label: 'Casual', hint: 'A few minutes a day' },
  { xp: 30, label: 'Regular', hint: 'About one lesson a day' },
  { xp: 60, label: 'Serious', hint: 'A lesson plus reviews' },
  { xp: 100, label: 'Intense', hint: 'Several lessons a day' },
]);
export const DEFAULT_GOAL = 30;

/** The level a new lesson starts at (settings.level), offered at onboarding and in You. */
export const LEVELS = Object.freeze([
  { id: 'beginner', label: 'Beginner', hint: 'Start from the ground up' },
  { id: 'intermediate', label: 'Intermediate', hint: 'I know the basics' },
  { id: 'advanced', label: 'Advanced', hint: 'Skip ahead to the depth' },
]);

/** Interests offered at onboarding, each with lesson topics to suggest. */
export const INTERESTS = Object.freeze({
  science: { label: 'Science', topics: ['Why the sky is blue', 'How vaccines train your immune system', 'What is entropy, really?', 'How photosynthesis powers life'] },
  space: { label: 'Space', topics: ['Black holes for beginners', 'How rockets reach orbit', 'Why planets are round', 'What is dark matter?'] },
  ai: { label: 'AI & computing', topics: ['How transformers predict the next word', 'How the internet routes a message', 'What a neural network learns', 'How public-key encryption works'] },
  math: { label: 'Math', topics: ['Bayes’ theorem with everyday examples', 'Why e shows up everywhere', 'Derivatives as rates of change', 'The birthday paradox'] },
  money: { label: 'Money', topics: ['Compound interest', 'How index funds work', 'What causes inflation', 'How credit scores are calculated'] },
  history: { label: 'History', topics: ['The French Revolution in 5 ideas', 'Why the Roman Empire fell', 'The printing press and the spread of ideas', 'The Silk Road'] },
  body: { label: 'Health & body', topics: ['How sleep consolidates memory', 'What your heart does in one beat', 'How muscles get stronger', 'How the gut microbiome works'] },
  languages: { label: 'Languages', topics: ['Spanish greetings and small talk', 'How languages evolve', 'Why English spelling is so strange', 'Japanese writing systems'] },
  psychology: { label: 'Mind', topics: ['How habits form', 'Cognitive biases that fool us', 'Why we procrastinate', 'How memory works'] },
  art: { label: 'Art & music', topics: ['Why some chords sound sad', 'The rule of thirds in photography', 'How perspective drawing works', 'What makes a melody catchy'] },
  economics: { label: 'Economics', topics: ['Supply and demand', 'Game theory and the prisoner’s dilemma', 'Why trade makes both sides richer', 'Opportunity cost'] },
  climate: { label: 'Climate', topics: ['How the greenhouse effect works', 'How solar panels make electricity', 'Ocean currents and climate', 'How batteries store energy'] },
});

const DEFAULT_TOPICS = ['How transformers predict the next word', 'Why the sky is blue', 'Compound interest', 'How vaccines train your immune system', 'Black holes for beginners', 'How habits form'];

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const weekdayOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay(); // 0 = Sunday

export function levelOf(settings) {
  return LEVELS.some((l) => l.id === settings?.level) ? settings.level : 'beginner';
}

export function goalOf(settings) {
  const g = Number(settings?.dailyGoal);
  return Number.isFinite(g) && g > 0 ? Math.round(g) : DEFAULT_GOAL;
}

/** Today's XP against the daily goal. */
export function dailyProgress(stats, settings, now = new Date(), timeZone) {
  const goal = goalOf(settings);
  const xp = Math.max(0, Number(stats?.days?.[dateKey(now, timeZone)]) || 0);
  return { xp, goal, pct: Math.min(1, xp / goal), met: xp >= goal };
}

/** The last 7 local days (oldest first): {key, label, xp, active, met, today}. */
export function weekStrip(stats, settings, now = new Date(), timeZone) {
  const goal = goalOf(settings);
  const today = dateKey(now, timeZone);
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const key = addDays(today, -i);
    const xp = Math.max(0, Number(stats?.days?.[key]) || 0);
    out.push({ key, label: 'SMTWTFS'[weekdayOf(key)], xp, active: xp > 0, met: xp >= goal, today: key === today });
  }
  return out;
}

/**
 * Activity heatmap: `weeks` columns of 7 days (Sunday first), ending with the current week.
 * Each cell: {key, xp, level 0-4, future}.
 */
export function activityGrid(stats, now = new Date(), { weeks = 15, timeZone } = {}) {
  const today = dateKey(now, timeZone);
  const start = addDays(today, -(weekdayOf(today) + (weeks - 1) * 7));
  const values = Object.values(stats?.days || {}).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
  const top = values.length ? values[Math.floor(values.length * 0.9)] || values[values.length - 1] : 1;
  const cols = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const key = addDays(start, w * 7 + d);
      const xp = Math.max(0, Number(stats?.days?.[key]) || 0);
      const level = xp <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((xp / Math.max(top, 1)) * 4)));
      col.push({ key, xp, level, future: key > today });
    }
    cols.push(col);
  }
  return cols;
}

/** Totals for the You screen. */
export function learnerTotals(data, now = new Date()) {
  const lessons = Object.values(data?.lessons || {});
  const deck = deckStats(data?.deck || { items: [] }, now);
  const activeDays = Object.values(data?.stats?.days || {}).filter((v) => Number(v) > 0).length;
  return {
    xp: data?.stats?.xp || 0,
    streak: currentStreak(data?.stats || {}, now),
    bestStreak: Math.max(data?.stats?.streak?.best || 0, currentStreak(data?.stats || {}, now)),
    lessonsFinished: lessons.filter((l) => l.finished).length,
    lessonsStarted: lessons.length,
    cards: deck.total,
    mastered: deck.review,
    due: deck.due,
    activeDays,
  };
}

/** Lesson topics to suggest: from the learner's interests, rotated daily, minus ones already taken. */
export function suggestedTopics(settings, lessons = {}, now = new Date(), count = 5) {
  const taken = new Set(Object.values(lessons || {}).map((l) => String(l.topic || '').toLowerCase()));
  const picked = (settings?.interests || []).filter((k) => INTERESTS[k]);
  // interleave the interests' topics so every interest shows up early
  const lists = picked.length ? picked.map((k) => INTERESTS[k].topics) : [DEFAULT_TOPICS];
  const pool = [];
  for (let i = 0; pool.length < 60 && i < 8; i++) for (const list of lists) if (list[i]) pool.push(list[i]);
  const fresh = [...new Set(pool)].filter((t) => !taken.has(t.toLowerCase()));
  const list = fresh.length >= count ? fresh : [...new Set([...fresh, ...DEFAULT_TOPICS.filter((t) => !taken.has(t.toLowerCase()))])];
  if (!list.length) return DEFAULT_TOPICS.slice(0, count);
  const day = Math.floor(new Date(now).getTime() / 86400000);
  const offset = day % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)].slice(0, count);
}

function courseNext(data, course, skipId = null) {
  let total = 0;
  let done = 0;
  let next = null;
  (course.sections || []).forEach((s, si) => (s.lessons || []).forEach((l, li) => {
    total++;
    const finished = !!(l.lessonId && data.lessons?.[l.lessonId]?.finished);
    if (finished) done++;
    else if (!next && !(skipId && l.lessonId === skipId)) next = { si, li, title: l.title, summary: l.summary || '', lessonId: l.lessonId && data.lessons?.[l.lessonId] ? l.lessonId : null };
  }));
  return { total, done, next };
}

/** Course progress {done, total} (finished lessons). */
/** The lessons opened most recently, newest first. */
export function recentLessons(data, count) {
  return Object.values(data.lessons).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, count);
}

/** A lesson's state for lists: [css class, label]. */
export const lessonState = (l) => (l.finished ? ['done', 'Finished'] : l.status === 'complete' ? ['ready', l.readPage > 1 ? `Page ${l.readPage}` : 'In progress'] : l.status === 'failed' ? ['warn', 'Failed'] : ['', l.status === 'new' ? 'Not started' : 'Unfinished']);

export function courseProgress(data, course) {
  const { done, total } = courseNext(data, course);
  return { done, total };
}

/**
 * What to do next, best first. Kinds:
 *   continue  an unfinished lesson (still being read, or interrupted)
 *   review    due practice cards
 *   strengthen  shaky or fading concepts in the learner model (a Teacher quiz on them)
 *   refresh   a finished lesson whose cards are not sticking (Phase 9: delayed recall)
 *   course-review  a course whose lessons are fading together: one interleaved review of all of them
 *   plan      the saved study plan's next item by calendar day: overdue, today's, or ahead
 *   course    the next lesson of a course in progress
 *   start     nothing in flight: start a first / new lesson
 */
export function upNext(data, now = new Date()) {
  const out = [];
  const lessons = Object.values(data?.lessons || {}).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const unfinished = lessons.find((l) => !l.finished && l.status !== 'failed' && String(l.markdown || '').trim());
  if (unfinished) {
    out.push({ kind: 'continue', lessonId: unfinished.id, title: unfinished.title || unfinished.topic, interrupted: unfinished.status !== 'complete', page: unfinished.readPage || 0, courseId: unfinished.courseId || null });
  }
  const deck = deckStats(data?.deck || { items: [] }, now);
  if (deck.due > 0) out.push({ kind: 'review', due: deck.due });
  // Phase 6: shaky / fading concepts from the learner model
  const weak = data?.settings?.memoryEnabled === false ? [] : weakestConcepts(data?.mastery, now, 3);
  if (weak.length) out.push({ kind: 'strengthen', concepts: weak });
  // Phase 9: the worst-fading lesson, measured from recall days later (or FSRS's forecast)
  const fading = fadingLessons(data, now, 1)[0];
  if (fading && fading.reviewed) {
    out.push({ kind: 'refresh', lessonId: fading.lessonId, title: fading.title, slipping: fading.leeches.length,
      ...(fading.recall.n >= RECALL_MIN ? { recall: Math.round(fading.recall.rate * 100), reviews: fading.recall.n } : {}),
      ...(fading.memoryToday != null ? { memoryToday: Math.round(fading.memoryToday * 100) } : {}) });
  }
  const cr = courseReviewSuggestion(data, now);
  if (cr) out.push({ kind: 'course-review', courseId: cr.courseId, title: cr.title, memory: Math.round(cr.memory * 100), lessons: cr.lessons, due: cr.due });
  const plan = (data?.plans || [])[0];
  if (plan) {
    // Phase 10: by calendar day: overdue items first, then today's, then (ahead) the next day's
    const n = nextPlanItem(plan, now);
    if (n) out.push({ kind: 'plan', planId: plan.id, dayIndex: n.dayIndex, itemIndex: n.itemIndex, day: plan.days[n.dayIndex].day || n.dayIndex + 1, date: n.date, when: n.when, title: n.item.title, itemKind: n.item.kind || 'lesson', goal: plan.goal });
  }
  for (const course of data?.courses || []) {
    const c = courseNext(data, course, unfinished?.id);
    if (c.next) {
      out.push({ kind: 'course', courseId: course.id, courseTitle: course.title, title: c.next.title, summary: c.next.summary, si: c.next.si, li: c.next.li, done: c.done, total: c.total });
      break;
    }
  }
  if (!out.length) out.push({ kind: 'start', first: !lessons.length });
  return out;
}

/** "Good morning" etc. by local hour. */
export function greeting(now = new Date()) {
  const h = new Date(now).getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Case-insensitive fuzzy-ish match score for the command palette (0 = no match). */
export function matchScore(text, query) {
  const t = String(text || '').toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 4;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  // all query words present somewhere
  const words = q.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every((w) => t.includes(w)) ? 1 : 0;
}

/** The interest a suggested topic came from (its label), or ''. */
export function topicInterest(topic) {
  for (const v of Object.values(INTERESTS)) if (v.topics.includes(topic)) return v.label;
  return '';
}

/** Upper-case Roman numerals for small counts (page and section numbering). */
export function roman(n) {
  let x = Math.max(0, Math.floor(Number(n) || 0));
  if (!x) return '';
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, r] of map) while (x >= v) { out += r; x -= v; }
  return out;
}

const INLINE_COMPONENTS = new Set(['Cite', 'KeyTerm', 'Followups', 'Sources']);

/**
 * Minutes to read a lesson's markdown: prose at ~220 words a minute (component tags, their JSON
 * props, math and code are not words), plus about half a minute per interactive widget.
 */
export function readingMinutes(markdown, wpm = 220) {
  const widgets = [...String(markdown || '').matchAll(/<([A-Z][\w]*)\b/g)].filter((m) => !INLINE_COMPONENTS.has(m[1])).length;
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<([A-Z][\w]*)\b[\s\S]*?(?:\/>|<\/\1>)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, ' ')
    .replace(/[#*_>`[\]()|-]/g, ' ');
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const minutes = words / wpm + widgets * 0.5;
  return minutes ? Math.max(1, Math.round(minutes)) : 0;
}
