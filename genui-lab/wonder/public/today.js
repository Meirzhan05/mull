// Today (#/): a working dashboard. A compact header, one command bar (start a lesson, plan a
// course or write to the Teacher), then two columns: the "Up next" queue, suggestions and recent
// reading on the left; a rail of panels (today's XP, the streak, the deck, the study plan) on the
// right. On narrow screens the rail moves above the queue as a strip.

import { el, icon, toast, relTime } from './ui.js';
import { currentStreak, deckStats, formatDue } from './deck.js';
import { dailyProgress, weekStrip, upNext, suggestedTopics, greeting, courseProgress, learnerTotals, topicInterest, readingMinutes } from './progress-core.js';
import { pageCount } from './steering-core.js';

const MODES = [
  { id: 'lesson', label: 'Lesson', placeholder: 'What do you want to understand?', action: 'Begin' },
  { id: 'course', label: 'Course', placeholder: 'A subject to study over several lessons', action: 'Plan' },
  { id: 'teacher', label: 'Teacher', placeholder: 'A goal, a question, or a plan you need', action: 'Send' },
];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * @param {{app: HTMLElement, store: object, status: object, actions: object}} ctx
 *   actions: startLesson(topic, level), planCourse(topic, level) → Promise, askTeacher(text),
 *            openPlanItem(planId, dayIndex, itemIndex), openCourseLesson(courseId, si, li)
 */
export function renderToday(ctx) {
  const { app, store, actions } = ctx;
  const d = store.data;
  const settings = d.settings || {};
  const now = new Date();
  const day = dailyProgress(d.stats, settings, now);
  const streak = currentStreak(d.stats, now);
  const totals = learnerTotals(d, now);
  const name = String(settings.name || '').trim();

  // -- header
  const sub = day.met
    ? 'Today’s goal is met.'
    : day.xp > 0
      ? `${day.goal - day.xp} XP to today’s goal.`
      : streak > 0 ? `Keep the ${streak}-day streak going.` : 'Pick up where you left off, or start something new.';
  const head = el('header', { class: 't-head' },
    el('p', { class: 't-date' }, now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), totals.activeDays ? ` · Day ${totals.activeDays}` : ''),
    el('h1', { class: 't-title' }, `${greeting(now)}${name ? `, ${name}` : ''}`),
    el('p', { class: 't-sub' }, sub));

  // -- command bar
  let mode = 'lesson';
  let level = 'beginner';
  const input = el('input', { type: 'text', maxlength: '300', autocomplete: 'off', 'aria-label': 'What do you want to understand?' });
  const go = el('button', { class: 'btn cmd-go', type: 'submit' }, el('span', null, 'Begin'), el('kbd', { class: 'cmd-kbd' }, '↵'));
  const modeSeg = el('div', { class: 'seg cmd-modes', role: 'tablist', 'aria-label': 'What to start' }, ...MODES.map((m) => el('button', {
    class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': String(m.id === mode), dataset: { mode: m.id },
    onclick: () => { setMode(m.id); input.focus(); },
  }, m.label)));
  const levelSel = el('select', { class: 'cmd-level', 'aria-label': 'Level', onchange: (e) => { level = e.target.value; } }, ...LEVELS.map((lv) => el('option', { value: lv }, cap(lv))));
  function setMode(m) {
    mode = m;
    const def = MODES.find((x) => x.id === m);
    for (const b of modeSeg.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    input.placeholder = def.placeholder;
    go.firstChild.textContent = def.action;
    levelSel.hidden = m === 'teacher';
  }
  setMode('lesson');
  async function submit() {
    const t = input.value.trim();
    if (!t) { input.focus(); toast(mode === 'teacher' ? 'Write a message first' : 'Name a subject first'); return; }
    if (mode === 'lesson') actions.startLesson(t, level);
    else if (mode === 'teacher') actions.askTeacher(t);
    else {
      go.disabled = true;
      go.firstChild.textContent = 'Planning…';
      const ok = await actions.planCourse(t, level);
      if (!ok) { go.disabled = false; setMode('course'); }
    }
  }
  const cmd = el('form', { class: 'cmd', onsubmit: (e) => { e.preventDefault(); submit(); } },
    modeSeg,
    el('label', { class: 'cmd-field' }, icon('search'), input),
    levelSel,
    go);

  // -- left column: queue, suggestions, recent
  const next = upNext(d, now);
  const queue = el('section', { class: 'panel-section' },
    sectionHead('Up next', next[0]?.kind === 'start' ? null : `${next.length}`),
    el('ol', { class: 'queue' }, ...next.map((n, i) => queueRow(n, i, ctx)), ...(next[0]?.kind === 'start' ? quickRows(ctx) : [])));

  const topics = suggestedTopics(settings, d.lessons, now, 6);
  const suggested = el('section', { class: 'panel-section' },
    sectionHead(settings.interests?.length ? 'Suggested for you' : 'Suggested', null, el('a', { class: 'link-btn', href: '#/you' }, 'Interests')),
    el('ul', { class: 'tiles' }, ...topics.map((t) => el('li', null, el('button', { type: 'button', class: 'tile', onclick: () => actions.startLesson(t, level) },
      el('span', { class: 'tile-tag' }, topicInterest(t) || 'General'),
      el('span', { class: 'tile-title' }, t),
      el('span', { class: 'tile-go' }, 'Start lesson', icon('arrow-right')))))));

  const recent = Object.values(d.lessons).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 5);
  const recentSec = recent.length ? el('section', { class: 'panel-section' },
    sectionHead('Recent', null, el('a', { class: 'link-btn', href: '#/library' }, 'Library', icon('arrow-right'))),
    el('ul', { class: 'rows' }, ...recent.map((l) => el('li', null, readRow(l, d))))) : null;

  // -- right rail
  const week = weekStrip(d.stats, settings, now);
  const deck = deckStats(d.deck, now);
  const rail = el('aside', { class: 't-rail', 'aria-label': 'Your progress' },
    el('a', { class: 'stat-panel', href: '#/you' },
      el('span', { class: 'stat-label' }, 'Today'),
      el('span', { class: 'stat-big' }, String(day.xp), el('small', null, ` / ${day.goal} XP`)),
      el('span', { class: `ledger-bar ${day.met ? 'met' : ''}`, 'aria-hidden': 'true' }, el('i', { style: { width: `${Math.round(day.pct * 100)}%` } })),
      el('span', { class: 'stat-note' }, day.met ? 'Goal met' : `${day.goal - day.xp} XP to go`)),
    el('a', { class: 'stat-panel', href: '#/you' },
      el('span', { class: 'stat-label' }, 'Streak'),
      el('span', { class: 'stat-big' }, String(streak), el('small', null, streak === 1 ? ' day' : ' days')),
      el('span', { class: 'week7', 'aria-label': `Last seven days: ${week.filter((w) => w.active).length} active` },
        ...week.map((w) => el('span', { class: `w ${w.active ? 'on' : ''} ${w.met ? 'met' : ''} ${w.today ? 'today' : ''}`, title: `${w.key}: ${w.xp} XP` }, el('i'), el('b', null, w.label))))),
    el('a', { class: 'stat-panel', href: '#/review' },
      el('span', { class: 'stat-label' }, 'Deck'),
      el('span', { class: 'stat-big' }, String(deck.due), el('small', null, ' due')),
      el('span', { class: 'stat-lines' },
        el('span', null, el('b', null, String(deck.total)), ' cards'),
        el('span', null, el('b', null, String(deck.review)), ' mastered'),
        el('span', null, deck.due ? 'Review now' : deck.nextDue ? `Next ${formatDue(deck.nextDue)}` : 'No cards yet'))),
    planPanel(d, actions));

  app.replaceChildren(el('div', { class: 'today' }, head, cmd,
    el('div', { class: 't-grid' }, el('div', { class: 't-main' }, queue, suggested, recentSec), rail)));
}

