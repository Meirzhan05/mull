// Wonder client: home, course map, streamed DIL lesson + tutor, pack opening, review,
// Teacher (agent chat with tool cards) and learner memory.

import { createStore, uid } from './store.js';
import { DilSurface, mergeComponentResults } from './dil-surface.js';
import { streamTurn, postJson } from './stream-client.js';
import { addItems, deckStats, awardXp, currentStreak, formatDue, XP } from './deck.js';
import { normalizePracticeItem } from './practice-core.js';
import { renderReview } from './review.js';
import { el, icon, toast, inlineMd, lessonTitleFrom } from './ui.js';
import { observeMath } from './math.js';
import { renderTeacher, queueTeacherMessage } from './teacher-screen.js';
import { renderMemory } from './memory-screen.js';
import { createSteerBar } from './steer-bar.js'; // Phase 4
import { lessonPhase, statusAfterStop, carryOver, mergeContinuedAppData, sourcesFromAppData, pageCount, pageTitles } from './steering-core.js';

const store = createStore();
const PAGE_ID = uid('page'); // this page load: a 'streaming' lesson owned by another id was interrupted
const app = document.getElementById('app');
let status = { mode: 'demo', model: 'claude-opus-5-5' };
let teardown = [];

const TOPIC_CHIPS = [
  'How transformers predict the next word',
  'Why the sky is blue',
  'Compound interest',
  'How vaccines train your immune system',
  'Black holes for beginners',
];

// ------------------------------------------------------------------ chrome

function refreshChrome() {
  const s = store.data.stats;
  document.getElementById('streak-count').textContent = String(currentStreak(s));
  document.getElementById('xp-count').textContent = String(s.xp);
  document.getElementById('streak-chip').classList.toggle('lit', currentStreak(s) > 0);
}

function giveXp(amount, why) {
  if (amount <= 0) return;
  store.update((d) => { d.stats = awardXp(d.stats, amount); return d; });
  refreshChrome();
  const chip = document.getElementById('xp-chip');
  chip.classList.remove('bump');
  void chip.offsetWidth;
  chip.classList.add('bump');
  toast(`+${amount} XP${why ? ` · ${why}` : ''}`);
}

const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
function initTheme() {
  let t = 'system';
  try { t = localStorage.getItem('wonder.theme') || 'system'; } catch {}
  applyTheme(t);
  document.getElementById('theme-btn').addEventListener('click', () => {
    t = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    applyTheme(t);
    try { localStorage.setItem('wonder.theme', t); } catch {}
    toast(`Theme: ${t}`);
  });
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    status = await r.json();
  } catch { status = { mode: 'demo', model: 'claude-opus-5-5' }; }
  document.getElementById('demo-banner').hidden = status.mode !== 'demo';
}

const memoryEnabled = () => store.data.settings?.memoryEnabled !== false;

/** Shared context for the screens that live in their own modules. */
const screenCtx = () => ({ app, store, status, teardown, createLesson, giveXp, reroute: route });

function cleanupScreen() {
  for (const fn of teardown.splice(0)) { try { fn(); } catch {} }
}

// ------------------------------------------------------------------ data helpers

function createLesson(fields) {
  const id = uid('lesson');
  const now = new Date().toISOString();
  store.update((d) => {
    d.lessons[id] = { id, status: 'new', markdown: '', dil: null, appData: null, tutor: [], finished: false, createdAt: now, updatedAt: now, ...fields };
    return d;
  });
  return id;
}

function saveLesson(id, patch) {
  store.update((d) => {
    if (d.lessons[id]) d.lessons[id] = { ...d.lessons[id], ...patch, updatedAt: new Date().toISOString() };
    return d;
  });
}

function courseProgress(course) {
  let done = 0;
  let total = 0;
  for (const s of course.sections) for (const l of s.lessons) { total++; if (l.lessonId && store.data.lessons[l.lessonId]?.finished) done++; }
  return { done, total };
}

// ------------------------------------------------------------------ home

