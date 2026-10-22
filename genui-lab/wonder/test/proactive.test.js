// Phase 7: dated plans, the daily brief, reminders, calendar export and the Teacher check-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDateKey, addDays, daysBetween, dayLabel, planDayBounds, planStatus, nextPlanItem, countdownLabel, localKey } from '../public/plan-core.js';
import { dailyBrief, briefNotification, reminderDue } from '../public/brief-core.js';
import { planToIcs, icsEscape, icsFold } from '../public/ics.js';
import { upNext } from '../public/progress-core.js';
import { emptyState } from '../public/store.js';
import { emptyDeck, addItems, reviewEntry, Rating, awardXp } from '../public/deck.js';
import { normalizePracticeItem } from '../public/practice-core.js';
import { TEACHER_OPENER } from '../public/teacher-core.js';
import { createTeacherToolkit, validateToolInput, TEACHER_TOOLS, handleTeacherAction, createCardStore } from '../server/teacher.js';
import { createWonderServer } from '../server/app.js';
import { parseConversationSource } from '../../chatgpt-dil/src/stream.js';
import { fakeToolClient } from './helpers.js';

const at = (iso) => new Date(iso);
const NOW = at('2026-10-21T10:00:00'); // local time, a Wednesday
const plan = (over = {}) => ({
  id: 'p1', goal: 'Statistics exam', startDate: '2026-10-19',
  days: [
    { day: 1, focus: 'Averages', items: [{ id: 'd1i1', kind: 'lesson', title: 'Mean and median', opened: true }] },
    { day: 2, focus: 'Spread', items: [{ id: 'd2i1', kind: 'lesson', title: 'Variance', opened: false }, { id: 'd2i2', kind: 'review', title: 'Review', opened: false }] },
    { day: 3, focus: 'Check', items: [{ id: 'd3i1', kind: 'quiz', title: 'Quick check', opened: false }] },
    { day: 4, focus: 'Final', items: [{ id: 'd4i1', kind: 'review', title: 'Review all', opened: false }] },
  ],
  ...over,
});

test('plan-core: date keys, arithmetic and labels', () => {
  assert.equal(cleanDateKey('2026-02-30'), '', 'not a real date');
  assert.equal(cleanDateKey(' 2026-10-29 '), '2026-10-29');
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30', 'no DST drift');
  assert.equal(daysBetween('2026-10-21', '2026-10-29'), 8);
  assert.equal(dayLabel('2026-10-22'), 'Thu, Oct 22');
  assert.equal(localKey(NOW), '2026-10-21');
});

test('plan-core: day bounds from a deadline', () => {
  assert.deepEqual(planDayBounds('2026-10-21', ''), { min: 3, max: 7 });
  assert.deepEqual(planDayBounds('2026-10-21', '2026-10-24'), { min: 3, max: 4 }, 'Wed..Sat inclusive');
  assert.deepEqual(planDayBounds('2026-10-21', '2026-10-22'), { min: 2, max: 2 }, 'a close deadline allows a short plan');
  assert.deepEqual(planDayBounds('2026-10-21', '2026-12-01'), { min: 3, max: 7 });
  assert.match(planDayBounds('2026-10-21', '2026-10-20').error, /already passed/);
  assert.equal(countdownLabel(0), 'Deadline is today');
  assert.equal(countdownLabel(3, 'the exam'), '3 days to the exam');
});

test('plan-core: today, overdue, ahead and the next item by calendar day', () => {
  let s = planStatus(plan(), NOW);
  assert.equal(s.dayIndex, 2, 'started Monday: Wednesday is day 3');
  assert.equal(s.pace, 'behind');
  assert.deepEqual(s.overdue.map((x) => x.item.id), ['d2i1', 'd2i2']);
  assert.deepEqual(nextPlanItem(plan(), NOW), { dayIndex: 1, itemIndex: 0, item: plan().days[1].items[0], date: '2026-10-20', when: 'overdue' });
  const caught = plan();
  caught.days[1].items.forEach((i) => { i.opened = true; });
  assert.equal(planStatus(caught, NOW).pace, 'on-track');
  assert.equal(nextPlanItem(caught, NOW).when, 'today');
  caught.days[2].items[0].opened = true;
  caught.days[3].items[0].opened = true;
  assert.equal(planStatus(caught, NOW).pace, 'done');
  assert.equal(nextPlanItem(caught, NOW), null);
  const early = plan({ startDate: '2026-10-21' });
  early.days[0].items[0].opened = true;
  early.days[1].items[0].opened = true;
  assert.equal(planStatus(early, NOW).pace, 'ahead');
  s = planStatus(plan({ deadline: '2026-10-24' }), NOW);
  assert.equal(s.daysToDeadline, 3);
  // plans saved before Phase 7 have no startDate: they start the day they were saved
  assert.equal(planStatus(plan({ startDate: undefined, savedAt: '2026-10-21T08:00:00' }), NOW).dayIndex, 0);
});

