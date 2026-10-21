// Practice deck scheduled with FSRS v5 (wondering-genui/src/fsrs.js, a port of the ts-fsrs
// build Wondering ships, findings §5), plus XP and streak bookkeeping (findings §7).
// Pure functions over plain JSON objects so the state can live in localStorage and be tested
// under node:test.

import { fsrs, createEmptyCard, Rating, State, STATE_NAMES } from '../../wondering-genui/src/fsrs.js';

export { Rating, State };

const scheduler = fsrs(); // shipped defaults: retention .9, short-term steps on, no fuzz
const MAX_LOGS = 2000;

export const XP = Object.freeze({ lessonComplete: 50, quizCorrect: 10, reviewCorrect: 5, reviewAttempt: 1, cardsCollected: 2 });

export function emptyDeck() {
  return { items: [], logs: [] };
}

export function serializeCard(c) {
  return { ...c, due: new Date(c.due).toISOString(), last_review: c.last_review ? new Date(c.last_review).toISOString() : null };
}

export function deserializeCard(c) {
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

/** Add practice items (deduped by item.id). New cards are due immediately. */
export function addItems(deck, items, { lessonId = null, lessonTitle = '', now = new Date() } = {}) {
  const have = new Set(deck.items.map((e) => e.item.id));
  const added = [];
  for (const item of items) {
    if (!item?.id || have.has(item.id)) continue;
    have.add(item.id);
    added.push({ id: item.id, lessonId, lessonTitle, item, card: serializeCard(createEmptyCard(now)), addedAt: new Date(now).toISOString() });
  }
  return { deck: { ...deck, items: [...deck.items, ...added] }, added: added.length };
}

export function dueEntries(deck, now = new Date(), limit = Infinity) {
  const t = new Date(now).getTime();
  return deck.items
    .filter((e) => new Date(e.card.due).getTime() <= t)
    .sort((a, b) => new Date(a.card.due) - new Date(b.card.due) || a.addedAt.localeCompare(b.addedAt))
    .slice(0, limit);
}

/** Apply a review. rating: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export function reviewEntry(deck, entryId, rating, now = new Date()) {
  const idx = deck.items.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error(`Unknown deck entry ${entryId}`);
  if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(rating)) throw new Error(`Invalid rating ${rating}`);
  const entry = deck.items[idx];
  const { card, log } = scheduler.next(deserializeCard(entry.card), new Date(now), rating);
  const next = { ...entry, card: serializeCard(card) };
  const items = deck.items.slice();
  items[idx] = next;
  const logEntry = { entryId, rating, state: log.state, stability: log.stability, difficulty: log.difficulty, scheduled_days: log.scheduled_days, elapsed_days: log.elapsed_days, review: new Date(now).toISOString(), due: next.card.due };
  const logs = [...deck.logs, logEntry].slice(-MAX_LOGS);
  return { deck: { ...deck, items, logs }, entry: next, log: logEntry };
}

/** Due date for each possible rating, for "next review" hints on self-graded cards. */
export function previewDue(entry, now = new Date()) {
  const outcomes = scheduler.repeat(deserializeCard(entry.card), new Date(now));
  const out = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) out[r] = new Date(outcomes[r].card.due).toISOString();
  return out;
}

export function deckStats(deck, now = new Date()) {
  const t = new Date(now).getTime();
  const out = { total: deck.items.length, due: 0, new: 0, learning: 0, review: 0, nextDue: null };
  for (const e of deck.items) {
    const due = new Date(e.card.due).getTime();
    if (due <= t) out.due++;
    else if (out.nextDue === null || due < out.nextDue) out.nextDue = due;
    if (e.card.state === State.New) out.new++;
    else if (e.card.state === State.Review) out.review++;
    else out.learning++;
  }
  if (out.nextDue !== null) out.nextDue = new Date(out.nextDue).toISOString();
  return out;
}

export function stateName(card) {
  return STATE_NAMES[card.state] ?? 'New';
}

/** "in 10 min", "tomorrow", "in 4 days" */
export function formatDue(due, now = new Date()) {
  const ms = new Date(due).getTime() - new Date(now).getTime();
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `in ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'tomorrow';
  if (days < 45) return `in ${days} days`;
  const months = Math.round(days / 30);
  return `in ${months} months`;
}

// ---------------------------------------------------------------- XP + streak

export function emptyStats() {
  return { xp: 0, streak: { count: 0, lastDate: null, best: 0 }, days: {} };
}

/** Local calendar date (en-CA gives YYYY-MM-DD), as Wondering stores activity dates. */
export function dateKey(now = new Date(), timeZone) {
  return new Date(now).toLocaleDateString('en-CA', timeZone ? { timeZone } : undefined);
}

function dayBefore(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.toISOString().slice(0, 10);
}

/** Award XP and count today toward the streak. */
export function awardXp(stats, amount, now = new Date(), timeZone) {
  const today = dateKey(now, timeZone);
  const s = { ...stats, streak: { ...stats.streak }, days: { ...stats.days } };
  s.xp += Math.max(0, Math.round(amount));
  s.days[today] = (s.days[today] || 0) + Math.max(0, Math.round(amount));
  if (s.streak.lastDate !== today) {
    s.streak.count = s.streak.lastDate === dayBefore(today) ? s.streak.count + 1 : 1;
    s.streak.lastDate = today;
    s.streak.best = Math.max(s.streak.best || 0, s.streak.count);
  }
  return s;
}

/** Streak to display: it lapses if neither today nor yesterday had activity. */
export function currentStreak(stats, now = new Date(), timeZone) {
  const today = dateKey(now, timeZone);
  const last = stats.streak?.lastDate;
  if (!last) return 0;
  return last === today || last === dayBefore(today) ? stats.streak.count : 0;
}