function renderHome() {
  const d = store.data;
  const stats = deckStats(d.deck);
  let level = 'beginner';
  const input = el('textarea', { id: 'topic', rows: '2', maxlength: '300', placeholder: 'e.g. How do vaccines work? Bayes’ theorem? The French Revolution?', 'aria-label': 'What do you want to learn?' });
  const lessonBtn = el('button', { class: 'btn', type: 'submit' }, icon('play'), 'Start lesson');
  const courseBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, icon('layers'), 'Plan a course');
  const levels = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Level' },
    ...['beginner', 'intermediate', 'advanced'].map((lv) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(lv === level), class: 'seg-btn', onclick: (e) => {
      level = lv;
      for (const b of levels.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
    } }, lv[0].toUpperCase() + lv.slice(1))));

  const startLesson = (topic) => {
    const t = (topic ?? input.value).trim();
    if (!t) { input.focus(); toast('Type a topic first'); return; }
    const id = createLesson({ topic: t, title: t, level });
    location.hash = `#/lesson/${id}`;
  };
  const planCourse = async () => {
    const t = input.value.trim();
    if (!t) { input.focus(); toast('Type a topic first'); return; }
    courseBtn.disabled = true;
    courseBtn.classList.add('loading');
    courseBtn.lastChild.textContent = 'Planning…';
    try {
      const { plan } = await postJson('/api/course/plan', { topic: t, level });
      const id = uid('course');
      store.update((dd) => {
        dd.courses.unshift({ id, title: plan.title, description: plan.description, level, topic: t, createdAt: new Date().toISOString(), sections: plan.sections.map((s) => ({ title: s.title, lessons: s.lessons.map((l) => ({ ...l, lessonId: null })) })) });
        return dd;
      });
      location.hash = `#/course/${id}`;
    } catch (e) {
      toast(e.message || 'Could not plan a course');
      courseBtn.disabled = false;
      courseBtn.classList.remove('loading');
      courseBtn.lastChild.textContent = 'Plan a course';
    }
  };
  courseBtn.addEventListener('click', planCourse);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startLesson(); } });

  const hero = el('section', { class: 'hero card' },
    el('p', { class: 'eyebrow' }, status.mode === 'claude' ? 'Lessons written live by Claude' : 'Interactive lessons'),
    el('h1', { class: 'h-xl' }, 'What do you want to learn?'),
    el('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); startLesson(); } },
      input,
      el('div', { class: 'composer-row' }, levels, el('div', { class: 'composer-actions' }, courseBtn, lessonBtn))),
    el('div', { class: 'chips', 'aria-label': 'Suggested topics' }, ...TOPIC_CHIPS.map((t) => el('button', { class: 'topic-chip', type: 'button', onclick: () => startLesson(t) }, t))));

  const nav = el('nav', { class: 'home-nav', 'aria-label': 'More' },
    el('a', { class: 'card nav-tile', href: '#/teacher' },
      el('span', { class: 'course-icon', 'aria-hidden': 'true' }, icon('teacher')),
      el('span', { class: 'nav-text' }, el('strong', null, 'Teacher'), el('span', { class: 'muted small' }, 'Plan your week, get the next lesson, get quizzed')),
      icon('arrow-right')),
    el('a', { class: 'card nav-tile', href: '#/memory' },
      el('span', { class: 'course-icon', 'aria-hidden': 'true' }, icon('brain')),
      el('span', { class: 'nav-text' }, el('strong', null, 'Memory'), el('span', { class: 'muted small' }, memoryEnabled() ? 'What Wonder knows about you' : 'Off: lessons are not personalized')),
      icon('arrow-right')));

  const plan = (d.plans || [])[0];
  const openPlanItem = (di, ii) => {
    const it = plan.days[di].items[ii];
    store.update((dd) => { const pl = dd.plans.find((x) => x.id === plan.id); if (pl) pl.days[di].items[ii].opened = true; return dd; });
    if (it.kind === 'review') { location.hash = '#/review'; return; }
    if (it.kind === 'quiz') { queueTeacherMessage(`Quiz me on ${it.topic || it.title}.`); location.hash = plan.threadId ? `#/teacher/${plan.threadId}` : '#/teacher'; return; }
    const known = store.data.teacherLessons?.[`${plan.id}:${it.id}`];
    if (known && store.data.lessons[known]) { location.hash = `#/lesson/${known}`; return; }
    const id = createLesson({ topic: it.topic || it.title, title: it.title, level: 'beginner', teacherThreadId: plan.threadId });
    store.update((dd) => { dd.teacherLessons = { ...(dd.teacherLessons || {}), [`${plan.id}:${it.id}`]: id }; return dd; });
    location.hash = `#/lesson/${id}`;
  };
  const planSection = plan ? el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Your study plan'), plan.threadId ? el('a', { class: 'small muted', href: `#/teacher/${plan.threadId}` }, 'Open chat') : null),
    el('div', { class: 'card plan-card' },
      el('strong', { class: 'plan-goal' }, plan.goal),
      el('ol', { class: 'plan-days' }, ...plan.days.map((day, di) => el('li', { class: 'plan-day' },
        el('span', { class: `plan-num ${day.items.every((i) => i.opened) ? 'done' : ''}` }, day.items.every((i) => i.opened) ? icon('check') : String(day.day || di + 1)),
        el('div', { class: 'plan-body' },
          el('span', { class: 'plan-focus' }, day.focus),
          el('div', { class: 'plan-items' }, ...day.items.map((it, ii) => el('button', { class: `plan-item ${it.opened ? 'opened' : ''}`, type: 'button', onclick: () => openPlanItem(di, ii) },
            it.opened ? icon('check') : icon(it.kind === 'review' ? 'repeat' : it.kind === 'quiz' ? 'sparkles' : 'book'), it.title))))))))) : null;

  const reviewCard = el('section', { class: 'card review-cta' },
    el('div', { class: 'review-cta-text' },
      el('h2', { class: 'h-md' }, 'Practice'),
      el('p', { class: 'muted' }, stats.total
        ? `${stats.total} card${stats.total === 1 ? '' : 's'} in your deck · ${stats.review} mastered${stats.due ? '' : stats.nextDue ? ` · next due ${formatDue(stats.nextDue)}` : ''}`
        : 'Finish a lesson to unlock knowledge cards. Wonder schedules reviews with FSRS so you see each card right before you’d forget it.')),
    el('button', { class: 'btn btn-lg', type: 'button', disabled: !stats.due, onclick: () => { location.hash = '#/review'; } }, icon('repeat'), `Review due (${stats.due})`));

  const courses = d.courses.slice(0, 12);
  const courseSection = el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Your courses')),
    courses.length
      ? el('div', { class: 'course-grid' }, ...courses.map((c) => {
        const p = courseProgress(c);
        return el('a', { class: 'card course-card', href: `#/course/${c.id}` },
          el('span', { class: 'course-icon', 'aria-hidden': 'true' }, icon('book')),
          el('strong', { class: 'course-title' }, c.title),
          el('span', { class: 'muted small' }, `${p.done} of ${p.total} lessons`),
          el('span', { class: 'progress small-progress' }, el('span', { class: 'progress-fill', style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })));
      }))
      : el('p', { class: 'muted empty-line' }, 'No courses yet. Type a topic and press “Plan a course”.'));

  const lessons = Object.values(d.lessons).filter((l) => !l.courseId).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 8);
  const lessonSection = lessons.length ? el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Recent lessons')),
    el('ul', { class: 'lesson-list' }, ...lessons.map((l) => el('li', null, el('a', { class: 'lesson-row', href: `#/lesson/${l.id}` },
      el('span', { class: `status-dot ${l.finished ? 'done' : l.status === 'complete' ? 'ready' : 'pending'}`, 'aria-hidden': 'true' }),
      el('span', { class: 'lesson-row-title' }, l.title || l.topic),
      el('span', { class: 'muted small' }, l.finished ? 'Finished' : l.status === 'complete' ? 'Ready' : lessonPhase(l, { pageId: PAGE_ID }) === 'interrupted' ? 'Interrupted' : 'Unfinished'),
      icon('arrow-right')))))) : null;

  app.replaceChildren(el('div', { class: 'home' }, hero, nav, planSection, reviewCard, courseSection, lessonSection));
}

