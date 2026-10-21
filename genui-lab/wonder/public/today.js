// Today (#/): the home screen. A greeting with the daily goal ring and the week's streak, one
// omnibox to start a lesson, plan a course or ask the Teacher, a single best "Up next" action
// (progress-core upNext), the saved study plan and recent lessons.

import { el, icon, toast, progressRing, relTime } from './ui.js';
import { currentStreak } from './deck.js';
import { dailyProgress, weekStrip, upNext, suggestedTopics, greeting, courseProgress } from './progress-core.js';
import { pageCount } from './steering-core.js';

const MODES = [
  { id: 'lesson', label: 'Lesson', icon: 'play', placeholder: 'What do you want to learn? e.g. How do vaccines work?', hint: 'A 5–10 minute interactive lesson' },
  { id: 'course', label: 'Course', icon: 'layers', placeholder: 'A bigger subject, e.g. Statistics from scratch', hint: 'A path of short lessons' },
  { id: 'teacher', label: 'Ask Teacher', icon: 'teacher', placeholder: 'e.g. Plan my week to learn the basics of Spanish', hint: 'Plans, quizzes and advice' },
];

/**
 * @param {{app: HTMLElement, store: object, status: object, actions: object}} ctx
 *   actions: startLesson(topic, level), planCourse(topic, level) → Promise, askTeacher(text),
 *            openPlanItem(planId, dayIndex, itemIndex), openCourseLesson(courseId, si, li)
 */
