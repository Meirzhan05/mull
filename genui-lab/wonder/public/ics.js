// Phase 10: "Add to calendar" for a saved study plan. One iCalendar (RFC 5545) event per plan day
// at the learner's reminder time, listing that day's items, with a reminder alarm. Floating local
// times (no TZID) so the event lands at that wall-clock time wherever the calendar is. Calendar
// reminders work with Wonder closed, with no push server. Pure, so it is tested under node:test.

import { addDays, planStart, cleanDateKey } from './plan-core.js';

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line to 75 octets per physical line (§3.1), never splitting a UTF-8 sequence. */
export function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ITEM_VERB = { lesson: 'Lesson', review: 'Review', quiz: 'Quiz' };

/**
 * @param plan  a saved plan {id, goal, startDate?, deadline?, days:[{focus, items:[{kind,title}]}]}
 * @param opts  {time: "HH:MM" (default 18:00), minutes: event length (20), url: app link, now}
 */
export function planToIcs(plan, { time = '18:00', minutes = 20, url = '', now = new Date() } = {}) {
  const [hh, mm] = (/^([01]\d|2[0-3]):([0-5]\d)$/.test(time) ? time : '18:00').split(':');
  const start = planStart(plan) || cleanDateKey(new Date(now).toISOString().slice(0, 10));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wonder//Study plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(`Wonder: ${plan.goal || 'Study plan'}`)}`];
  (plan.days || []).forEach((d, i) => {
    const date = addDays(start, i).replace(/-/g, '');
    const items = (d.items || []).map((it) => `• ${ITEM_VERB[it.kind] || 'Study'}: ${it.title}`);
    const desc = [`Day ${i + 1} of your plan: ${plan.goal || ''}`.trim(), ...items, url ? `Open Wonder: ${url}` : ''].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(`${plan.id || 'plan'}-d${i + 1}@wonder.local`)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${date}T${hh}${mm}00`,
      `DURATION:PT${Math.max(5, Math.round(minutes))}M`,
      `SUMMARY:${icsEscape(`Wonder · ${d.focus || `Day ${i + 1}`}`)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      ...(url ? [`URL:${icsEscape(url)}`] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(`Time to study: ${d.focus || plan.goal || 'Wonder'}`)}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT');
  });
  if (cleanDateKey(plan.deadline)) {
    lines.push('BEGIN:VEVENT', `UID:${icsEscape(`${plan.id || 'plan'}-deadline@wonder.local`)}`, `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${plan.deadline.replace(/-/g, '')}`, `SUMMARY:${icsEscape(`Deadline: ${plan.goal || 'study goal'}`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}