// ------------------------------------------------------------------ course

function renderCourse(courseId) {
  const course = store.data.courses.find((c) => c.id === courseId);
  if (!course) return notFound();
  const p = courseProgress(course);
  let n = 0;
  const open = (si, li) => {
    const entry = course.sections[si].lessons[li];
    let lessonId = entry.lessonId && store.data.lessons[entry.lessonId] ? entry.lessonId : null;
    if (!lessonId) {
      lessonId = createLesson({ topic: entry.title, title: entry.title, level: course.level, courseId, sectionIndex: si, lessonIndex: li, lessonTitle: entry.title, lessonSummary: entry.summary, course: { title: course.title } });
      store.update((d) => { const c = d.courses.find((x) => x.id === courseId); c.sections[si].lessons[li].lessonId = lessonId; return d; });
    }
    location.hash = `#/lesson/${lessonId}`;
  };
  const firstOpen = (() => { for (const [si, s] of course.sections.entries()) for (const [li, l] of s.lessons.entries()) if (!(l.lessonId && store.data.lessons[l.lessonId]?.finished)) return `${si}:${li}`; return null; })();
  app.replaceChildren(el('div', { class: 'course' },
    el('a', { class: 'back-link', href: '#/' }, icon('arrow-left'), 'Home'),
    el('header', { class: 'course-head card' },
      el('p', { class: 'eyebrow' }, `${course.level || 'beginner'} course`),
      el('h1', { class: 'h-xl' }, course.title),
      course.description ? el('p', { class: 'muted' }, course.description) : null,
      el('div', { class: 'course-progress' }, el('span', { class: 'progress' }, el('span', { class: 'progress-fill', style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })), el('span', { class: 'small muted' }, `${p.done}/${p.total} done`))),
    ...course.sections.map((s, si) => el('section', { class: 'path-section' },
      el('h2', { class: 'h-md path-title' }, s.title),
      el('ol', { class: 'path' }, ...s.lessons.map((l, li) => {
        n++;
        const lesson = l.lessonId ? store.data.lessons[l.lessonId] : null;
        const done = !!lesson?.finished;
        const current = firstOpen === `${si}:${li}`;
        return el('li', { class: `path-node ${done ? 'done' : ''} ${current ? 'current' : ''}` },
          el('button', { class: 'node-dot', type: 'button', 'aria-label': `Open lesson ${n}: ${l.title}`, onclick: () => open(si, li) }, done ? icon('check') : String(n)),
          el('div', { class: 'node-body' },
            el('strong', null, l.title),
            l.summary ? el('span', { class: 'muted small' }, l.summary) : null),
          el('button', { class: `btn ${current ? '' : 'btn-secondary'} btn-sm`, type: 'button', onclick: () => open(si, li) }, done ? 'Revisit' : lesson?.status === 'complete' ? 'Continue' : lesson && lessonPhase(lesson, { pageId: PAGE_ID }) === 'interrupted' ? 'Resume' : 'Start'));
      }))))));
}

// ------------------------------------------------------------------ lesson