export function renderToday(ctx) {
  const { app, store, status, actions } = ctx;
  const d = store.data;
  const settings = d.settings || {};
  const now = new Date();
  const day = dailyProgress(d.stats, settings, now);
  const streak = currentStreak(d.stats, now);
  const name = String(settings.name || '').trim();

  // -- header: greeting + goal ring + week
  const sub = day.met
    ? `Daily goal reached${streak > 1 ? ` · ${streak} days in a row` : ''}. Anything else is a bonus.`
    : day.xp > 0
      ? `${day.goal - day.xp} XP to go for today’s goal.`
      : streak > 0
        ? `Keep your ${streak}-day streak going: any lesson or review counts.`
        : 'Pick up where you left off, or learn something new.';
  const head = el('header', { class: 'today-head' },
    el('div', null,
      el('p', { class: 'eyebrow' }, now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })),
      el('h1', { class: 'h-xl' }, `${greeting(now)}${name ? ', ' : '.'}`, name ? el('em', null, name) : null, name ? '.' : null),
      el('p', { class: 'today-sub' }, sub)),
    el('a', { class: 'card goal-card', href: '#/you', 'aria-label': `Daily goal ${day.xp} of ${day.goal} XP, ${streak} day streak` },
      progressRing(day.pct, [String(day.xp), el('small', null, `of ${day.goal} XP`)], { cls: 'lg' }),
      el('div', { class: 'goal-card-text' },
        el('strong', null, icon('flame'), ' ', streak ? `${streak}-day streak` : 'No streak yet'),
        el('div', { class: 'week', 'aria-hidden': 'true' }, ...weekStrip(d.stats, settings, now).map((w) => el('span', { class: `week-day ${w.active ? 'active' : ''} ${w.met ? 'met' : ''} ${w.today ? 'today' : ''}`, title: `${w.key}: ${w.xp} XP` },
          el('span', { class: 'week-dot' }, w.met ? icon('check') : null), w.label))),
        el('span', { class: 'muted small' }, day.met ? 'Goal met today' : 'Reach your goal to fill the dot'))));

  // -- omnibox
  let mode = 'lesson';
  let level = 'beginner';
  const input = el('textarea', { rows: '1', maxlength: '300', 'aria-label': 'What do you want to learn?' });
  const sendBtn = el('button', { class: 'btn omni-send', type: 'submit', 'aria-label': 'Start' }, icon('arrow-right'));
  const levelSeg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Level' },
    ...['beginner', 'intermediate', 'advanced'].map((lv) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(lv === level), class: 'seg-btn', onclick: (e) => {
      level = lv;
      for (const b of levelSeg.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
    } }, lv[0].toUpperCase() + lv.slice(1))));
  const hint = el('span', { class: 'omni-hint' });
  const tabs = el('div', { class: 'omni-tabs', role: 'tablist', 'aria-label': 'What to start' }, ...MODES.map((m) => el('button', {
    class: 'omni-tab', type: 'button', role: 'tab', 'aria-selected': String(m.id === mode), dataset: { mode: m.id },
    onclick: () => { setMode(m.id); input.focus(); },
  }, icon(m.icon), m.label)));
  function setMode(m) {
    mode = m;
    const def = MODES.find((x) => x.id === m);
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    input.placeholder = def.placeholder;
    hint.replaceChildren(icon(def.icon), def.hint);
    levelSeg.hidden = m === 'teacher';
  }
  setMode('lesson');
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(180, input.scrollHeight)}px`; };
  input.addEventListener('input', autosize);
  async function submit() {
    const t = input.value.trim();
    if (!t) { input.focus(); toast(mode === 'teacher' ? 'Type a message first' : 'Type a topic first'); return; }
    if (mode === 'lesson') actions.startLesson(t, level);
    else if (mode === 'teacher') actions.askTeacher(t);
    else {
      sendBtn.disabled = true;
      sendBtn.classList.add('loading');
      hint.replaceChildren(el('span', { class: 'reasoning-dot', 'aria-hidden': 'true' }), 'Planning your course…');
      const ok = await actions.planCourse(t, level);
      if (!ok) { sendBtn.disabled = false; sendBtn.classList.remove('loading'); setMode('course'); }
    }
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  const omni = el('form', { class: 'card omni', onsubmit: (e) => { e.preventDefault(); submit(); } },
    tabs,
    el('div', { class: 'omni-field' }, input, sendBtn),
    el('div', { class: 'omni-foot' }, hint, levelSeg));
  const suggestions = el('div', { class: 'suggest-row', 'aria-label': 'Suggested topics' },
    el('span', { class: 'h-sm' }, settings.interests?.length ? 'For you' : 'Try'),
    ...suggestedTopics(settings, d.lessons, now, 5).map((t) => el('button', { class: 'topic-chip', type: 'button', onclick: () => actions.startLesson(t, level) }, t)));

  // -- up next
  const next = upNext(d, now);
  const upSection = el('section', { class: 'section', 'aria-label': 'Up next' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Up next')),
    el('div', { class: 'up-grid' }, heroCard(next[0], ctx), next.length > 1 ? el('div', { class: 'up-side' }, ...next.slice(1, 4).map((n) => sideItem(n, ctx))) : quickLinks(ctx)));

  // -- saved study plan
  const plan = (d.plans || [])[0];
  const planSection = plan ? el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Your study plan'), plan.threadId ? el('a', { class: 'link-btn', href: `#/teacher/${plan.threadId}` }, 'Open chat', icon('arrow-right')) : null),
    el('div', { class: 'card plan-card' },
      el('strong', { class: 'plan-goal' }, plan.goal),
      el('ol', { class: 'plan-days' }, ...(plan.days || []).map((dd, di) => {
        const done = (dd.items || []).every((i) => i.opened);
        return el('li', { class: 'plan-day' },
          el('span', { class: `plan-num ${done ? 'done' : ''}` }, done ? icon('check') : String(dd.day || di + 1)),
          el('div', { class: 'plan-body' },
            el('span', { class: 'plan-focus' }, dd.focus),
            el('div', { class: 'plan-items' }, ...(dd.items || []).map((it, ii) => el('button', { class: `plan-item ${it.opened ? 'opened' : ''}`, type: 'button', onclick: () => actions.openPlanItem(plan.id, di, ii) },
              it.opened ? icon('check') : icon(it.kind === 'review' ? 'repeat' : it.kind === 'quiz' ? 'sparkles' : 'book'), it.title)))));
      })))) : null;

  // -- recent lessons
  const recent = Object.values(d.lessons).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  const recentSection = recent.length ? el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Recent'), el('a', { class: 'link-btn', href: '#/library' }, 'Library', icon('arrow-right'))),
    el('div', { class: 'rail' }, ...recent.map((l) => lessonTile(l, d)))) : null;

  app.replaceChildren(el('div', { class: 'today' }, head, el('div', null, omni, suggestions), upSection, planSection, recentSection));
  if (status.mode && !recent.length) setTimeout(() => input.focus({ preventScroll: true }), 60);
}

