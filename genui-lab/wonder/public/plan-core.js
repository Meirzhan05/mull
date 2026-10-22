// Phase 10: dated study plans. Pure helpers (no DOM) shared by the server (plan_study puts real
// dates on a plan and checks it fits before the deadline) and the browser (today's plan day,
// overdue items, ahead / on track / behind, the deadline countdown).
//
// Dates are local calendar keys "YYYY-MM-DD" (deck.js dateKey); arithmetic runs in UTC on
// those keys so it never drifts across DST changes.

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A valid "YYYY-MM-DD" key, or '' (rejects 2026-02-30 and the like). */
export function cleanDateKey(v) {
  const m = KEY_RE.exec(String(v ?? '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === m[0] ? m[0] : '';
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a, b) {
  const t = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 864e5);
}

/** "Wed, Oct 22": locale-independent so the server and the sandboxed card agree. */
export function dayLabel(key) {
  const d = new Date(`${key}T12:00:00Z`);
  return `${'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d.getUTCDay()]}, ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Local "YYYY-MM-DD" of a Date. */
export function localKey(now = new Date()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * How many plan days fit: without a deadline 3-7; with one, at most the days from `today` up to
 * and including the deadline (and fewer than 3 only when the deadline is that close).
 * Returns {min, max} or {error}.
 */
export function planDayBounds(today, deadline) {
  if (!deadline) return { min: 3, max: 7 };
  const left = daysBetween(today, deadline) + 1;
  if (left < 1) return { error: `The deadline ${deadline} has already passed (today is ${today}).` };
  return { min: Math.min(3, left), max: Math.min(7, left) };
}

/** Put a date and a label on every day of a plan starting at `startDate`. */
export function dateDays(days, startDate) {
  return days.map((d, i) => {
    const date = addDays(startDate, i);
    return { ...d, date, label: dayLabel(date) };
  });
}

/** Start date of a saved plan: its own, else the date it was saved (plans from before Phase 10). */
export function planStart(plan) {
  return cleanDateKey(plan?.startDate) || (plan?.savedAt ? localKey(new Date(plan.savedAt)) : '') || cleanDateKey(plan?.days?.[0]?.date) || '';
}

/**
 * Where the learner is in a saved plan today:
 *   {start, today, dayIndex (−1 before the start, days.length after the end), dates[],
 *    todayItems:[{dayIndex,itemIndex,item}], overdue:[…], ahead:n, pace:'ahead'|'on-track'|'behind'|'done'|'not-started',
 *    deadline, daysToDeadline (null without a deadline), finished}
 */
export function planStatus(plan, now = new Date()) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const today = localKey(now);
  const start = planStart(plan) || today;
  const dayIndex = Math.max(-1, Math.min(days.length, daysBetween(start, today)));
  const ref = (di, ii, item) => ({ dayIndex: di, itemIndex: ii, item, date: addDays(start, di) });
  const overdue = [];
  const todayItems = [];
  let ahead = 0;
  let total = 0;
  let opened = 0;
  days.forEach((d, di) => (d.items || []).forEach((item, ii) => {
    total++;
    if (item.opened) opened++;
    if (di < dayIndex && !item.opened) overdue.push(ref(di, ii, item));
    else if (di === dayIndex) todayItems.push(ref(di, ii, item));
    else if (di > dayIndex && item.opened) ahead++;
  }));
  const finished = total > 0 && opened === total;
  const deadline = cleanDateKey(plan?.deadline);
  const pace = finished ? 'done' : dayIndex < 0 ? 'not-started' : overdue.length ? 'behind' : ahead ? 'ahead' : 'on-track';
  return {
    start, today, dayIndex,
    dates: days.map((_, i) => addDays(start, i)),
    todayItems, overdue, ahead, total, opened, finished, pace,
    deadline: deadline || null,
    daysToDeadline: deadline ? daysBetween(today, deadline) : null,
  };
}

/** The plan item to do next: the oldest overdue one, else today's next, else the next upcoming one. */
export function nextPlanItem(plan, now = new Date()) {
  const s = planStatus(plan, now);
  if (s.overdue.length) return { ...s.overdue[0], when: 'overdue' };
  const t = s.todayItems.find((x) => !x.item.opened);
  if (t) return { ...t, when: 'today' };
  for (const [di, d] of (plan?.days || []).entries()) {
    if (di <= s.dayIndex) continue;
    const ii = (d.items || []).findIndex((it) => !it.opened);
    if (ii >= 0) return { dayIndex: di, itemIndex: ii, item: d.items[ii], date: s.dates[di], when: 'upcoming' };
  }
  return null;
}

/** "Deadline today", "3 days to Statistics exam" … */
export function countdownLabel(daysTo, goal = '') {
  if (daysTo == null) return '';
  const what = goal ? ` to ${goal}` : '';
  if (daysTo < 0) return `Deadline passed ${-daysTo} day${daysTo === -1 ? '' : 's'} ago`;
  if (daysTo === 0) return 'Deadline is today';
  if (daysTo === 1) return `1 day${what}`;
  return `${daysTo} days${what}`;
}