function renderLesson(lessonId) {
  const lesson = store.data.lessons[lessonId];
  if (!lesson) return notFound();
  const ac = new AbortController();
  teardown.push(() => ac.abort());

  const back = lesson.courseId ? `#/course/${lesson.courseId}` : '#/';
  const progressFill = el('span', { class: 'progress-fill' });
  const titleEl = el('span', { class: 'lesson-bar-title' }, lesson.title || lesson.topic);
  const reasoning = el('div', { class: 'reasoning', role: 'status', 'aria-live': 'polite', hidden: true }, el('span', { class: 'reasoning-dot', 'aria-hidden': 'true' }), el('span', { class: 'reasoning-text shimmer' }));
  const mount = el('div', { class: 'lesson-dil' });
  const errorBox = el('div', { class: 'card error-card', hidden: true });
  const finishBtn = el('button', { class: 'btn btn-lg', type: 'button', disabled: true }, icon('sparkles'), 'Finish lesson');
  const finishHint = el('p', { class: 'muted small' }, 'Finish to collect knowledge cards for your review deck.');
  // Phase 4: live steer (top, under the reasoning line), resume (top) and revise (sticky, after the lesson)
  const steerBar = createSteerBar({
    onContinue: (req) => continueLesson(req),
    onOpen: () => onPageScroll(),
    onMode: (mode, node) => { if (!node.parentNode) return; if (mode === 'revise') errorBox.before(node); else reasoning.after(node); },
  });
  const tutorToggle = el('button', { class: 'btn btn-secondary btn-sm tutor-toggle', type: 'button', 'aria-expanded': 'false' }, icon('chat'), el('span', null, 'Ask tutor'));

  const lessonMain = el('div', { class: 'lesson-main' },
    el('div', { class: 'lesson-bar' },
      el('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, icon('arrow-left')),
      el('div', { class: 'lesson-bar-mid' }, titleEl, el('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Lesson progress' }, progressFill)),
      tutorToggle),
    reasoning,
    steerBar.el,
    el('article', { class: 'lesson-card card' }, mount),
    errorBox,
    el('div', { class: 'lesson-footer' }, finishBtn, finishHint));

  const tutor = createTutor(lessonId);
  const layout = el('div', { class: 'lesson-layout' }, lessonMain, tutor.panel, tutor.fab);
  app.replaceChildren(layout);
  teardown.push(() => tutor.destroy());
  const setTutorOpen = (open) => {
    layout.classList.toggle('tutor-open', open);
    tutorToggle.setAttribute('aria-expanded', String(open));
    tutor.fab.hidden = open;
    if (open) tutor.focus();
  };
  tutor.onOpenChange = setTutorOpen;
  tutorToggle.addEventListener('click', () => setTutorOpen(!layout.classList.contains('tutor-open')));
  if (window.innerWidth >= 1180 && (lesson.tutor || []).length) setTutorOpen(true);

  // -- DIL surface + widget actions
  let current = { dil: lesson.dil, appData: lesson.appData };
  const surface = new DilSurface(mount, { onAction: (a) => handleAction(a), onError: (e) => console.warn('[dil]', e.phase, e.message) });
  teardown.push(() => surface.destroy());
  const appDataFor = () => mergeComponentResults(current.dil?.appData, current.appData?.opGenui?.componentResults);

  async function handleAction(a) {
    if (a.handler === 'server') {
      try {
        const res = await postJson('/api/widget_action', { componentName: a.componentName, action_type: a.type, payload: a.payload, resolutionId: a.nativeWidgetResolutionId });
        if (res.componentResults) {
          current.appData = mergeComponentResults(current.appData, res.componentResults);
          saveLesson(lessonId, { appData: current.appData });
          surface.setAppData(appDataFor());
        }
        if (res.issueTurn?.message) { setTutorOpen(true); tutor.send(res.issueTurn.message); }
      } catch (e) { console.warn('widget action failed', e.message); }
      return;
    }
    handleClientAction(a, { lessonId, openTutor: () => setTutorOpen(true), tutor });
  }

  // -- progress
  const onScroll = () => {
    if (store.data.lessons[lessonId]?.status !== 'complete') return;
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    progressFill.style.width = `${max > 0 ? Math.min(100, (h.scrollTop / max) * 100) : 0}%`;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  teardown.push(() => window.removeEventListener('scroll', onScroll));

  function markComplete() {
    finishBtn.disabled = false;
    const l = store.data.lessons[lessonId];
    if (l.finished) { finishBtn.lastChild.textContent = 'Lesson finished'; finishBtn.classList.add('btn-secondary'); finishHint.textContent = 'Cards from this lesson are in your deck. Revisit any time.'; }
    reasoning.hidden = true;
    onScroll();
  }

  finishBtn.addEventListener('click', () => finishLesson(lessonId, finishBtn));

  // -- streaming, resume and revise (Phase 4). Persisted lesson.status: 'new' | 'streaming'
  // (streamOwner = PAGE_ID) | 'interrupted' | 'complete' | 'failed' (see steering-core lessonPhase).
  let streaming = false;
  let queued = null; // a continuation requested while a stream is still finishing
  let failNote = '';

  // The "## " page in view (revise mode): the last page heading above 40% of the viewport.
  const onPageScroll = () => {
    if (steerBar.mode !== 'revise') return;
    const heads = [...mount.querySelectorAll(':scope > h2[data-d-component="title"]')];
    const line = window.innerHeight * 0.4;
    let n = 1;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top < line) n = i + 1; });
    steerBar.setPage(n, pageTitles(store.data.lessons[lessonId]?.markdown)[n - 1] || heads[n - 1]?.textContent || '');
  };
  window.addEventListener('scroll', onPageScroll, { passive: true });
  teardown.push(() => window.removeEventListener('scroll', onPageScroll));

  function showInterrupted(note = '') {
    reasoning.hidden = true;
    progressFill.style.width = `${Math.min(92, 6 + pageCount(store.data.lessons[lessonId]?.markdown) * 18)}%`;
    steerBar.setMode('resume');
    if (note) steerBar.setStatus(note);
  }

  const phase = lessonPhase(lesson, { pageId: PAGE_ID });
  if (phase === 'complete') {
    surface.render({ code: lesson.dil.code, constants: lesson.dil.constants, appData: appDataFor() });
    markComplete();
    steerBar.setMode('revise');
    requestAnimationFrame(onPageScroll);
  } else if (phase === 'interrupted' || phase === 'streaming') {
    // reload, closed tab or dropped connection mid-lesson: show what was written, offer Resume
    if (lesson.dil) surface.render({ code: lesson.dil.code, constants: lesson.dil.constants, appData: appDataFor() });
    if (lesson.status !== 'interrupted') saveLesson(lessonId, { status: 'interrupted', streamOwner: null });
    showInterrupted(lesson.interruptedReason || '');
  } else {
    runStream();
  }

  /** Resume (no instruction), steer after a reload, or revise from page N: POST {continueFrom}. */
  function continueLesson({ instruction = '', fromPage } = {}) {
    if (streaming) { queued = { instruction, fromPage }; return; }
    const l = store.data.lessons[lessonId];
    if (!String(l?.markdown || '').trim()) { runStream(); return; }
    runStream({
      markdown: l.markdown,
      ...(instruction ? { instruction } : {}),
      ...(fromPage ? { fromPage } : {}),
      ...(l.messageId ? { messageId: l.messageId } : {}),
      sources: sourcesFromAppData(current.dil?.appData),
    });
  }

  async function runStream(continueFrom = null) {
    streaming = true;
    errorBox.hidden = true;
    finishBtn.disabled = true;
    const l = store.data.lessons[lessonId];
    // continuation: results of the old program, pruned to the kept pages at the first replace
    const prev = continueFrom ? { dilAppData: current.dil?.appData, widgetAppData: current.appData } : null;
    const prevPhase = continueFrom ? lessonPhase(l, { pageId: PAGE_ID }) : 'new';
    let carried = null;
    let began = !continueFrom; // has this stream replaced what is persisted yet?
    let messageId = continueFrom ? l.messageId || null : null;
    let latest = { markdown: continueFrom ? l.markdown : '', dil: continueFrom ? current.dil : null };
    let lastSave = 0;
    const persist = (status = 'streaming') => saveLesson(lessonId, { status, streamOwner: status === 'streaming' ? PAGE_ID : null, markdown: latest.markdown, dil: latest.dil, appData: current.appData, messageId, interruptedReason: null });
    let unloading = false; // a reload / closed tab rejects the fetch: that is an interruption, not an error
    const onHide = () => { unloading = true; if (streaming && began) { persist(); store.flush(); } };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    if (!continueFrom) { current.dil = null; persist(); }
    reasoning.hidden = false;
    reasoning.querySelector('.reasoning-text').textContent = continueFrom ? (continueFrom.instruction ? 'Steering…' : 'Resuming the lesson…') : 'Planning the lesson…';
    if (!continueFrom) progressFill.style.width = '4%';
    steerBar.setMode('live');
    let r = null;
    try {
      r = await streamTurn('/api/lesson/stream', {
        topic: l.topic, level: l.level, lessonTitle: l.lessonTitle, lessonSummary: l.lessonSummary, course: l.course, memoryEnabled: memoryEnabled(),
        ...(continueFrom ? { continueFrom } : {}),
      }, {
        signal: ac.signal,
        onControl: (d) => steerBar.onControl(d),
        onReasoning: (s) => {
          if (s.active === false) { reasoning.hidden = true; return; }
          reasoning.hidden = false;
          reasoning.querySelector('.reasoning-text').textContent = s.text || 'Thinking…';
        },
        onContent: (msg, rec) => {
          if (rec.messageId) messageId = rec.messageId;
          if (!began && rec.revision > 1) began = true; // rev 1 is the empty start, rev 2 the kept pages
          if (!began) return;
          const pages = pageCount(msg.markdown);
          progressFill.style.width = `${Math.min(92, 6 + pages * 18)}%`;
          if (rec.dil) {
            if (prev && !carried) {
              const c = carryOver(prev, rec.dil); // old Cite pills + widget state of the kept pages only
              carried = c.carried;
              current.appData = c.widgetAppData;
            }
            current.dil = carried ? { ...rec.dil, appData: mergeContinuedAppData(carried, rec.dil.appData) } : rec.dil;
            surface.render({ code: current.dil.code, constants: current.dil.constants, appData: appDataFor() }, { animated: rec.status !== 'complete' && rec.mode !== 'replace' }); // a replace keeps the kept pages still
          }
          latest = { markdown: msg.markdown, dil: current.dil };
          const t = lessonTitleFrom(msg.markdown, '');
          if (t && titleEl.textContent !== t) titleEl.textContent = t;
          if (Date.now() - lastSave > 1000) { lastSave = Date.now(); persist(); }
        },
      });
      if (r.failure) throw Object.assign(new Error(r.failure.message || 'Generation failed'), { code: r.failure.code || 'failed' });
      const msg = r.message;
      const dil = msg.dil ? { code: msg.dil.code, constants: msg.dil.constants, appData: carried ? mergeContinuedAppData(carried, msg.dil.appData) : msg.dil.appData, requiredComponents: msg.dil.requiredComponents || [] } : null;
      current.dil = dil;
      latest = { markdown: msg.markdown, dil };
      streaming = false;
      saveLesson(lessonId, { status: 'complete', streamOwner: null, markdown: msg.markdown, dil, appData: current.appData, messageId, title: lessonTitleFrom(msg.markdown, l.title), truncated: !!r.final?.debug?.truncated, interruptedReason: null });
      store.flush();
      if (r.final?.debug?.truncated) toast('The lesson was cut short (length limit).');
      markComplete();
      steerBar.setMode('revise');
      onPageScroll();
    } catch (e) {
      streaming = false;
      if (ac.signal.aborted || unloading) { if (began) { persist('interrupted'); store.flush(); } return; }
      reasoning.hidden = true;
      if (!began) {
        // the continuation never started: the persisted lesson is unchanged
        toast(e.message || 'Could not continue the lesson');
        if (prevPhase === 'complete') { markComplete(); steerBar.setMode('revise'); } else showInterrupted();
        steerBar.fail(e.message);
        return;
      }
      const next = statusAfterStop({ markdown: latest.markdown, failureCode: e.code });
      if (next === 'interrupted') {
        // stalled / network / client-side drop: keep the pages, offer Resume (continueFrom)
        failNote = e.code ? e.message : 'The connection dropped. Resume to continue from the last complete page.';
        persist('interrupted');
        if (e.code) saveLesson(lessonId, { interruptedReason: failNote }); // a client-side drop may just be a reload: not persisted
        store.flush();
        showInterrupted(failNote);
        return;
      }
      saveLesson(lessonId, { status: 'failed', streamOwner: null });
      steerBar.hide();
      errorBox.hidden = false;
      errorBox.replaceChildren(
        el('h2', { class: 'h-md' }, 'The lesson could not be generated'),
        el('p', { class: 'muted' }, e.message || 'Something went wrong.'),
        el('button', { class: 'btn', type: 'button', onclick: () => { surface.host.clear(); runStream(); } }, icon('refresh'), 'Try again'));
    } finally {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
      if (queued && !ac.signal.aborted) { const q = queued; queued = null; continueLesson(q); }
    }
  }
}