function heroCard(n, ctx) {
  const { actions, store } = ctx;
  const card = (eyebrow, title, body, buttons, meta) => el('article', { class: 'card up-hero' },
    el('div', { style: { display: 'grid', gap: '10px' } }, el('p', { class: 'eyebrow' }, eyebrow), el('h3', { class: 'h-lg' }, title), body ? el('p', { class: 'muted' }, body) : null),
    el('div', { style: { display: 'grid', gap: '14px' } }, meta || null, el('div', { class: 'up-hero-actions' }, ...buttons)));
  if (n.kind === 'continue') {
    const l = store.data.lessons[n.lessonId];
    const pages = pageCount(l?.markdown);
    const course = n.courseId ? store.data.courses.find((c) => c.id === n.courseId) : null;
    return card(n.interrupted ? 'Pick up where it stopped' : 'Continue reading', n.title,
      n.interrupted ? 'This lesson stopped before the end. Resume it and Wonder carries on from the last paragraph.' : null,
      [el('a', { class: 'btn btn-lg', href: `#/lesson/${n.lessonId}` }, icon('play'), n.interrupted ? 'Resume lesson' : 'Continue')],
      el('div', { class: 'up-meta' },
        pages ? el('span', { class: 'tag brand' }, icon('book'), n.page > 1 ? `Page ${n.page} of ${pages}` : `${pages} pages`) : null,
        course ? el('span', null, course.title) : null,
        l?.updatedAt ? el('span', { class: 'faint' }, relTime(l.updatedAt)) : null));
  }
  if (n.kind === 'review') {
    return card('Review', `${n.due} card${n.due === 1 ? ' is' : 's are'} ready to review`, 'A few minutes now, right before you would forget, is what makes it stick.',
      [el('a', { class: 'btn btn-lg', href: '#/review' }, icon('repeat'), 'Start review')],
      el('div', { class: 'up-meta' }, el('span', { class: 'tag amber' }, icon('clock'), `About ${Math.max(1, Math.round(Math.min(n.due, 12) * 0.4))} min`)));
  }
  if (n.kind === 'plan') {
    return card(`Day ${n.day} of your plan`, n.title, n.goal,
      [el('button', { class: 'btn btn-lg', type: 'button', onclick: () => actions.openPlanItem(n.planId, n.dayIndex, n.itemIndex) }, icon(n.itemKind === 'review' ? 'repeat' : n.itemKind === 'quiz' ? 'sparkles' : 'play'), n.itemKind === 'quiz' ? 'Quiz me' : n.itemKind === 'review' ? 'Review' : 'Start')]);
  }
  if (n.kind === 'course') {
    return card(n.courseTitle, n.title, n.summary,
      [el('button', { class: 'btn btn-lg', type: 'button', onclick: () => actions.openCourseLesson(n.courseId, n.si, n.li) }, icon('play'), n.done ? 'Next lesson' : 'Start course'),
        el('a', { class: 'btn btn-ghost', href: `#/course/${n.courseId}` }, 'View course')],
      el('div', { class: 'course-progress' }, el('span', { class: 'progress small-progress' }, el('span', { class: 'progress-fill', style: { width: `${n.total ? (n.done / n.total) * 100 : 0}%` } })), el('span', { class: 'small muted' }, `${n.done} of ${n.total}`)));
  }
  const topics = suggestedTopics(store.data.settings, store.data.lessons, new Date(), 2);
  return card(n.first ? 'Start here' : 'All caught up', n.first ? 'Your first lesson takes about 10 minutes' : 'Nothing due. Learn something new?',
    'Lessons are written for you on the spot, with interactive diagrams, a quiz at the end, and a tutor you can ask anything.',
    topics.map((t, i) => el('button', { class: `btn ${i ? 'btn-secondary' : ''}`, type: 'button', onclick: () => actions.startLesson(t, 'beginner') }, i ? null : icon('play'), t)));
}