function sectionHead(title, count, extra) {
  return el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, title, count ? el('span', { class: 'count' }, count) : null), extra || null);
}

function queueRow(n, i, ctx) {
  const { actions, store } = ctx;
  const row = ({ kind, title, meta, body, cta, onclick, href }) => {
    const act = href ? el('a', { class: `btn ${i ? 'btn-secondary' : ''} btn-sm`, href }, cta) : el('button', { class: `btn ${i ? 'btn-secondary' : ''} btn-sm`, type: 'button', onclick }, cta);
    return el('li', { class: `q ${i === 0 ? 'q-first' : ''}` },
      el('span', { class: 'q-idx' }, String(i + 1).padStart(2, '0')),
      el('div', { class: 'q-body' },
        el('span', { class: 'q-kind' }, kind),
        el('span', { class: 'q-title' }, title),
        body && i === 0 ? el('span', { class: 'q-text' }, body) : null,
        meta ? el('span', { class: 'q-meta' }, meta) : null),
      act);
  };
  if (n.kind === 'continue') {
    const l = store.data.lessons[n.lessonId];
    const pages = pageCount(l?.markdown);
    const course = n.courseId ? store.data.courses.find((c) => c.id === n.courseId) : null;
    return row({ kind: n.interrupted ? 'Unfinished lesson' : 'Continue reading', title: n.title,
      body: n.interrupted ? 'Stopped before the end. Resume continues from the last complete paragraph.' : null,
      meta: [pages ? `${pages} pages` : null, readingMinutes(l?.markdown) ? `${readingMinutes(l.markdown)} min` : null, n.page > 1 ? `on page ${n.page}` : null, course?.title, l?.updatedAt ? relTime(l.updatedAt) : null].filter(Boolean).join(' · '),
      cta: n.interrupted ? 'Resume' : 'Continue', href: `#/lesson/${n.lessonId}` });
  }
  if (n.kind === 'review') {
    return row({ kind: 'Review', title: `${n.due} card${n.due === 1 ? '' : 's'} due`, body: 'Recall each card just before you would forget it.',
      meta: `about ${Math.max(1, Math.round(Math.min(n.due, 12) * 0.4))} min`, cta: 'Review', href: '#/review' });
  }
  if (n.kind === 'plan') {
    return row({ kind: `Study plan · day ${n.day}`, title: n.title, body: n.goal, cta: n.itemKind === 'quiz' ? 'Quiz' : 'Open', onclick: () => actions.openPlanItem(n.planId, n.dayIndex, n.itemIndex) });
  }
  if (n.kind === 'course') {
    return row({ kind: n.courseTitle, title: n.title, body: n.summary, meta: `lesson ${n.done + 1} of ${n.total}`, cta: n.done ? 'Next lesson' : 'Start', onclick: () => actions.openCourseLesson(n.courseId, n.si, n.li) });
  }
  const t = suggestedTopics(store.data.settings, store.data.lessons, new Date(), 1)[0];
  return row({ kind: n.first ? 'First lesson' : 'All caught up', title: n.first ? `Start with “${t}”` : `Read “${t}”`,
    body: 'Lessons are written for you as you read: short pages, working diagrams, a quiz, and a tutor beside the text.', meta: 'about 10 min', cta: 'Start', onclick: () => actions.startLesson(t, 'beginner') });
}