function handleClientAction(a, { lessonId, openTutor, tutor }) {
  const p = a.payload || {};
  switch (a.type) {
    case 'issue_new_turn':
      if (p.query) { openTutor(); tutor.send(String(p.query)); }
      break;
    case 'quiz_complete': {
      const key = `${lessonId}:${p.resolutionId}`;
      if (Array.isArray(p.results)) saveLesson(lessonId, { quizResults: p.results.slice(0, 12), quizScore: { score: Number(p.score) || 0, total: Number(p.total) || 0 } });
      if (store.data.awarded?.[key]) break;
      store.update((d) => { d.awarded = { ...(d.awarded || {}), [key]: true }; return d; });
      giveXp((Number(p.score) || 0) * XP.quizCorrect, `${p.score}/${p.total} on the quiz`);
      break;
    }
    case 'save_flashcards': {
      const items = (p.cards || []).map((c) => normalizePracticeItem({ type: 'flashcard', front: c.front, back: c.back })).filter(Boolean);
      const title = store.data.lessons[lessonId]?.title || '';
      let added = 0;
      store.update((d) => { const r = addItems(d.deck, items, { lessonId, lessonTitle: title }); d.deck = r.deck; added = r.added; return d; });
      toast(added ? `${added} flashcard${added === 1 ? '' : 's'} added to your review deck` : 'Already in your deck');
      break;
    }
    case 'open_url':
      if (/^https?:\/\//i.test(p.url || '')) window.open(p.url, '_blank', 'noopener,noreferrer');
      break;
    default:
  }
}

// ------------------------------------------------------------------ tutor

function createTutor(lessonId) {
  const log = el('div', { class: 'tutor-log', 'aria-live': 'polite' });
  const followups = el('div', { class: 'followups' });
  const input = el('textarea', { rows: '1', maxlength: '2000', placeholder: 'Ask anything about this lesson…', 'aria-label': 'Message the tutor' });
  const sendBtn = el('button', { class: 'btn send-btn', type: 'submit', 'aria-label': 'Send' }, icon('send'));
  const form = el('form', { class: 'tutor-form', onsubmit: (e) => { e.preventDefault(); api.send(input.value); } }, input, sendBtn);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); api.send(input.value); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
  const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close tutor', onclick: () => api.onOpenChange?.(false) }, icon('x'));
  const empty = el('div', { class: 'tutor-empty' },
    el('span', { class: 'tutor-avatar', 'aria-hidden': 'true' }, icon('sparkles')),
    el('p', null, 'Stuck on something? Ask about any part of the lesson. I can explain differently, give examples, or quiz you.'));
  const panel = el('aside', { class: 'tutor', 'aria-label': 'Lesson tutor' },
    el('header', { class: 'tutor-head' }, el('div', null, el('strong', null, 'Ask about this lesson'), el('span', { class: 'muted small' }, status.mode === 'claude' ? 'Tutor · Claude' : 'Tutor · demo replies')), closeBtn),
    el('div', { class: 'tutor-scroll' }, empty, log, followups),
    form);
  const fab = el('button', { class: 'tutor-fab btn', type: 'button', onclick: () => api.onOpenChange?.(true) }, icon('chat'), 'Ask');
  const surfaces = [];
  let busy = false;
  let ac = null;

  const lesson = () => store.data.lessons[lessonId];
  const scrollDown = () => { const s = panel.querySelector('.tutor-scroll'); s.scrollTop = s.scrollHeight; };

  function showFollowups(list) {
    followups.replaceChildren(...(list || []).map((q) => el('button', { class: 'followup-chip', type: 'button', onclick: () => api.send(q) }, q)));
  }

  function addUser(text) {
    empty.hidden = true;
    log.append(el('div', { class: 'msg msg-user' }, el('div', { class: 'bubble' }, text)));
  }

  function addAssistant() {
    empty.hidden = true;
    const mount = el('div', { class: 'msg-dil' });
    const typing = el('div', { class: 'typing', 'aria-label': 'Tutor is typing' }, el('i'), el('i'), el('i'));
    const wrapper = el('div', { class: 'msg msg-bot' }, el('span', { class: 'tutor-avatar small', 'aria-hidden': 'true' }, icon('sparkles')), el('div', { class: 'bot-body' }, typing, mount));
    log.append(wrapper);
    let appData = {};
    let dilRef = null;
    const surface = new DilSurface(mount, {
      onAction: async (a) => {
        if (a.handler === 'server') {
          try {
            const res = await postJson('/api/widget_action', { componentName: a.componentName, action_type: a.type, payload: a.payload, resolutionId: a.nativeWidgetResolutionId });
            if (res.componentResults) { appData = mergeComponentResults(appData, res.componentResults); surface.setAppData(mergeComponentResults(dilRef?.appData, appData.opGenui.componentResults)); }
            if (res.issueTurn?.message) api.send(res.issueTurn.message);
          } catch {}
          return;
        }
        handleClientAction(a, { lessonId, openTutor: () => api.onOpenChange?.(true), tutor: api });
      },
    });
    surfaces.push(surface);
    return {
      typing,
      render(dil, animated) { dilRef = dil; surface.render({ code: dil.code, constants: dil.constants, appData: mergeComponentResults(dil.appData, appData.opGenui?.componentResults) }, { animated }); },
    };
  }

  // restore transcript
  for (const m of lesson()?.tutor || []) {
    if (m.role === 'user') addUser(m.content);
    else if (m.dil) { const a = addAssistant(); a.typing.remove(); a.render(m.dil, false); }
  }
  const lastBot = [...(lesson()?.tutor || [])].reverse().find((m) => m.role === 'assistant');
  showFollowups(lastBot?.followups);

  const api = {
    panel,
    fab,
    onOpenChange: null,
    focus() { setTimeout(() => input.focus(), 50); },
    async send(text) {
      const message = String(text || '').trim();
      if (!message || busy) return;
      const l = lesson();
      if (!l || l.status !== 'complete') { toast('Wait for the lesson to finish writing first'); return; }
      busy = true;
      sendBtn.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      showFollowups([]);
      const history = (l.tutor || []).map((m) => ({ role: m.role, content: m.content }));
      addUser(message);
      const bot = addAssistant();
      scrollDown();
      ac = new AbortController();
      try {
        const useWebSearch = /\b(sources?|cite|citations?|latest|current(ly)?|recent(ly)?|news|today|this year|search|look (it )?up)\b/i.test(message); // Phase 3: tutor searches only when asked
        const r = await streamTurn('/api/tutor/stream', { message, history, lessonContext: { title: l.title, markdown: l.markdown }, useWebSearch, memoryEnabled: memoryEnabled() }, {
          signal: ac.signal,
          onContent: (msg, rec) => {
            if (rec.dil) { bot.typing.remove(); bot.render(rec.dil, rec.status !== 'complete'); }
            scrollDown();
          },
        });
        if (r.failure) throw new Error(r.failure.message || 'The tutor could not answer');
        const dil = r.message.dil ? { code: r.message.dil.code, constants: r.message.dil.constants, appData: r.message.dil.appData } : null;
        const prompts = r.final?.followupPrompts || [];
        saveLesson(lessonId, { tutor: [...(l.tutor || []), { role: 'user', content: message }, { role: 'assistant', content: r.message.markdown, dil, followups: prompts }] });
        showFollowups(prompts);
      } catch (e) {
        if (!ac.signal.aborted) {
          bot.typing.remove();
          log.lastChild.querySelector('.bot-body').append(el('p', { class: 'error-text' }, e.message || 'Something went wrong.'));
        }
      } finally {
        busy = false;
        sendBtn.disabled = false;
        scrollDown();
      }
    },
    destroy() { ac?.abort(); for (const s of surfaces) s.destroy(); },
  };
  return api;
}