function sideItem(n, ctx) {
  const { actions } = ctx;
  const row = (tile, title, sub, onclick, href) => {
    const attrs = { class: 'card up-item' };
    const kids = [tile, el('span', { class: 'up-item-text' }, el('strong', null, title), el('span', { class: 'muted small' }, sub)), icon('chevron')];
    return href ? el('a', { ...attrs, href }, ...kids) : el('button', { ...attrs, type: 'button', onclick }, ...kids);
  };
  if (n.kind === 'review') return row(el('span', { class: 'icon-tile amber' }, icon('repeat')), `Review ${n.due} card${n.due === 1 ? '' : 's'}`, 'Due now', null, '#/review');
  if (n.kind === 'plan') return row(el('span', { class: 'icon-tile green' }, icon('calendar')), n.title, `Day ${n.day} of your plan`, () => actions.openPlanItem(n.planId, n.dayIndex, n.itemIndex));
  if (n.kind === 'course') return row(el('span', { class: 'icon-tile' }, icon('layers')), n.title, `Next in ${n.courseTitle}`, () => actions.openCourseLesson(n.courseId, n.si, n.li));
  if (n.kind === 'continue') return row(el('span', { class: 'icon-tile' }, icon('book')), n.title, 'Continue reading', null, `#/lesson/${n.lessonId}`);
  return el('span');
}

function quickLinks(ctx) {
  const { actions } = ctx;
  return el('div', { class: 'up-side' },
    el('a', { class: 'card up-item', href: '#/teacher' }, el('span', { class: 'icon-tile' }, icon('teacher')), el('span', { class: 'up-item-text' }, el('strong', null, 'Plan with your Teacher'), el('span', { class: 'muted small' }, 'A study plan around your goal')), icon('chevron')),
    el('button', { class: 'card up-item', type: 'button', onclick: () => actions.askTeacher('What should I study today?') }, el('span', { class: 'icon-tile green' }, icon('sparkles')), el('span', { class: 'up-item-text' }, el('strong', null, 'What should I study today?'), el('span', { class: 'muted small' }, 'Ask the Teacher')), icon('chevron')),
    el('a', { class: 'card up-item', href: '#/you' }, el('span', { class: 'icon-tile flame' }, icon('target')), el('span', { class: 'up-item-text' }, el('strong', null, 'Set your daily goal'), el('span', { class: 'muted small' }, 'And what Wonder remembers')), icon('chevron')));
}

export function lessonTile(l, data) {
  const course = l.courseId ? data.courses.find((c) => c.id === l.courseId) : null;
  const state = l.finished ? ['green', 'check', 'Finished'] : l.status === 'complete' ? ['brand', 'book', 'In progress'] : l.status === 'failed' ? ['amber', 'x', 'Failed'] : ['amber', 'clock', l.status === 'new' ? 'Not started' : 'Unfinished'];
  return el('a', { class: 'card lesson-tile', href: `#/lesson/${l.id}` },
    el('span', { class: `tag ${state[0]}` }, icon(state[1]), state[2]),
    el('span', { class: 'lesson-tile-title' }, l.title || l.topic),
    el('span', { class: 'lesson-tile-meta' },
      course ? el('span', null, course.title) : el('span', null, (l.level || 'beginner').replace(/^./, (c) => c.toUpperCase())),
      l.quizScore?.total ? el('span', null, `· Quiz ${l.quizScore.score}/${l.quizScore.total}`) : null,
      el('span', { style: { marginLeft: 'auto' } }, relTime(l.updatedAt))));
}

export { courseProgress };
