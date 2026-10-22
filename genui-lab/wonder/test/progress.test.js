import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyProgress, weekStrip, activityGrid, learnerTotals, suggestedTopics, upNext, courseProgress, matchScore, goalOf, INTERESTS, DEFAULT_GOAL } from '../public/progress-core.js';
import { emptyStats, awardXp, emptyDeck, addItems } from '../public/deck.js';
import { emptyState } from '../public/store.js';

const TZ = 'UTC';
const T0 = new Date('2026-10-21T09:00:00Z'); // a Wednesday

test('daily goal: today XP against the goal, default goal when unset', () => {
  let stats = emptyStats();
  stats = awardXp(stats, 20, T0, TZ);
  assert.equal(goalOf({}), DEFAULT_GOAL);
  const p = dailyProgress(stats, { dailyGoal: 10 }, T0, TZ);
  assert.deepEqual({ xp: p.xp, goal: p.goal, met: p.met, pct: p.pct }, { xp: 20, goal: 10, met: true, pct: 1 });
  const q = dailyProgress(stats, {}, T0, TZ);
  assert.equal(q.met, false);
  assert.ok(Math.abs(q.pct - 20 / 30) < 1e-9);
  assert.equal(dailyProgress(stats, {}, new Date('2026-10-22T09:00:00Z'), TZ).xp, 0, 'a new day starts at 0');
});

test('week strip: 7 days oldest first, ending today, with activity and goal flags', () => {
  let stats = emptyStats();
  stats = awardXp(stats, 40, new Date('2026-10-19T09:00:00Z'), TZ);
  stats = awardXp(stats, 5, T0, TZ);
  const w = weekStrip(stats, { dailyGoal: 30 }, T0, TZ);
  assert.equal(w.length, 7);
  assert.equal(w[6].key, '2026-10-21');
  assert.equal(w[6].today, true);
  assert.equal(w[6].label, 'W');
  assert.equal(w[0].key, '2026-10-15');
  const mon = w.find((d) => d.key === '2026-10-19');
  assert.deepEqual([mon.active, mon.met], [true, true]);
  assert.deepEqual([w[6].active, w[6].met], [true, false]);
});

test('activity grid: whole weeks, Sunday first, future days flagged, levels scale', () => {
  let stats = emptyStats();
  stats = awardXp(stats, 100, T0, TZ);
  stats = awardXp(stats, 10, new Date('2026-10-10T09:00:00Z'), TZ);
  const g = activityGrid(stats, T0, { weeks: 4, timeZone: TZ });
  assert.equal(g.length, 4);
  assert.ok(g.every((c) => c.length === 7));
  assert.equal(g[3][0].key, '2026-10-18', 'last column starts on the Sunday of this week');
  const today = g[3][3];
  assert.equal(today.key, '2026-10-21');
  assert.equal(today.level, 4);
  assert.equal(g[3][4].future, true);
  const small = g.flat().find((c) => c.key === '2026-10-10');
  assert.ok(small.level >= 1 && small.level < 4);
});

test('suggested topics: from interests, interleaved, skipping topics already taken', () => {
  const s = suggestedTopics({ interests: ['space', 'money'] }, {}, T0, 4);
  assert.equal(s.length, 4);
  assert.ok(s.every((t) => INTERESTS.space.topics.includes(t) || INTERESTS.money.topics.includes(t)));
  assert.ok(s.some((t) => INTERESTS.space.topics.includes(t)) && s.some((t) => INTERESTS.money.topics.includes(t)));
  const taken = { a: { topic: 'Black holes for beginners' } };
  assert.ok(!suggestedTopics({ interests: ['space'] }, taken, T0, 3).includes('Black holes for beginners'));
  assert.equal(suggestedTopics({}, {}, T0, 3).length, 3, 'defaults without interests');
});

test('up next: continue an unfinished lesson, then reviews, plan items and course lessons', () => {
  const d = emptyState();
  assert.deepEqual(upNext(d, T0), [{ kind: 'start', first: true }]);
  d.lessons.l1 = { id: 'l1', title: 'Light', status: 'complete', markdown: '# Light\n\n## One', finished: false, updatedAt: '2026-10-21T08:00:00Z', readPage: 1 };
  d.lessons.l0 = { id: 'l0', title: 'Done', status: 'complete', markdown: '# Done', finished: true, updatedAt: '2026-10-21T08:30:00Z' };
  d.deck = addItems(emptyDeck(), [{ id: 'i1', type: 'flashcard', front: 'f', back: 'b' }], { now: new Date('2026-10-20T00:00:00Z') }).deck;
  d.plans = [{ id: 'p1', goal: 'Stats', days: [{ day: 1, focus: 'x', items: [{ id: 'a', title: 'Mean', kind: 'lesson', opened: true }, { id: 'b', title: 'Median', kind: 'lesson' }] }] }];
  d.courses = [{ id: 'c1', title: 'Optics', sections: [{ title: 's', lessons: [{ title: 'Light', lessonId: 'l1' }, { title: 'Lenses', lessonId: null }] }] }];
  const n = upNext(d, T0);
  assert.deepEqual(n.map((x) => x.kind), ['continue', 'review', 'plan', 'course']);
  assert.equal(n[0].lessonId, 'l1');
  assert.equal(n[0].interrupted, false);
  assert.equal(n[1].due, 1);
  assert.deepEqual([n[2].title, n[2].itemIndex], ['Median', 1]);
  assert.equal(n[3].title, 'Lenses', 'the course pick skips the lesson already offered as continue');
  assert.deepEqual(courseProgress(d, d.courses[0]), { done: 0, total: 2 });
});

test('learner totals and palette matching', () => {
  const d = emptyState();
  d.stats = awardXp(emptyStats(), 12, T0, TZ);
  d.lessons.l1 = { id: 'l1', finished: true };
  d.lessons.l2 = { id: 'l2', finished: false };
  const t = learnerTotals(d, T0);
  assert.deepEqual([t.xp, t.lessonsFinished, t.lessonsStarted, t.activeDays, t.cards], [12, 1, 2, 1, 0]);
  assert.equal(matchScore('Why the sky is blue', 'why'), 4);
  assert.equal(matchScore('Why the sky is blue', 'sky'), 3);
  assert.equal(matchScore('Why the sky is blue', 'ky is'), 2);
  assert.equal(matchScore('Why the sky is blue', 'blue why'), 1);
  assert.equal(matchScore('Why the sky is blue', 'red'), 0);
});

test('topic labels and roman numerals', async () => {
  const { topicInterest, roman } = await import('../public/progress-core.js');
  assert.equal(topicInterest('Compound interest'), 'Money');
  assert.equal(topicInterest('Something else'), '');
  assert.deepEqual([1, 4, 9, 14, 40, 0].map(roman), ['I', 'IV', 'IX', 'XIV', 'XL', '']);
});

test('reading time counts prose, not component markup', async () => {
  const { readingMinutes } = await import('../public/progress-core.js');
  const prose = Array.from({ length: 440 }, () => 'word').join(' ');
  assert.equal(readingMinutes(`# Title\n\n${prose}`), 2);
  const widget = `<Quiz questions={[${Array.from({ length: 300 }, () => '"x"').join(',')}]}/>`;
  assert.equal(readingMinutes(`# T\n\n${prose}\n\n${widget}`), 3, 'widget props are not words; the widget adds ~half a minute');
  assert.equal(readingMinutes(`# T\n\n${prose} <KeyTerm term="x" definition="y"/> <Cite refs={[1]}/>`), 2, 'inline marks add no time');
  assert.equal(readingMinutes(''), 0);
  assert.equal(readingMinutes('# A short one'), 1);
});