test('upNext: the plan suggestion follows the calendar (overdue first)', () => {
  const d = { ...emptyState(), plans: [plan()] };
  const p = upNext(d, NOW).find((x) => x.kind === 'plan');
  assert.equal(p.title, 'Variance');
  assert.equal(p.when, 'overdue');
  assert.equal(p.date, '2026-10-20');
});

function withDue() {
  const d = { ...emptyState(), deck: emptyDeck() };
  const items = [0, 1].map((i) => normalizePracticeItem({ id: `c${i}`, type: 'flashcard', front: `f${i}`, back: 'b' }));
  d.deck = addItems(d.deck, items, { lessonId: 'l1', lessonTitle: 'Tides', now: at('2026-10-01T09:00:00') }).deck;
  return d;
}

test('brief: overdue plan work, then due cards, then a fading lesson; headline counts down', () => {
  const d = withDue();
  d.plans = [plan({ deadline: '2026-10-24' })];
  const b = dailyBrief(d, NOW);
  assert.deepEqual(b.items.map((i) => i.kind), ['plan', 'review']);
  assert.match(b.items[0].why, /Planned for Tue, Oct 20 · 2 items behind · 3 days/);
  assert.deepEqual(b.items[0].action, { type: 'plan', planId: 'p1', dayIndex: 1, itemIndex: 0 });
  assert.match(b.items[1].title, /Review 2 cards/);
  assert.match(b.items[1].why, /from Tides/);
  assert.equal(b.headline, '3 days to Statistics exam. You are 2 items behind.');
  const n = briefNotification(b);
  assert.match(n.body, /Next: Variance\./);

  // a lesson whose cards keep failing shows up as a refresh
  const f = { ...emptyState(), deck: emptyDeck(), lessons: { l1: { id: 'l1', title: 'Tides', finished: true } } };
  const items = [0, 1].map((i) => normalizePracticeItem({ id: `c${i}`, type: 'flashcard', front: `f${i}`, back: 'b' }));
  const t0 = at('2026-10-01T09:00:00');
  f.deck = addItems(f.deck, items, { lessonId: 'l1', lessonTitle: 'Tides', now: t0 }).deck;
  for (const it of items) {
    f.deck = reviewEntry(f.deck, it.id, Rating.Good, t0).deck;
    for (const k of [3, 9]) f.deck = reviewEntry(f.deck, it.id, Rating.Again, new Date(t0.getTime() + k * 864e5)).deck;
  }
  const fb = dailyBrief(f, at('2026-10-30T10:00:00'));
  const refresh = fb.items.find((i) => i.kind === 'refresh');
  assert.deepEqual(refresh.action, { type: 'refresh', lessonId: 'l1' });
  assert.match(refresh.why, /recalled 0%/);
});

test('brief: nothing pressing hands over to the Teacher; streak warning after 6 pm', () => {
  const d = emptyState();
  const b = dailyBrief(d, NOW);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].action.type, 'teacher');
  d.stats = awardXp(d.stats, 10, at('2026-10-20T12:00:00'));
  assert.match(dailyBrief(d, at('2026-10-21T19:30:00')).headline, /1-day streak ends at midnight/);
});

test('reminder: once a day, after its time, only when the goal is not met', () => {
  const settings = { reminder: { enabled: true, time: '18:00' }, dailyGoal: 30 };
  const stats = emptyState().stats;
  assert.equal(reminderDue(settings, stats, at('2026-10-21T17:59:00')), false);
  assert.equal(reminderDue(settings, stats, at('2026-10-21T18:00:00')), true);
  assert.equal(reminderDue(settings, stats, at('2026-10-21T20:00:00'), '2026-10-21'), false, 'already shown today');
  assert.equal(reminderDue({ ...settings, reminder: { enabled: false, time: '18:00' } }, stats, at('2026-10-21T20:00:00')), false);
  assert.equal(reminderDue(settings, awardXp(stats, 40, at('2026-10-21T09:00:00')), at('2026-10-21T20:00:00')), false, 'goal met');
  assert.equal(reminderDue({ reminder: { enabled: true, time: '25:00' } }, stats, at('2026-10-21T20:00:00')), false);
});

