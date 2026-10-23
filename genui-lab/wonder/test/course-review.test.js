import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDeck, addItems, reviewEntry, Rating } from '../public/deck.js';
import { normalizePracticeItem } from '../public/practice-core.js';
import { emptyState } from '../public/store.js';
import { recordEvidence } from '../public/mastery-core.js';
import {
  courseReviewSession, rankCourseCards, courseReviewSummary, courseMemory, courseReviewSuggestion, courseIsFading, courseLessons,
  interleave, retrievability, sessionSeed, COURSE_REVIEW_SIZE, COURSE_FADING_R, COURSE_REVIEW_MIN_LESSONS,
} from '../public/course-review-core.js';
import { dailyBrief } from '../public/brief-core.js';
import { upNext } from '../public/progress-core.js';
import { progressSnapshot } from '../public/teacher-core.js';
import { sanitizeProgress } from '../server/teacher.js';

const T0 = new Date('2026-10-01T09:00:00Z');
const days = (n) => new Date(T0.getTime() + n * 864e5);
const item = (lessonId, i, extra = {}) => normalizePracticeItem({ id: `${lessonId}-c${i}`, type: 'flashcard', front: `${lessonId} front ${i}`, back: 'b', ...extra });

/** A course of `lessons` lessons ({id, cards, reviewed}); reviewed cards get Good on day 0 and again 10 min later. */
function course(spec, { id = 'c1', title = 'Statistics' } = {}) {
  const data = { ...emptyState(), deck: emptyDeck() };
  data.courses.push({ id, title, level: 'beginner', sections: [{ title: 'One', lessons: spec.map((l) => ({ title: `Lesson ${l.id}`, lessonId: l.id })) }] });
  for (const l of spec) {
    data.lessons[l.id] = { id: l.id, title: `Lesson ${l.id}`, topic: l.id, courseId: id, finished: true, status: 'complete', markdown: '', updatedAt: T0.toISOString() };
    const items = Array.from({ length: l.cards }, (_, i) => item(l.id, i, l.concept ? { concept: l.concept(i) } : {}));
    data.deck = addItems(data.deck, items, { lessonId: l.id, lessonTitle: `Lesson ${l.id}`, now: T0 }).deck;
    for (const it of items.slice(0, l.reviewed ?? l.cards)) {
      data.deck = reviewEntry(data.deck, it.id, Rating.Good, T0).deck;
      data.deck = reviewEntry(data.deck, it.id, Rating.Good, new Date(T0.getTime() + 10 * 60000)).deck;
    }
  }
  return data;
}

const adjacentRepeats = (entries) => entries.slice(1).filter((e, i) => e.lessonId === entries[i].lessonId).length;

test('course review: consecutive cards come from different lessons', () => {
  const d = course([{ id: 'a', cards: 5 }, { id: 'b', cards: 5 }, { id: 'c', cards: 5 }]);
  const s = courseReviewSession(d, 'c1', { now: days(30), seed: 7 });
  assert.equal(s.entries.length, 15);
  assert.equal(adjacentRepeats(s.entries), 0);
  assert.deepEqual(new Set(s.entries.map((e) => e.lessonId)), new Set(['a', 'b', 'c']));
  assert.equal(new Set(s.entries.map((e) => e.id)).size, 15, 'no card twice');
});