function quickRows(ctx) {
  const { actions } = ctx;
  const r = (i, kind, title, cta, onclick, href) => el('li', { class: 'q' },
    el('span', { class: 'q-idx' }, String(i).padStart(2, '0')),
    el('div', { class: 'q-body' }, el('span', { class: 'q-kind' }, kind), el('span', { class: 'q-title' }, title)),
    href ? el('a', { class: 'btn btn-secondary btn-sm', href }, cta) : el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick }, cta));
  return [
    r(2, 'Teacher', 'Plan a week of study around a goal', 'Plan', null, '#/teacher'),
    r(3, 'Teacher', 'Ask what to study today', 'Ask', () => actions.askTeacher('What should I study today?')),
  ];
}

function planPanel(d, actions) {
  const plan = (d.plans || [])[0];
  if (!plan) return null;
  const items = (plan.days || []).flatMap((day, di) => (day.items || []).map((it, ii) => ({ ...it, di, ii, day: day.day || di + 1 })));
  const done = items.filter((x) => x.opened).length;
  return el('section', { class: 'stat-panel plan-panel' },
    el('span', { class: 'stat-label' }, 'Study plan', el('span', { class: 'count' }, `${done}/${items.length}`)),
    el('span', { class: 'plan-goal' }, plan.goal),
    el('ul', { class: 'checklist' }, ...items.slice(0, 8).map((it) => el('li', null, el('button', { type: 'button', class: `check ${it.opened ? 'done' : ''}`, onclick: () => actions.openPlanItem(plan.id, it.di, it.ii) },
      el('span', { class: 'box', 'aria-hidden': 'true' }, it.opened ? icon('check') : null),
      el('span', { class: 'check-day' }, `D${it.day}`),
      el('span', { class: 'check-title' }, it.title))))),
    plan.threadId ? el('a', { class: 'link-btn', href: `#/teacher/${plan.threadId}` }, 'Open the conversation', icon('arrow-right')) : null);
}

/** One line of reading history: status, title, metadata. */
export function readRow(l, data) {
  const course = l.courseId ? data.courses.find((c) => c.id === l.courseId) : null;
  const state = l.finished ? 'Finished' : l.status === 'complete' ? (l.readPage > 1 ? `Page ${l.readPage}` : 'In progress') : l.status === 'failed' ? 'Failed' : l.status === 'new' ? 'Not started' : 'Unfinished';
  return el('a', { class: 'row', href: `#/lesson/${l.id}` },
    el('span', { class: `dotmark ${l.finished ? 'done' : l.status === 'complete' ? 'ready' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'row-title' }, l.title || l.topic),
    el('span', { class: 'row-meta' }, [state, readingMinutes(l.markdown) ? `${readingMinutes(l.markdown)} min` : null, course?.title, relTime(l.updatedAt)].filter(Boolean).join(' · ')));
}

export { courseProgress, deckStats };