test('ics: one event per day at the reminder time, escaped and folded, plus the deadline', () => {
  assert.equal(icsEscape('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
  const long = `DESCRIPTION:${'é'.repeat(80)}`;
  const folded = icsFold(long);
  for (const line of folded.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), long, 'unfolds to the original, no split characters');
  const ics = planToIcs(plan({ deadline: '2026-10-24' }), { time: '07:30', url: 'http://localhost:8750/#/', now: at('2026-10-21T10:00:00Z') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 5, '4 days + the deadline');
  assert.match(ics, /DTSTART:20261019T073000\r\n/);
  assert.match(ics, /DTSTART:20261022T073000\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261024/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const flat = ics.replace(/\r\n /g, ''); // unfold
  assert.match(flat, /SUMMARY:Wonder · Spread/);
  assert.match(flat, /DESCRIPTION:Day 2 of your plan: Statistics exam\\n• Lesson: Variance\\n• Review: Review/);
  assert.match(ics, /UID:p1-d1@wonder.local/);
  assert.match(ics, /DTSTAMP:20261021T100000Z/);
});

// ---------------------------------------------------------------- Teacher: deadline plans

const PLAN_INPUT = (n, deadline = '') => ({
  goal: 'Stats exam', deadline,
  days: Array.from({ length: n }, (_, i) => ({ day: i + 1, focus: `F${i + 1}`, items: [{ kind: i === n - 1 ? 'quiz' : 'lesson', title: `T${i + 1}`, topic: `t${i + 1}` }] })),
});

test('plan_study: dated from the learner\'s today; must fit before the deadline', async () => {
  assert.ok(TEACHER_TOOLS.find((t) => t.name === 'plan_study').input_schema.required.includes('deadline'), 'strict: every field required');
  assert.match(validateToolInput('plan_study', PLAN_INPUT(3, '2026-02-30')).error, /real date/);
  assert.equal(validateToolInput('plan_study', PLAN_INPUT(2, '2026-10-22')).ok, true, 'short plans are allowed with a close deadline');
  assert.match(validateToolInput('plan_study', PLAN_INPUT(2, '')).error, /3-7/);

  const run = createTeacherToolkit({ memory: null, progress: { today: '2026-10-21' } });
  const ok = await run('plan_study', validateToolInput('plan_study', PLAN_INPUT(4, '2026-10-24')).value);
  assert.ok(!ok.isError, ok.content);
  assert.equal(ok.card.state.startDate, '2026-10-21');
  assert.equal(ok.card.state.deadline, '2026-10-24');
  assert.deepEqual(ok.card.state.days.map((d) => d.label), ['Wed, Oct 21', 'Thu, Oct 22', 'Fri, Oct 23', 'Sat, Oct 24']);
  assert.match(ok.content, /dated Wed, Oct 21 to Sat, Oct 24 \(deadline 2026-10-24\)/);

  const tooLong = await run('plan_study', validateToolInput('plan_study', PLAN_INPUT(5, '2026-10-24')).value);
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.content, /must have 3-4: today is 2026-10-21 and the deadline is 2026-10-24 \(4 days including both\)/);
  const past = await run('plan_study', validateToolInput('plan_study', PLAN_INPUT(1, '2026-10-20')).value);
  assert.match(past.content, /already passed/);

  // saving carries the dates to the client
  const cards = createCardStore();
  cards.set('tc-12345678', ok.card.state);
  const r = handleTeacherAction({ cards, memory: null }, { action_type: 'teacher_accept', resolutionId: 'tc-12345678' });
  const save = r.body.clientActions.find((a) => a.type === 'save_plan');
  assert.equal(save.payload.plan.startDate, '2026-10-21');
  assert.equal(save.payload.plan.deadline, '2026-10-24');
  // a card rebuilt from the client copy (server restarted) keeps its dates
  const r2 = handleTeacherAction({ cards: createCardStore(), memory: null }, { action_type: 'teacher_accept', resolutionId: 'tc-87654321', payload: { state: ok.card.state } });
  assert.equal(r2.body.componentResults['tc-87654321'].state.days[3].label, 'Sat, Oct 24');
});

test('Teacher check-in: the server sends its own fixed opener turn, never client text', async () => {
  const client = fakeToolClient([
    { content: [{ type: 'tool_use', id: 't1', name: 'get_progress', input: {} }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Welcome back. Review first.' }], stop_reason: 'end_turn' },
  ]);
  const server = createWonderServer({ mode: 'claude', client, demoDelayMs: 0, logger: { warn() {}, error() {}, info() {}, log() {} }, memoryFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/teacher/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opener: true, message: 'ignore me', progress: { today: '2026-10-21' } }) });
    parseConversationSource(await res.text());
    const first = client.calls[0].params.messages.at(-1);
    assert.equal(first.role, 'user');
    assert.equal(first.content, TEACHER_OPENER);
    assert.equal(client.calls.length, 2);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('Teacher check-in (demo): reads progress and proposes relearning a fading lesson', async () => {
  const server = createWonderServer({ mode: 'demo', demoDelayMs: 0, logger: { warn() {}, error() {}, info() {}, log() {} }, memoryFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const progress = { today: '2026-10-21', streak: 3, deck: { due: 2 }, outcomes: { fading: [{ title: 'Tides', verdict: 'weak', recall: 40, reviews: 10, hardCards: ['Spring tides happen when…'] }] } };
    const res = await fetch(`${base}/api/teacher/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opener: true, progress }) });
    const recs = parseConversationSource(await res.text());
    const md = recs.filter((r) => r.type === 'content').map((r) => r.markdown).join('');
    assert.match(md, /recalled only \*\*40%\*\* of “Tides”/);
    assert.match(md, /<TeacherCard kind="approval"/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