// ------------------------------------------------------------------ finish + pack opening

async function finishLesson(lessonId, btn) {
  const lesson = store.data.lessons[lessonId];
  if (!lesson || lesson.status !== 'complete') return;
  btn.disabled = true;
  const label = btn.lastChild.textContent;
  btn.lastChild.textContent = 'Collecting your cards…';
  try {
    const data = await postJson('/api/practice/extract', { lessonMarkdown: lesson.markdown });
    showPack(lesson, data);
    if (memoryEnabled() && !lesson.memoryExtracted) {
      saveLesson(lessonId, { memoryExtracted: true });
      const tutorThread = (lesson.tutor || []).filter((m) => m.role === 'user').map((m) => m.content);
      postJson('/api/memory/extract', { lessonTitle: lesson.title, quizResults: lesson.quizResults || [], tutorThread, memoryEnabled: true })
        .then((r) => { if (r.added?.length) setTimeout(() => toast(`Wonder will remember: ${r.added[0].fact}`, 4200), 900); })
        .catch(() => {});
    }
  } catch (e) {
    toast(e.message || 'Could not create practice cards');
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = label;
  }
}

function showPack(lesson, data) {
  const cards = data.cards || [];
  const items = data.items || [];
  let opened = 0;
  const addBtn = el('button', { class: 'btn btn-lg', type: 'button' }, `Add ${items.length} practice card${items.length === 1 ? '' : 's'} to my deck`);
  const grid = el('div', { class: 'pack-grid' }, ...cards.map((c, i) => {
    const card = el('button', { class: 'pack-card', type: 'button', style: { animationDelay: `${i * 90}ms` }, 'aria-label': `Reveal card ${i + 1}` },
      el('span', { class: 'pack-inner' },
        el('span', { class: 'pack-face pack-front' }, el('span', { class: 'pack-mark' }, icon('sparkles')), el('span', null, 'Tap to reveal')),
        el('span', { class: 'pack-face pack-back' }, el('strong', null, c.term), el('span', null, inlineMd(c.definition)), c.example ? el('em', null, c.example) : null)));
    card.addEventListener('click', () => {
      if (card.classList.contains('flipped')) return;
      card.classList.add('flipped');
      card.setAttribute('aria-label', `${c.term}: ${c.definition}`);
      opened++;
      if (opened === cards.length) overlay.querySelector('.pack-sub').textContent = 'All revealed. These concepts now live in your review deck.';
    });
    return card;
  }));
  const overlay = el('div', { class: 'pack-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New knowledge cards' },
    el('div', { class: 'pack-panel' },
      el('p', { class: 'eyebrow' }, 'Lesson complete'),
      el('h2', { class: 'h-lg' }, `${cards.length} concept${cards.length === 1 ? '' : 's'} unlocked`),
      el('p', { class: 'pack-sub muted' }, 'Tap each card to reveal it.'),
      grid,
      el('div', { class: 'pack-actions' },
        el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { for (const c of grid.children) c.click(); } }, 'Reveal all'),
        addBtn)));
  addBtn.addEventListener('click', () => {
    let added = 0;
    const first = !lesson.finished;
    store.update((d) => {
      const r = addItems(d.deck, items, { lessonId: lesson.id, lessonTitle: lesson.title });
      d.deck = r.deck;
      added = r.added;
      if (d.lessons[lesson.id]) d.lessons[lesson.id].finished = true;
      return d;
    });
    store.flush();
    overlay.remove();
    if (first) giveXp(XP.lessonComplete + added * XP.cardsCollected, 'lesson complete');
    else toast(added ? `${added} new cards added` : 'These cards are already in your deck');
    location.hash = lesson.courseId ? `#/course/${lesson.courseId}` : '#/';
  });
  document.body.append(overlay);
  teardown.push(() => overlay.remove());
  setTimeout(() => grid.firstChild?.focus(), 80);
}

