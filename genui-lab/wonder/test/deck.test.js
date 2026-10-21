import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDeck, addItems, dueEntries, reviewEntry, deckStats, previewDue, awardXp, currentStreak, emptyStats, Rating, State, formatDue } from '../public/deck.js';
import { normalizePracticeItem, gradePracticeItem, RATING } from '../public/practice-core.js';
import { createStore } from '../public/store.js';
import { extractPracticeDeterministic } from '../server/practice.js';
import { demo } from './helpers.js';

const T0 = new Date('2026-10-21T09:00:00Z');
const min = (d, n) => new Date(d.getTime() + n * 60000);
const days = (d, n) => new Date(d.getTime() + n * 864e5);

test('practice-core: normalization and grading for every item type', () => {
  const mcq = normalizePracticeItem({ type: 'mcq', prompt: 'p', choices: ['a', 'b', 'c'], correct_index: 2 });
  assert.equal(gradePracticeItem(mcq, 'c').correct, true);
  assert.equal(gradePracticeItem(mcq, 'a').rating, RATING.again);
  const cloze = normalizePracticeItem({ type: 'cloze', prompt: 'Light is scattered by Rayleigh scattering.', answer: 'Rayleigh' });
  assert.equal(cloze.prompt, 'Light is scattered by ____ scattering.', 'answer becomes the blank');
  assert.equal(gradePracticeItem(cloze, ' rayleigh ').correct, true);
  const typo = gradePracticeItem(cloze, 'Rayliegh');
  assert.equal(typo.correct, false, 'two edits is wrong');
  const oneOff = gradePracticeItem(cloze, 'Raleigh');
  assert.equal(oneOff.correct, true);
  assert.equal(oneOff.rating, RATING.hard, 'a typo is rated Hard');
  const tf = normalizePracticeItem({ type: 'binary_choice', statement: 's', is_true: false });
  assert.equal(gradePracticeItem(tf, false).correct, true);
  const fc = normalizePracticeItem({ type: 'flashcard', front: 'f', back: 'b' });
  assert.equal(gradePracticeItem(fc, 'easy').rating, RATING.easy);
  assert.equal(normalizePracticeItem({ type: 'mcq', prompt: 'p', choices: ['a'], correct_index: 0 }), null);
  assert.equal(normalizePracticeItem({ type: 'cloze', prompt: 'no blank', answer: 'zzz' }), null);
  assert.equal(RATING.good, Rating.Good, 'practice-core ratings match fsrs.js');
});

test('FSRS deck: new items are due now; Good walks the learning steps then graduates', () => {
  const { items } = extractPracticeDeterministic(demo('transformers.md'));
  let { deck, added } = addItems(emptyDeck(), items, { lessonId: 'l1', lessonTitle: 'Transformers', now: T0 });
  assert.equal(added, items.length);
  assert.equal(addItems(deck, items, { now: T0 }).added, 0, 'dedupe by item id');
  assert.equal(dueEntries(deck, T0).length, items.length);
  assert.equal(deckStats(deck, T0).new, items.length);

  const id = deck.items[0].id;
  let r = reviewEntry(deck, id, Rating.Good, T0);
  deck = r.deck;
  assert.equal(r.entry.card.state, State.Learning);
  assert.equal(new Date(r.entry.card.due).getTime(), min(T0, 10).getTime(), 'BasicScheduler: Good on a new card -> 10 minutes');
  assert.equal(dueEntries(deck, T0).some((e) => e.id === id), false);
  assert.equal(dueEntries(deck, min(T0, 10)).some((e) => e.id === id), true);

  r = reviewEntry(deck, id, Rating.Good, min(T0, 10));
  deck = r.deck;
  assert.equal(r.entry.card.state, State.Review, 'graduates to Review');
  const firstInterval = r.entry.card.scheduled_days;
  assert.ok(firstInterval >= 1);
  const later = days(min(T0, 10), firstInterval);
  r = reviewEntry(deck, id, Rating.Good, later);
  deck = r.deck;
  assert.ok(r.entry.card.scheduled_days > firstInterval, 'intervals grow with successful reviews');
  assert.equal(deck.logs.length, 3);
  assert.deepEqual(deck.logs.map((l) => l.rating), [3, 3, 3]);

  r = reviewEntry(deck, id, Rating.Again, days(later, r.entry.card.scheduled_days));
  assert.equal(r.entry.card.state, State.Relearning);
  assert.equal(r.entry.card.lapses, 1);

  const p = previewDue(deck.items[1], T0);
  assert.ok(new Date(p[Rating.Again]) < new Date(p[Rating.Easy]));
  assert.throws(() => reviewEntry(deck, 'missing', Rating.Good, T0));
  assert.throws(() => reviewEntry(deck, id, 0, T0));
});

test('XP and streaks: same day counts once, consecutive days extend, gaps reset', () => {
  let s = emptyStats();
  s = awardXp(s, 50, new Date('2026-10-21T10:00:00Z'), 'UTC');
  s = awardXp(s, 10, new Date('2026-10-21T18:00:00Z'), 'UTC');
  assert.equal(s.xp, 60);
  assert.equal(s.streak.count, 1);
  s = awardXp(s, 5, new Date('2026-10-22T08:00:00Z'), 'UTC');
  assert.equal(s.streak.count, 2);
  assert.equal(currentStreak(s, new Date('2026-10-23T12:00:00Z'), 'UTC'), 2, 'still alive the next day');
  assert.equal(currentStreak(s, new Date('2026-10-25T12:00:00Z'), 'UTC'), 0, 'lapsed after a gap');
  s = awardXp(s, 5, new Date('2026-10-25T08:00:00Z'), 'UTC');
  assert.equal(s.streak.count, 1);
  assert.equal(s.streak.best, 2);
  assert.equal(s.days['2026-10-21'], 60);
});

test('store persists through a storage shim and survives corrupted data', () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  const a = createStore({ storage });
  a.update((d) => { d.stats.xp = 42; d.lessons.x = { id: 'x', markdown: '# Hi', updatedAt: 'z' }; return d; });
  a.flush();
  const b = createStore({ storage });
  assert.equal(b.data.stats.xp, 42);
  assert.equal(b.data.lessons.x.markdown, '# Hi');
  m.set('wonder.v1', '{not json');
  assert.equal(createStore({ storage }).data.stats.xp, 0);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
  const c = createStore({ storage: throwing });
  assert.doesNotThrow(() => { c.update((d) => d); c.flush(); });
});

test('formatDue', () => {
  assert.equal(formatDue(min(T0, 10), T0), 'in 10 min');
  assert.equal(formatDue(days(T0, 1), T0), 'tomorrow');
  assert.equal(formatDue(days(T0, 4), T0), 'in 4 days');
  assert.equal(formatDue(T0, T0), 'now');
});