test('course review: interleave is optimal for any lesson mix (repeats only when one lesson dominates)', () => {
  let x = 12345;
  const rand = () => ((x = (x * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let trial = 0; trial < 300; trial++) {
    const counts = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => Math.floor(rand() * 7));
    const ranked = counts.flatMap((n, k) => Array.from({ length: n }, (_, i) => ({ k, i, r: rand() }))).sort((a, b) => a.r - b.r);
    const out = interleave(ranked, (c) => c.k);
    assert.equal(out.length, ranked.length);
    const n = ranked.length;
    const m = Math.max(0, ...counts);
    const repeats = out.slice(1).filter((c, i) => c.k === out[i].k).length;
    assert.equal(repeats, Math.max(0, 2 * m - n - 1), `counts ${counts}`);
  }
});

test('course review: the session follows priority: due, then low retrievability, then shaky concepts, then leeches', () => {
  const d = course([{ id: 'a', cards: 4 }, { id: 'b', cards: 4 }]);
  const now = days(3);
  // a-c0: due (reviewed long ago and rated Again, so its due date is past); the rest reviewed Good recently
  const at = (id, r, t) => { d.deck = reviewEntry(d.deck, id, r, t).deck; };
  for (const e of d.deck.items) at(e.id, Rating.Good, days(2));
  at('a-c0', Rating.Again, days(2));
  // b-c3: a leech (two Again on delayed reviews), then relearned to a long interval so it is not due
  // b-c2 and a-c2: same memory as the rest; a-c2 is on a shaky concept
  d.deck.items.find((e) => e.id === 'a-c2').item.concept = 'Standard error';
  d.mastery = recordEvidence({}, [0, 0, 0].map(() => ({ concept: 'Standard error', correct: false, source: 'quiz' })), now);
  d.deck.logs.push({ entryId: 'b-c3', rating: 1, elapsed_days: 2 }, { entryId: 'b-c3', rating: 1, elapsed_days: 3 });
  const ranked = rankCourseCards(d, 'c1', { now, seed: 1 });
  const order = ranked.map((x) => x.entry.id);
  assert.deepEqual(order.slice(0, 3), ['a-c0', 'a-c2', 'b-c3'], 'due, then shaky concept, then leech (equal memory otherwise)');
  assert.deepEqual(ranked.slice(0, 3).map((x) => [x.due, x.shaky, x.leech]), [[true, false, false], [false, true, false], [false, false, true]]);
  // the session keeps that order within each lesson while alternating lessons
  const s = courseReviewSession(d, 'c1', { now, seed: 1, size: 8 });
  const ids = s.entries.map((e) => e.id);
  assert.equal(ids[0], 'a-c0', 'the due card leads');
  assert.equal(adjacentRepeats(s.entries), 0);
  const restA = ['a-c1', 'a-c3'].map((id) => ids.indexOf(id));
  assert.ok(restA.every((i) => i > ids.indexOf('a-c2')), 'the shaky card ranks above its lesson-mates of equal memory');
  const restB = ['b-c0', 'b-c1', 'b-c2'].map((id) => ids.indexOf(id));
  assert.ok(restB.every((i) => i > ids.indexOf('b-c3')), 'the leech ranks above its lesson-mates of equal memory');

  // low retrievability beats a shaky concept: make b-c1 old and weak
  const old = course([{ id: 'a', cards: 2, concept: () => 'Standard error' }, { id: 'b', cards: 2 }]);
  old.mastery = d.mastery;
  for (const e of old.deck.items) if (e.lessonId === 'a') old.deck = reviewEntry(old.deck, e.id, Rating.Good, days(20)).deck;
  const t = days(21);
  const rB = retrievability(old.deck.items.find((e) => e.id === 'b-c0').card, t);
  const rA = retrievability(old.deck.items.find((e) => e.id === 'a-c0').card, t);
  assert.ok(rB < rA - 0.05, 'b is weaker');
  const r2 = rankCourseCards(old, 'c1', { now: t, seed: 3 });
  assert.deepEqual(r2.map((x) => x.entry.lessonId), ['b', 'b', 'a', 'a'], 'weaker memory first even though a is on a shaky concept');
  assert.equal(courseReviewSession(old, 'c1', { now: t, seed: 3, size: 4 }).entries[0].lessonId, 'b');
  // the cap keeps the highest-priority cards
  const capped = courseReviewSession(d, 'c1', { now, seed: 1, size: 3 }).entries.map((e) => e.id).sort();
  assert.deepEqual(capped, ['a-c0', 'a-c2', 'b-c3']);
});

test('course review: capped, balanced across lessons, deterministic for a seed', () => {
  const d = course([{ id: 'a', cards: 30 }, { id: 'b', cards: 3 }, { id: 'c', cards: 3 }]);
  const now = days(40);
  const s = courseReviewSession(d, 'c1', { now, seed: 42 });
  assert.equal(s.entries.length, COURSE_REVIEW_SIZE);
  assert.ok(COURSE_REVIEW_SIZE >= 15 && COURSE_REVIEW_SIZE <= 20);
  const by = (l) => s.entries.filter((e) => e.lessonId === l).length;
  assert.equal(by('b'), 3, 'small lessons are all in');
  assert.equal(by('c'), 3);
  assert.deepEqual(courseReviewSession(d, 'c1', { now, seed: 42 }).entries.map((e) => e.id), s.entries.map((e) => e.id), 'same seed, same session');
  const other = [1, 2, 3, 4, 5].map((seed) => courseReviewSession(d, 'c1', { now, seed }).entries.map((e) => e.id).join());
  assert.ok(other.some((o) => o !== s.entries.map((e) => e.id).join()), 'another seed breaks ties differently');
  assert.equal(courseReviewSession(d, 'c1', { now, size: 5 }).entries.length, 5);
  assert.equal(sessionSeed('c1', now), sessionSeed('c1', new Date(now.getTime() + 3600e3)), 'same day, same seed');
  assert.notEqual(sessionSeed('c1', now), sessionSeed('c1', days(41)));
  assert.equal(courseReviewSession(d, 'nope').entries.length, 0);
});

test('course review: only this course\'s cards, including a lesson that lost its plan link', () => {
  const d = course([{ id: 'a', cards: 2 }, { id: 'b', cards: 2 }]);
  d.deck = addItems(d.deck, [item('x', 0)], { lessonId: 'x', now: T0 }).deck; // another course / standalone lesson
  d.lessons.z = { id: 'z', title: 'Lesson z', courseId: 'c1', finished: true };
  d.deck = addItems(d.deck, [item('z', 0)], { lessonId: 'z', now: T0 }).deck;
  assert.deepEqual(courseLessons(d, d.courses[0]).map((l) => l.lessonId), ['a', 'b', 'z']);
  const ids = courseReviewSession(d, 'c1', { now: days(5) }).entries.map((e) => e.lessonId);
  assert.ok(!ids.includes('x'));
  assert.ok(ids.includes('z'));
});

test('course review: brief and Up next suggest it once 2+ lessons are reviewed and mean memory drops below the threshold', () => {
  assert.ok(COURSE_FADING_R > 0.7 && COURSE_FADING_R < 0.9, 'between the lesson "fading" line (0.7) and FSRS\'s 0.9 target');
  assert.equal(COURSE_REVIEW_MIN_LESSONS, 2);
  const d = course([{ id: 'a', cards: 3 }, { id: 'b', cards: 3 }, { id: 'c', cards: 3, reviewed: 0 }]);
  // find the first day the course's mean memory is below the threshold, and the day before
  let day = 1;
  while (courseMemory(d, 'c1', days(day)).memory >= COURSE_FADING_R) day++;
  const before = days(day - 1);
  const after = days(day);
  assert.ok(courseMemory(d, 'c1', before).memory >= COURSE_FADING_R);
  assert.equal(courseReviewSuggestion(d, before), null, 'memory still above the threshold');
  const sug = courseReviewSuggestion(d, after);
  assert.equal(sug.courseId, 'c1');
  assert.equal(sug.lessons, 2, 'lesson c has no reviewed cards');
  assert.ok(sug.memory < COURSE_FADING_R);

  const cr = dailyBrief(d, after).items.find((i) => i.kind === 'course-review');
  assert.ok(cr, 'brief has a course-review item');
  assert.deepEqual(cr.action, { type: 'course-review', courseId: 'c1' });
  assert.match(cr.title, /Statistics/);
  const nx = upNext(d, after).find((n) => n.kind === 'course-review');
  assert.equal(nx.courseId, 'c1');
  assert.ok(nx.memory < COURSE_FADING_R * 100);
  assert.ok(!upNext(d, before).some((n) => n.kind === 'course-review'));

  // one lesson reviewed is not a course review, however faded
  const one = course([{ id: 'a', cards: 3 }, { id: 'b', cards: 3, reviewed: 0 }]);
  const m = courseMemory(one, 'c1', days(200));
  assert.ok(m.memory < COURSE_FADING_R);
  assert.equal(courseIsFading(m), false);
  assert.equal(courseReviewSuggestion(one, days(200)), null);
});

test('course review: the Teacher snapshot carries due cards, memory and the suggestion (bounded on the server)', () => {
  const d = course([{ id: 'a', cards: 3 }, { id: 'b', cards: 3 }]);
  const snap = progressSnapshot(d, days(60));
  const c = snap.courses[0];
  assert.equal(c.title, 'Statistics');
  assert.equal(c.cardsDue, 6);
  assert.ok(c.memory >= 0 && c.memory < COURSE_FADING_R * 100);
  assert.equal(c.reviewSuggested, true);
  const clean = sanitizeProgress({ courses: [{ ...c, memory: 400, reviewSuggested: 'yes' }] }).courses[0];
  assert.equal(clean.memory, 100);
  assert.equal(clean.reviewSuggested, undefined);
  assert.equal(sanitizeProgress({ courses: [c] }).courses[0].reviewSuggested, true);
  assert.equal(progressSnapshot(d, days(0)).courses[0].reviewSuggested, undefined);
});

test('course review: ratings write ordinary FSRS logs; the summary gives recall per lesson and the weakest', () => {
  let d = course([{ id: 'a', cards: 3 }, { id: 'b', cards: 3 }, { id: 'c', cards: 2 }]);
  const now = days(30);
  const s = courseReviewSession(d, 'c1', { now, seed: 5 });
  const logsBefore = d.deck.logs.length;
  const results = s.entries.map((e) => {
    const correct = !(e.lessonId === 'b' && e.id !== 'b-c0');
    d = { ...d, deck: reviewEntry(d.deck, e.id, correct ? Rating.Good : Rating.Again, now).deck };
    return { entry: e, correct };
  });
  assert.equal(d.deck.logs.length, logsBefore + s.entries.length);
  assert.ok(d.deck.logs.slice(-s.entries.length).every((l) => l.elapsed_days >= 1), 'delayed reviews: Phase 9 recall counts them');
  const sum = courseReviewSummary(d, 'c1', results, now);
  assert.deepEqual(sum.lessons.map((l) => [l.lessonId, l.correct, l.n]), [['a', 3, 3], ['b', 1, 3], ['c', 2, 2]]);
  assert.equal(sum.weakest.lessonId, 'b');
  assert.equal(sum.n, 8);
  assert.equal(courseReviewSummary(d, 'c1', results.filter((r) => r.correct), now).weakest, null, 'nothing slipped');
});