// ------------------------------------------------------------------ review + routing

function renderReviewScreen() {
  const root = el('div', { class: 'review-wrap' });
  app.replaceChildren(root);
  renderReview(root, { store, onExit: () => { location.hash = '#/'; }, onXp: refreshChrome });
}

function notFound() {
  app.replaceChildren(el('div', { class: 'card empty-review' }, el('h1', { class: 'h-lg' }, 'Not found'), el('p', { class: 'muted' }, 'This item is no longer stored in this browser.'), el('a', { class: 'btn', href: '#/' }, 'Home')));
}

function route() {
  cleanupScreen();
  const h = location.hash || '#/';
  let m;
  document.body.dataset.screen = 'home';
  if ((m = /^#\/lesson\/([\w-]+)$/.exec(h))) { document.body.dataset.screen = 'lesson'; renderLesson(m[1]); }
  else if ((m = /^#\/course\/([\w-]+)$/.exec(h))) { document.body.dataset.screen = 'course'; renderCourse(m[1]); }
  else if (h === '#/review') { document.body.dataset.screen = 'review'; renderReviewScreen(); }
  else if ((m = /^#\/teacher(?:\/([\w-]+))?$/.exec(h))) { document.body.dataset.screen = 'teacher'; renderTeacher(screenCtx(), m[1] || null); }
  else if (h === '#/memory') { document.body.dataset.screen = 'memory'; renderMemory(screenCtx()); }
  else renderHome();
  refreshChrome();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => store.flush());
initTheme();
observeMath(document.body);
refreshChrome();
loadStatus().then(route);
