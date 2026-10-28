// Phase 10: the Teacher's daily brief. Ranked from local state only (deck, plan, outcomes,
// streak), so it costs no model call, works in demo mode and offline, and is what a reminder
// notification says. Pure, tested under node:test.
//
//   {headline, urgent, items:[{kind, title, why, action:{type, …}}]}   at most 3 items, best first
//   urgent: the headline is about a deadline or a streak at risk (Today shows it in the header)
//   action types: review | refresh(lessonId) | course-review(courseId) | plan(planId, dayIndex, itemIndex) | teacher

import { deckStats, dueEntries, currentStreak, dateKey } from './deck.js';
import { planStatus, nextPlanItem, countdownLabel, dayLabel } from './plan-core.js';
import { fadingLessons, RECALL_MIN } from './outcomes-core.js';
import { dailyProgress } from './progress-core.js';
import { courseReviewSuggestion } from './course-review-core.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function dailyBrief(data, now = new Date()) {
  const items = [];
  const deck = data?.deck || { items: [] };
  const st = deckStats(deck, now);
  const plan = (data?.plans || [])[0] || null;
  const ps = plan ? planStatus(plan, now) : null;
  const next = plan ? nextPlanItem(plan, now) : null;
  const day = dailyProgress(data?.stats, data?.settings, now);
  const streak = currentStreak(data?.stats || {}, now);
  const hour = new Date(now).getHours();

  // 1. overdue plan work (falling behind a deadline is the most expensive thing to ignore)
  if (next?.when === 'overdue') {
    items.push({ kind: 'plan', title: next.item.title, why: `Planned for ${dayLabel(next.date)}${ps.overdue.length > 1 ? ` · ${ps.overdue.length} items behind` : ''}${ps.deadline ? ` · ${countdownLabel(ps.daysToDeadline)}` : ''}`, action: { type: 'plan', planId: plan.id, dayIndex: next.dayIndex, itemIndex: next.itemIndex } });
  }
  // 2. due cards: FSRS schedules each one when recall drops to ~90%, so now is the cheap moment
  if (st.due) {
    const lessons = new Set(dueEntries(deck, now).map((e) => e.lessonTitle).filter(Boolean));
    items.push({ kind: 'review', title: `Review ${plural(st.due, 'card')}`, why: `About ${Math.max(1, Math.round(Math.min(st.due, 12) * 0.4))} min, before they slip${lessons.size ? ` · from ${[...lessons].slice(0, 2).join(', ')}${lessons.size > 2 ? '…' : ''}` : ''}`, action: { type: 'review' } });
  }
  // 3. today's plan item
  if (next?.when === 'today') {
    items.push({ kind: 'plan', title: next.item.title, why: `Today in your plan${ps.deadline ? ` · ${countdownLabel(ps.daysToDeadline, plan.goal)}` : ''}`, action: { type: 'plan', planId: plan.id, dayIndex: next.dayIndex, itemIndex: next.itemIndex } });
  }
  // 4. the lesson that is fading worst (measured, or forecast by FSRS)
  const fading = fadingLessons(data, now, 1)[0];
  if (fading) {
    const why = fading.recall.n >= RECALL_MIN ? `You recalled ${Math.round(fading.recall.rate * 100)}% of it days later` : fading.memoryToday != null ? `Memory estimated at ${Math.round(fading.memoryToday * 100)}% today` : 'Some of its cards keep slipping';
    items.push({ kind: 'refresh', title: `Refresh “${fading.title}”`, why, action: { type: 'refresh', lessonId: fading.lessonId } });
  }
  // 5. a course whose lessons are slipping together: one interleaved pass across all of them
  const course = courseReviewSuggestion(data, now);
  if (course) {
    items.push({ kind: 'course-review', title: `Review all of “${course.title}”`, why: `Memory across its ${course.lessons} lessons is down to ~${Math.round(course.memory * 100)}% · one mixed session`, action: { type: 'course-review', courseId: course.courseId } });
  }
  // 6. nothing pressing: let the Teacher pick
  if (!items.length) items.push({ kind: 'teacher', title: 'Ask your Teacher what to learn next', why: st.total ? `Nothing due${st.nextDue ? ` until ${new Date(st.nextDue).toLocaleDateString(undefined, { weekday: 'short' })}` : ''}. A good moment for something new.` : 'A plan around your goal takes a minute.', action: { type: 'teacher' } });

  let headline;
  let urgent = false;
  if (ps?.deadline && ps.daysToDeadline != null && ps.daysToDeadline >= 0) {
    headline = `${countdownLabel(ps.daysToDeadline, plan.goal)}.${ps.pace === 'behind' ? ` You are ${plural(ps.overdue.length, 'item')} behind.` : ps.pace === 'ahead' ? ' You are ahead of plan.' : ''}`;
    urgent = true;
  } else if (streak > 0 && !day.xp && hour >= 18) {
    headline = `Your ${streak}-day streak ends at midnight. One review keeps it.`;
    urgent = true;
  } else if (day.met) {
    headline = 'Today’s goal is done. Anything more is a bonus.';
  } else if (st.due) {
    headline = `${plural(st.due, 'card')} ${st.due === 1 ? 'is' : 'are'} ready, the best moment to lock ${st.due === 1 ? 'it' : 'them'} in.`;
  } else {
    headline = 'Here is what would help most today.';
  }
  return { date: dateKey(now), headline, urgent, items: items.slice(0, 3) };
}

/** One-line notification text: the headline plus the top action. */
export function briefNotification(brief) {
  const top = brief.items[0];
  return { title: 'Mull', body: top ? `${brief.headline} Next: ${top.title}.` : brief.headline };
}

/** Should the daily reminder fire now? (enabled, past its time, goal not met, not yet today) */
export function reminderDue(settings, stats, now = new Date(), lastShown = null) {
  const r = settings?.reminder;
  if (!r?.enabled || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(r.time || '')) return false;
  const today = dateKey(now);
  if (lastShown === today) return false;
  const [h, m] = r.time.split(':').map(Number);
  const d = new Date(now);
  if (d.getHours() * 60 + d.getMinutes() < h * 60 + m) return false;
  return !dailyProgress(stats, settings, now).met;
}
