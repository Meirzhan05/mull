// Wonder client: the app shell (sidebar / tabs, ⌘K palette), Today, Library, course map,
// streamed DIL lesson + tutor, pack opening, review, Teacher (agent chat with tool cards),
// and You (stats, settings, learner memory).

import { createStore, uid } from './store.js';
import { openLocalCache, startAccount, pushActive, onSyncStatus, signIn, accountFirstName } from './account.js'; // account sync
import { startAction, startTopic } from './start-core.js'; // sign in, onboarding, first lesson
import { DilSurface, mergeComponentResults } from './dil-surface.js';
import { streamTurn, postJson, failureError, retryDelay } from './stream-client.js';
import { retryControl } from './retry-ui.js'; // recoverable streams
import { addItems, deckStats, awardXp, formatDue, XP } from './deck.js';
import { normalizePracticeItem } from './practice-core.js';
import { renderReview } from './review.js';
import { renderCourseReview, courseReviewButton } from './course-review-screen.js'; // whole-course review
import { el, icon, toast, inlineMd, lessonTitleFrom } from './ui.js';
import { observeMath } from './math.js';
import { renderTeacher, queueTeacherMessage, queueTeacherOpener } from './teacher-screen.js';
import { planToIcs } from './ics.js'; // Phase 10
import { dailyBrief, briefNotification, reminderDue } from './brief-core.js'; // Phase 10
import { createSteerBar } from './steer-bar.js'; // Phase 4
import { lessonPhase, statusAfterStop, carryOver, mergeContinuedAppData, sourcesFromAppData, pageCount, pageTitles } from './steering-core.js';
import { createLessonLocks } from './lesson-lock.js'; // one writer per lesson across tabs
// widget state persistence (view-state.js): saved per lesson / tutor message, reset from the lesson menu
import { resolutionIdsOf } from './steering-core.js';
import { pruneViewState, hasViewState } from './view-state.js';
import { createOverflowMenu } from './lesson-menu.js';
import { createShell } from './shell.js';
import { renderToday } from './today.js';
import { renderLibrary } from './library.js';
import { renderYou, TEXT_SIZES } from './you.js';
import { needsOnboarding, showOnboarding } from './onboarding.js';
import { dailyProgress, courseProgress, roman, readingMinutes, levelOf } from './progress-core.js';
import { storeEvidence, quizEvidence, explainEvidence, requestMastery } from './mastery-core.js'; // Phase 6 + 8
import { qualitySummary } from './quality-core.js'; // Phase 7
import { pickVariant, insightsForPrompt, lessonOutcome, RECALL_MIN, STYLE_VARIANTS } from './outcomes-core.js'; // Phase 9

// Signed in: this account's IndexedDB cache (synced with the server); signed out: localStorage.
const localCache = await openLocalCache();
const store = createStore({ storage: localCache.storage });
const PAGE_ID = uid('page'); // this page load: a 'streaming' lesson owned by another id was interrupted
// Cross-tab lock per lesson, held for any stream of it. Released by the lesson's own pagehide
// handler (after its last save), so a waiting tab never reads the lesson before that save.
const lessonLocks = createLessonLocks({ owner: PAGE_ID, releaseOnHide: false });
const STORE_KEY = 'wonder.v1'; // store.js KEY: the waiting tab re-reads the lesson from it

/** Replace this tab's in-memory copy of a lesson with the stored one (no write back). */
function syncLessonFromStorage(lessonId) {
  try {
    const fresh = JSON.parse((localCache.storage || localStorage).getItem(STORE_KEY) || 'null')?.lessons?.[lessonId];
    if (!fresh || typeof fresh !== 'object') return false;
    store.data.lessons[lessonId] = fresh; // in memory only: the writing tab owns the stored copy
    return true;
  } catch { return false; }
}
const app = document.getElementById('app');
let status = { mode: 'demo', model: 'claude-opus-5-5' };
let teardown = [];

// ------------------------------------------------------------------ actions shared by screens

/** Start a lesson on a topic (Today, palette, Library, suggestions). */
function startLesson(topic, level = levelOf(store.data.settings), extra = {}) {
  const t = String(topic || '').trim();
  if (!t) return;
  const id = createLesson({ topic: t, title: t, level, ...extra });
  location.hash = `#/lesson/${id}`;
}

// A lesson refused for being signed out starts again once the visitor has signed in. Sign-in
// reloads the page (account.js), sometimes after an OAuth round trip, so the topic waits in this
// tab's sessionStorage for a page load that has an account (for half an hour at most).
const AFTER_SIGN_IN = 'wonder.afterSignIn';
function startAfterSignIn(topic, level) {
  try { sessionStorage.setItem(AFTER_SIGN_IN, JSON.stringify({ topic, level, at: Date.now() })); } catch {}
}
// Accounts on (app/layout.js data-accounts): everything needs a signed-in user, so a topic waits
// through sign-in and onboarding comes after it.
const ACCOUNTS = document.documentElement.dataset.accounts === 'on';
let signingIn = false; // a Google redirect is starting: nothing else should open over it

/** Sign in with Google; a topic waits for the first page load with an account (startAfterSignIn). */
function beginSignIn(topic) {
  if (topic) startAfterSignIn(topic, levelOf(store.data.settings));
  signingIn = true;
  signIn().catch((err) => { signingIn = false; toast(err.message || 'Sign-in is not available right now'); });
}

/** First-run onboarding; firstTopic is the topic brought from the landing page (its last step). */
function openOnboarding(firstTopic = '') {
  if (signingIn || document.querySelector('.onboard')) return;
  showOnboarding({ store, startLesson, firstTopic, accountName: localCache.account ? accountFirstName() : null,
    onDone: () => { refreshChrome(); if (!location.hash || location.hash === '#/') route(); } });
}

function takeAfterSignIn() {
  if (!localCache.account) return null;
  try {
    const p = JSON.parse(sessionStorage.getItem(AFTER_SIGN_IN) || 'null');
    sessionStorage.removeItem(AFTER_SIGN_IN);
    return p?.topic && Date.now() - p.at < 30 * 60_000 ? p : null;
  } catch { return null; }
}

/** Phase 10: a lesson taught from the learner's own material (a stored material id). */
function startMaterialLesson(material, level = levelOf(store.data.settings)) {
  startLesson(material.title, level, { materialId: material.id, materialTitle: material.title });
}

/** Plan a course with Claude, then open its map. Resolves false on failure. */
async function planCourse(topic, level = levelOf(store.data.settings), material = null) {
  const t = String(topic || '').trim();
  if (!t) return false;
  toast('Planning your course…', 6000);
  try {
    const { plan } = await postJson('/api/course/plan', { topic: t, level, ...(material ? { materialId: material.id } : {}) });
    const id = uid('course');
    store.update((dd) => {
      dd.courses.unshift({ id, title: plan.title, description: plan.description, level, topic: t, ...(material ? { materialId: material.id, materialTitle: material.title } : {}), createdAt: new Date().toISOString(), sections: plan.sections.map((s) => ({ title: s.title, lessons: s.lessons.map((l) => ({ ...l, lessonId: null })) })) });
      return dd;
    });
    location.hash = `#/course/${id}`;
    return true;
  } catch (e) {
    toast(e.message || 'Could not plan a course');
    return false;
  }
}

function askTeacher(text) {
  queueTeacherMessage(String(text || ''));
  if (location.hash === '#/teacher') route(); else location.hash = '#/teacher';
}

function openPlanItem(planId, di, ii) {
  const plan = (store.data.plans || []).find((p) => p.id === planId);
  const it = plan?.days?.[di]?.items?.[ii];
  if (!it) return;
  store.update((dd) => { const pl = dd.plans.find((x) => x.id === plan.id); if (pl) pl.days[di].items[ii].opened = true; return dd; });
  if (it.kind === 'review') { location.hash = '#/review'; return; }
  if (it.kind === 'quiz') { queueTeacherMessage(`Quiz me on ${it.topic || it.title}.`); location.hash = plan.threadId ? `#/teacher/${plan.threadId}` : '#/teacher'; return; }
  const known = store.data.teacherLessons?.[`${plan.id}:${it.id}`];
  if (known && store.data.lessons[known]) { location.hash = `#/lesson/${known}`; return; }
  const id = createLesson({ topic: it.topic || it.title, title: it.title, level: levelOf(store.data.settings), teacherThreadId: plan.threadId });
  store.update((dd) => { dd.teacherLessons = { ...(dd.teacherLessons || {}), [`${plan.id}:${it.id}`]: id }; return dd; });
  location.hash = `#/lesson/${id}`;
}

/** Open (creating on first visit) lesson li of section si of a course. */
function openCourseLesson(courseId, si, li) {
  const course = store.data.courses.find((c) => c.id === courseId);
  const entry = course?.sections?.[si]?.lessons?.[li];
  if (!entry) return;
  let lessonId = entry.lessonId && store.data.lessons[entry.lessonId] ? entry.lessonId : null;
  if (!lessonId) {
    lessonId = createLesson({ topic: entry.title, title: entry.title, level: course.level, courseId, sectionIndex: si, lessonIndex: li, lessonTitle: entry.title, lessonSummary: entry.summary, course: { title: course.title }, ...(course.materialId ? { materialId: course.materialId, materialTitle: course.materialTitle } : {}) });
    store.update((d) => { const c = d.courses.find((x) => x.id === courseId); c.sections[si].lessons[li].lessonId = lessonId; return d; });
  }
  location.hash = `#/lesson/${lessonId}`;
}

/** The next unfinished lesson of a course after (si, li), or null. */
function nextInCourse(courseId, afterLessonId) {
  const course = store.data.courses.find((c) => c.id === courseId);
  if (!course) return null;
  let seen = false;
  for (const [si, s] of course.sections.entries()) for (const [li, l] of s.lessons.entries()) {
    if (l.lessonId === afterLessonId) { seen = true; continue; }
    if (seen && !(l.lessonId && store.data.lessons[l.lessonId]?.finished)) return { si, li, title: l.title, course };
  }
  return null;
}

/** Phase 10: open the Teacher with a check-in turn (it looks at progress and speaks first). */
function teacherCheckIn() {
  queueTeacherOpener();
  if (location.hash === '#/teacher') route(); else location.hash = '#/teacher';
}

/** Phase 10: download a saved plan as an .ics file (one event per day at the reminder time). */
function exportPlan(planId) {
  const plan = (store.data.plans || []).find((p) => p.id === planId);
  if (!plan) return;
  const time = store.data.settings?.reminder?.time || '18:00';
  const ics = planToIcs(plan, { time, url: `${location.origin}/#/` });
  const a = el('a', { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: `wonder-plan-${String(plan.goal || 'study').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.ics` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast(`Calendar file with ${plan.days?.length || 0} study sessions at ${time}`);
}

const actions = { startLesson, startMaterialLesson, planCourse, askTeacher, openPlanItem, openCourseLesson, teacherCheckIn, exportPlan };

// Phase 10: the daily reminder. While any Wonder tab is open, a notification fires once a day at
// the learner's time if today's goal is not met, saying what the brief would put first. The
// "shown today" mark lives outside the synced state so two tabs don't both fire.
const REMINDED_KEY = 'wonder.reminded';
function checkReminder() {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (pushActive()) return; // the server sends it over Web Push (account sync), also with no tab open
    const last = localStorage.getItem(REMINDED_KEY);
    if (!reminderDue(store.data.settings, store.data.stats, new Date(), last)) return;
    localStorage.setItem(REMINDED_KEY, new Date().toLocaleDateString('en-CA'));
    const { title, body } = briefNotification(dailyBrief(store.data));
    const n = new Notification(title, { body, tag: 'wonder-daily', icon: document.querySelector('link[rel=icon]')?.href });
    n.onclick = () => { window.focus(); location.hash = '#/'; n.close(); };
  } catch { /* notifications or storage unavailable */ }
}
setInterval(checkReminder, 30000);
setTimeout(checkReminder, 3000);

// ------------------------------------------------------------------ chrome

const shell = createShell({ store, getStatus: () => status, actions });

function refreshChrome() { shell.refresh(); }

function giveXp(amount, why) {
  if (amount <= 0) return;
  const before = dailyProgress(store.data.stats, store.data.settings);
  store.update((d) => { d.stats = awardXp(d.stats, amount); return d; });
  refreshChrome();
  shell.bump();
  const after = dailyProgress(store.data.stats, store.data.settings);
  if (!before.met && after.met) toast(`Today’s goal is met · +${amount} XP`, 3600);
  else toast(`+${amount} XP${why ? ` · ${why}` : ''}`);
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    status = await r.json();
  } catch { status = { mode: 'demo', model: 'claude-opus-5-5' }; }
  shell.showBanner(status.mode);
}

const memoryEnabled = () => store.data.settings?.memoryEnabled !== false;
const applyFontScale = () => document.documentElement.style.setProperty('--lesson-scale', String(Number(store.data.settings?.fontScale) || 1));

/** Shared context for the screens that live in their own modules. */
const screenCtx = () => ({ app, store, status, teardown, createLesson, giveXp, reroute: route, actions, shell, refresh: () => { refreshChrome(); applyFontScale(); } });

function cleanupScreen() {
  for (const fn of teardown.splice(0)) { try { fn(); } catch {} }
}

// ------------------------------------------------------------------ data helpers

function createLesson(fields) {
  const id = uid('lesson');
  const now = new Date().toISOString();
  store.update((d) => {
    // Phase 9: each new lesson is taught in one style of the balanced experiment (outcomes-core)
    d.lessons[id] = { id, status: 'new', markdown: '', dil: null, appData: null, tutor: [], finished: false, createdAt: now, updatedAt: now, variant: pickVariant(d), ...fields };
    return d;
  });
  return id;
}

/** Phase 9: "How well it stuck": recall days later, forecast memory and the cards that keep slipping. */
function stuckPanel(o, lesson) {
  const pct = (r) => `${Math.round(r * 100)}%`;
  const style = STYLE_VARIANTS[lesson?.variant]?.label;
  const measured = o.recall.n >= RECALL_MIN;
  const delays = Object.entries(o.buckets).filter(([, b]) => b.n).map(([k, b]) => `${pct(b.rate)} after ${k.replace('-', '–')} days`).join(' · ');
  const body = measured
    ? `You recalled ${pct(o.recall.rate)} of its cards when they came back days later (${o.recall.n} review${o.recall.n === 1 ? '' : 's'}${delays ? `: ${delays}` : ''}).`
    : o.cards
      ? `Measured when its cards come back for review after at least a day (${o.recall.n} of ${RECALL_MIN} reviews so far).`
      : 'Collect the cards to measure how well this lesson sticks.';
  const tone = o.verdict === 'stuck' ? 'ok' : o.verdict === 'fading' || o.verdict === 'weak' ? 'warn' : '';
  return el('div', { class: `stuck ${tone}` },
    el('div', { class: 'stuck-head' },
      el('strong', null, 'How well it stuck'),
      el('span', { class: 'stuck-figures' },
        measured ? el('span', { class: 'stuck-fig' }, `${pct(o.recall.rate)} recall`) : null,
        o.memoryToday != null ? el('span', { class: 'stuck-fig', title: 'FSRS estimate of how likely you are to recall a card right now' }, `~${pct(o.memoryToday)} today`) : null,
        style ? el('span', { class: 'tag' }, style) : null)),
    el('p', null, body),
    o.leeches.length ? el('p', null, 'Keeps slipping: ', el('em', null, inlineMd(o.leeches[0].prompt)), o.leeches.length > 1 ? ` and ${o.leeches.length - 1} more` : '') : null,
    o.reviewed && (o.verdict === 'fading' || o.verdict === 'weak' || o.leeches.length)
      ? el('a', { class: 'link-btn', href: `#/review/lesson/${o.lessonId}` }, 'Refresh this lesson’s cards', icon('arrow-right')) : null);
}

function saveLesson(id, patch) {
  store.update((d) => {
    if (d.lessons[id]) d.lessons[id] = { ...d.lessons[id], ...patch, updatedAt: new Date().toISOString() };
    return d;
  });
}

// Reset helpers: resolution ids of server-graded quizzes in a widget-results appData, and the
// server call that forgets their answers (otherwise the next answer would merge with old ones).
function quizResolutionIds(appData) {
  const cr = appData?.opGenui?.componentResults || {};
  return Object.keys(cr).filter((rid) => cr[rid]?.state && typeof cr[rid].state === 'object' && 'answers' in cr[rid].state);
}
function restartQuizzes(rids) {
  for (const rid of new Set(rids)) postJson('/api/widget_action', { componentName: 'Quiz', action_type: 'quiz_restart', resolutionId: rid, payload: { attempt: 0 } }).catch(() => {});
}

// ------------------------------------------------------------------ course

function renderCourse(courseId) {
  const course = store.data.courses.find((c) => c.id === courseId);
  if (!course) return notFound();
  const p = courseProgress(store.data, course);
  let n = 0;
  const firstOpen = (() => { for (const [si, s] of course.sections.entries()) for (const [li, l] of s.lessons.entries()) if (!(l.lessonId && store.data.lessons[l.lessonId]?.finished)) return { si, li, title: l.title }; return null; })();
  const label = (lesson) => lesson?.finished ? 'Revisit' : lesson?.status === 'complete' ? 'Continue' : lesson && lessonPhase(lesson, { pageId: PAGE_ID }) === 'interrupted' ? 'Resume' : 'Start';
  const pct = p.total ? p.done / p.total : 0;
  app.replaceChildren(el('div', { class: 'course' },
    el('a', { class: 'back-link', href: '#/library' }, icon('arrow-left'), 'Library'),
    el('header', { class: 'course-head card' },
      el('div', { class: 'course-head-row' },
        el('div', { style: { flex: '1 1 300px', display: 'grid', gap: '10px' } },
          el('p', { class: 'kicker', style: { margin: 0 } }, `A course in ${p.total} lessons · ${course.level || 'beginner'}`),
          el('h1', { class: 'h-xl' }, course.title),
          course.description ? el('p', { class: 'muted' }, course.description) : null),
        el('div', { class: 'course-ledger' },
          el('span', { class: 'ledger-label' }, 'Progress'),
          el('span', { class: 'ledger-value' }, String(p.done), el('small', null, ` of ${p.total} lessons`)),
          el('span', { class: 'ledger-bar', 'aria-hidden': 'true' }, el('i', { style: { width: `${Math.round(pct * 100)}%` } })))),
      el('div', { class: 'course-actions' },
        firstOpen ? el('button', { class: 'btn btn-lg', type: 'button', onclick: () => openCourseLesson(courseId, firstOpen.si, firstOpen.li) }, icon('play'), p.done ? `Continue: ${firstOpen.title}` : 'Start the course')
          : el('p', { class: 'byline' }, 'Every lesson in this course is finished.'),
        courseReviewButton(store, course))),
    ...course.sections.map((s, si) => el('section', { class: 'path-section' },
      el('h2', { class: 'rubric path-title' }, `Part ${roman(si + 1)} · ${s.title}`),
      el('ol', { class: 'path' }, ...s.lessons.map((l, li) => {
        n++;
        const lesson = l.lessonId ? store.data.lessons[l.lessonId] : null;
        const done = !!lesson?.finished;
        const current = firstOpen && firstOpen.si === si && firstOpen.li === li;
        return el('li', { class: `path-node ${done ? 'done' : ''} ${current ? 'current' : ''}` },
          el('button', { class: 'node-dot', type: 'button', 'aria-label': `Open lesson ${n}: ${l.title}`, onclick: () => openCourseLesson(courseId, si, li) }, done ? icon('check') : String(n)),
          el('div', { class: 'node-card' },
            el('div', { class: 'node-body' },
              el('strong', null, l.title),
              l.summary ? el('span', { class: 'muted small' }, l.summary) : null,
              lesson?.quizScore?.total ? el('span', { class: 'faint tiny' }, `Quiz ${lesson.quizScore.score}/${lesson.quizScore.total}`) : null),
            el('button', { class: `btn ${current ? '' : 'btn-secondary'} btn-sm`, type: 'button', onclick: () => openCourseLesson(courseId, si, li) }, label(lesson))));
      }))))));
}

// ------------------------------------------------------------------ lesson

function renderLesson(lessonId) {
  const lesson = store.data.lessons[lessonId];
  if (!lesson) return notFound();
  const ac = new AbortController();
  teardown.push(() => ac.abort());

  const back = lesson.courseId ? `#/course/${lesson.courseId}` : '#/library';
  const titleEl = el('span', { class: 'lesson-bar-title' }, lesson.title || lesson.topic);
  const pageLabel = el('span', { class: 'lesson-bar-page', 'aria-live': 'polite' });
  const segs = el('div', { class: 'page-segs', role: 'progressbar', 'aria-label': 'Lesson progress', 'aria-valuemin': '0' });
  const reasoning = el('div', { class: 'reasoning', role: 'status', 'aria-live': 'polite', hidden: true }, el('span', { class: 'reasoning-dot', 'aria-hidden': 'true' }), el('span', { class: 'reasoning-text shimmer' }));
  const writingRow = el('div', { class: 'writing-row' }, reasoning);
  const mount = el('div', { class: 'lesson-dil' });
  const skeleton = el('div', { class: 'skeleton', 'aria-hidden': 'true' }, el('i', { class: 't' }), el('i'), el('i'), el('i'), el('i'));
  const errorBox = el('div', { class: 'card error-card', hidden: true });
  const finishBtn = el('button', { class: 'btn btn-lg', type: 'button', disabled: true }, 'Collect the cards');
  const endPanel = el('section', { class: 'card lesson-end pending', 'aria-label': 'End of lesson' });
  // Phase 4: live steer (a pill beside the status line), resume (open, top) and revise (sticky, after the lesson)
  const steerBar = createSteerBar({
    onContinue: (req) => { autoRetried = false; continueLesson(req); },
    onOpen: () => onPageScroll(),
    onMode: (mode, node) => { if (mode === 'revise') errorBox.before(node); else writingRow.append(node); },
  });
  const tutorToggle = el('button', { class: 'btn btn-secondary btn-sm tutor-toggle', type: 'button', 'aria-expanded': 'false', title: 'Ask the tutor about this lesson' }, icon('chat'), el('span', null, 'Tutor'));

  // contents menu: jump to any page
  const tocBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Lesson contents', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Contents' }, icon('list'));
  const tocMenu = el('div', { class: 'toc-menu', role: 'menu', 'aria-label': 'Pages', hidden: true });
  const toc = el('div', { class: 'toc' }, tocBtn, tocMenu);
  const closeToc = () => { tocMenu.hidden = true; tocBtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', onTocOutside, true); };
  const onTocOutside = (e) => { if (!toc.contains(e.target)) closeToc(); };
  tocBtn.addEventListener('click', () => {
    if (!tocMenu.hidden) { closeToc(); return; }
    const titles = pageList();
    const cur = currentPage();
    tocMenu.replaceChildren(
      el('button', { class: `toc-item ${cur === 0 ? 'current' : ''}`, type: 'button', role: 'menuitem', onclick: () => { closeToc(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, el('span', { class: 'toc-num' }, icon('book')), el('span', { class: 'toc-label' }, 'Introduction')),
      ...titles.map((t, i) => el('button', { class: `toc-item ${cur === i + 1 ? 'current' : i + 1 < cur ? 'read' : ''}`, type: 'button', role: 'menuitem', onclick: () => { closeToc(); jumpToPage(i + 1); } },
        el('span', { class: 'toc-num' }, String(i + 1)), el('span', { class: 'toc-label' }, t))),
      ...(titles.length ? [] : [el('p', { class: 'muted small', style: { padding: '8px 10px', margin: 0 } }, 'Pages appear here as the lesson is written.')]));
    tocMenu.hidden = false;
    tocBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onTocOutside, true);
    tocMenu.querySelector('.current')?.focus();
  });
  tocMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeToc(); tocBtn.focus(); } });
  teardown.push(closeToc);

  const setScale = (v) => {
    store.update((d) => { d.settings = { ...(d.settings || {}), fontScale: v }; return d; });
    applyFontScale();
  };
  const stepScale = (dir) => {
    const sizes = TEXT_SIZES.map(([v]) => Number(v));
    const cur = Number(store.data.settings?.fontScale) || 1;
    const i = Math.max(0, Math.min(sizes.length - 1, sizes.findIndex((v) => v >= cur - 0.001) + dir));
    setScale(sizes[i]);
    toast(`Text size: ${TEXT_SIZES[i][1]}`);
  };
  // >>> widget state: lesson overflow menu
  const lessonMenu = createOverflowMenu({ label: 'More lesson options', items: [
    { label: 'Larger text', hint: 'Easier reading for long lessons.', onSelect: () => stepScale(1) },
    { label: 'Smaller text', onSelect: () => stepScale(-1) },
    {
      label: 'Reset interactive widgets', hint: 'Sliders, steps, cards and quiz progress go back to their start.',
      onSelect: () => {
        // local widget state, server-graded quiz results and tutor-reply widgets all go back to start
        const graded = quizResolutionIds(current.appData);
        current.appData = null;
        // order matters: drop the grades first, then remount widgets, so a Quiz that derives its
        // start position from server grades remounts at question 1
        if (current.dil) surface.setAppData(appDataFor());
        surface.resetViewState();
        saveLesson(lessonId, { viewState: null, appData: null });
        restartQuizzes([...graded, ...tutor.resetWidgets()]);
        toast('Interactive widgets reset');
      },
    },
    { label: 'Ask the Teacher about this', hint: 'Plan what to learn next, or get quizzed.', onSelect: () => askTeacher(`I just studied “${store.data.lessons[lessonId]?.title || lesson.topic}”. What should I learn next?`) },
  ] });
  teardown.push(() => lessonMenu.destroy());
  // <<< widget state

  // recoverable streams: "Connection lost — Retry from here" at the tail of the lesson text
  let tailRetry = null; // what the tail control re-runs
  const retryTail = retryControl({ className: 'lesson-retry', onRetry: () => { autoRetried = false; const f = tailRetry; tailRetry = null; f?.(); } });
  const card = el('article', { class: 'lesson-card card', 'aria-label': 'Lesson' }, skeleton, mount, retryTail.el);
  const lessonMain = el('div', { class: 'lesson-main' },
    el('div', { class: 'lesson-bar' },
      el('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, icon('arrow-left')),
      el('div', { class: 'lesson-bar-mid' }, el('div', { class: 'lesson-bar-top' }, titleEl, pageLabel), segs),
      toc,
      tutorToggle,
      lessonMenu.el), // widget state: overflow menu
    writingRow,
    card,
    errorBox,
    endPanel);

  const tutor = createTutor(lessonId);
  const layout = el('div', { class: 'lesson-layout' }, lessonMain, tutor.scrim, tutor.panel, tutor.fab);
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
  if (window.innerWidth >= 1240 && (lesson.tutor || []).length) setTutorOpen(true);

  // -- pages: the segmented progress bar, "Page x of n", contents and jumps
  const heads = () => [...mount.querySelectorAll(':scope > h2[data-d-component="title"]')];
  const pageList = () => {
    const t = pageTitles(store.data.lessons[lessonId]?.markdown);
    const h = heads();
    return Array.from({ length: Math.max(t.length, h.length) }, (_, i) => t[i] || h[i]?.textContent || `Page ${i + 1}`);
  };
  /** The page in view: 0 = the introduction above the first "## ". */
  const currentPage = () => {
    const line = window.innerHeight * 0.4;
    let n = 0;
    heads().forEach((h, i) => { if (h.getBoundingClientRect().top < line) n = i + 1; });
    return n;
  };
  const atEnd = () => { const h = document.documentElement; return h.scrollHeight - h.clientHeight - h.scrollTop < 80; };
  function jumpToPage(n) {
    const h = heads()[n - 1];
    if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  let segCount = -1;
  function updatePages(liveMarkdown) {
    const l = store.data.lessons[lessonId];
    const writing = streaming;
    const total = Math.max(pageCount(liveMarkdown ?? l?.markdown), heads().length);
    if (total !== segCount) {
      segCount = total;
      segs.replaceChildren(...Array.from({ length: Math.max(total, 1) }, (_, i) => el('button', { class: 'page-seg', type: 'button', tabindex: '-1', 'aria-label': `Go to page ${i + 1}`, onclick: () => jumpToPage(i + 1) })));
    }
    const cur = currentPage();
    const end = l?.status === 'complete' && atEnd();
    [...segs.children].forEach((seg, i) => {
      const n = i + 1;
      const done = writing ? n < total : end || n < cur;
      seg.classList.toggle('done', done);
      seg.classList.toggle('writing', writing && n === Math.max(total, 1));
      seg.style.setProperty('--fill', !writing && n === cur && !done ? '50%' : '0%');
    });
    segs.setAttribute('aria-valuemax', String(Math.max(total, 1)));
    segs.setAttribute('aria-valuenow', String(writing ? Math.max(0, total - 1) : end ? total : cur));
    pageLabel.textContent = writing ? (total ? `Writing page ${total}…` : 'Writing…')
      : l?.status !== 'complete' ? (total ? `${total} page${total === 1 ? '' : 's'} so far` : '')
        : total ? (cur ? `Page ${cur} of ${total}` : `${total} pages · ${readingMinutes(l?.markdown) || 1} min read`) : '';
  }
  let saveTimer = 0;
  const onScroll = () => {
    updatePages();
    if (store.data.lessons[lessonId]?.status !== 'complete') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const p = currentPage();
      if (p !== (store.data.lessons[lessonId]?.readPage || 0)) store.update((d) => { if (d.lessons[lessonId]) d.lessons[lessonId].readPage = p; return d; }); // no updatedAt bump
    }, 600);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  teardown.push(() => { window.removeEventListener('scroll', onScroll); clearTimeout(saveTimer); });

  // -- highlight a passage to ask the tutor about it
  const selPop = el('div', { class: 'sel-pop', role: 'toolbar', 'aria-label': 'Selection', hidden: true });
  document.body.append(selPop);
  teardown.push(() => selPop.remove());
  const selectedQuote = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!mount.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    return text.length >= 3 ? { text: text.slice(0, 400), rect: range.getBoundingClientRect() } : null;
  };
  const hideSel = () => { selPop.hidden = true; };
  const onSelect = () => {
    const q = selectedQuote();
    if (!q || store.data.lessons[lessonId]?.status !== 'complete') { hideSel(); return; }
    selPop.replaceChildren(
      el('button', { type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { hideSel(); setTutorOpen(true); tutor.send(`Explain this part of the lesson in a different way: “${q.text}”`); window.getSelection()?.removeAllRanges(); } }, 'Explain'),
      el('button', { type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { hideSel(); setTutorOpen(true); tutor.prefill(`About “${q.text.length > 160 ? `${q.text.slice(0, 157)}…` : q.text}”: `); window.getSelection()?.removeAllRanges(); } }, 'Ask about this'));
    selPop.hidden = false;
    selPop.style.left = `${Math.max(90, Math.min(window.innerWidth - 90, q.rect.left + q.rect.width / 2)) + window.scrollX}px`;
    selPop.style.top = `${q.rect.top + window.scrollY}px`;
  };
  const onSelUp = () => setTimeout(onSelect, 10);
  const onSelChange = () => { if (!selectedQuote()) hideSel(); };
  mount.addEventListener('mouseup', onSelUp);
  mount.addEventListener('touchend', onSelUp);
  document.addEventListener('selectionchange', onSelChange);
  window.addEventListener('scroll', hideSel, { passive: true });
  teardown.push(() => { document.removeEventListener('selectionchange', onSelChange); window.removeEventListener('scroll', hideSel); });

  // -- DIL surface + widget actions
  let current = { dil: lesson.dil, appData: lesson.appData };
  const surface = new DilSurface(mount, {
    onAction: (a) => handleAction(a), onError: (e) => console.warn('[dil]', e.phase, e.message),
    // widget state: saved snapshot goes in before the first render; debounced changes come back
    viewState: lesson.dil && hasViewState(lesson.viewState) ? pruneViewState(lesson.viewState, resolutionIdsOf(lesson.dil)) : null,
    onViewState: (vs) => saveLesson(lessonId, { viewState: hasViewState(vs) ? vs : null }),
  });
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

  // -- end of lesson: a panel that grows from "still writing" to "collect your cards" to "what next"
  function drawEnd() {
    const l = store.data.lessons[lessonId];
    if (!l) return;
    const score = l.quizScore?.total ? el('span', { class: 'tag brand' }, icon('target'), `Quiz ${l.quizScore.score}/${l.quizScore.total}`) : null;
    const pages = pageCount(l.markdown);
    if (streaming || l.status !== 'complete') {
      endPanel.className = 'card lesson-end pending';
      endPanel.replaceChildren(el('p', { class: 'muted small' }, streaming ? 'The lesson is being written. You can start reading right away.' : 'The end of the lesson appears here once it is complete.'));
      return;
    }
    if (!l.finished) {
      endPanel.className = 'card lesson-end';
      finishBtn.disabled = false;
      finishBtn.classList.remove('btn-secondary');
      finishBtn.lastChild.textContent = 'Collect the cards';
      endPanel.replaceChildren(
        el('p', { class: 'kicker' }, 'End of the lesson'),
        el('h2', { class: 'h-lg' }, 'File what you have learned'),
        el('p', { class: 'muted' }, 'The key ideas become index cards in your review deck. Each returns just before you would forget it.'),
        el('div', { class: 'end-stats' }, pages ? el('span', { class: 'tag' }, `${pages} pages`) : null, score, el('span', { class: 'tag' }, `+${XP.lessonComplete} XP`)),
        el('div', { class: 'end-actions' }, finishBtn,
          el('button', { class: 'btn btn-secondary btn-lg', type: 'button', onclick: () => setTutorOpen(true) }, 'Ask the tutor first')),
        qualityNote(l.quality));
      return;
    }
    endPanel.className = 'card lesson-end finished';
    const nxt = l.courseId ? nextInCourse(l.courseId, lessonId) : null;
    const due = deckStats(store.data.deck).due;
    endPanel.replaceChildren(
      el('p', { class: 'kicker' }, 'Finished'),
      el('h2', { class: 'h-lg' }, 'This lesson is filed'),
      el('p', { class: 'muted' }, 'Its cards are in your review deck. Come back to the text any time, or continue.'),
      el('div', { class: 'end-stats' }, score),
      stuckPanel(lessonOutcome(store.data, lessonId), l),
      el('div', { class: 'end-actions' },
        nxt ? el('button', { class: 'btn btn-lg', type: 'button', onclick: () => openCourseLesson(l.courseId, nxt.si, nxt.li) }, `Next: ${nxt.title}`, icon('arrow-right')) : null,
        due ? el('a', { class: `btn btn-lg ${nxt ? 'btn-secondary' : ''}`, href: '#/review' }, `Review ${due} card${due === 1 ? '' : 's'}`) : null,
        el('a', { class: `btn btn-lg ${nxt || due ? 'btn-secondary' : ''}`, href: '#/' }, 'Back to Today')),
      qualityNote(l.quality));
  }

  function markComplete() {
    reasoning.hidden = true;
    skeleton.remove();
    drawEnd();
    updatePages();
  }

  finishBtn.addEventListener('click', () => finishLesson(lessonId, finishBtn, { onFinished: () => drawEnd() }));

  // Reopened a finished-writing lesson part way through: offer to jump back to where you were.
  function offerResumeReading() {
    const l = store.data.lessons[lessonId];
    const n = l?.readPage || 0;
    if (!n || n < 2 || l.finished) return;
    const chip = el('div', { class: 'resume-chip', role: 'status' },
      icon('book'), el('span', null, `You were on page ${n}.`),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { chip.remove(); jumpToPage(n); } }, 'Jump back', icon('arrow-right')),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => chip.remove() }, icon('x')));
    writingRow.append(chip);
    const auto = setTimeout(() => chip.remove(), 12000);
    teardown.push(() => clearTimeout(auto));
  }

  // -- streaming, resume and revise (Phase 4). Persisted lesson.status: 'new' | 'streaming'
  // (streamOwner = PAGE_ID) | 'interrupted' | 'complete' | 'failed' (see steering-core lessonPhase).
  let streaming = false;
  let busy = false; // runStream holds (or is taking / releasing) the cross-tab lock
  let queued = null; // a continuation requested while a stream is still finishing
  let retryNext = null; // {continueFrom}: the automatic retry, run once the lock is released
  let autoRetried = false; // one automatic retry per learner action
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

  function showInterrupted(note = '', { lost = false, instruction = '' } = {}) {
    reasoning.hidden = true;
    skeleton.remove();
    updatePages();
    drawEnd();
    steerBar.setMode('resume');
    if (note) steerBar.setStatus(note);
    // the same Resume at the tail, where the text stopped (a steer in force carries on)
    tailRetry = () => continueLesson(instruction ? { instruction } : {});
    retryTail.show(lost ? 'Connection lost.' : 'The lesson stopped here.', lost ? 'Retry from here' : 'Resume from here');
  }

  /** Show the stored program (another tab's latest save, or this lesson after a reload). */
  function renderStored() {
    const l = store.data.lessons[lessonId];
    if (!l) return;
    current = { dil: l.dil, appData: l.appData };
    if (l.dil) surface.render({ code: l.dil.code, constants: l.dil.constants, appData: appDataFor() }, { animated: false });
    const t = lessonTitleFrom(l.markdown || '', '');
    if (t && titleEl.textContent !== t) titleEl.textContent = t;
    if (l.dil) skeleton.remove();
    updatePages();
  }

  // Another tab is writing this lesson (holds its lock): show its saves live, no Resume/Steer,
  // and re-open the lesson from storage once that tab lets go.
  let stopWatch = null;
  function showElsewhere() {
    reasoning.hidden = true;
    errorBox.hidden = true;
    finishBtn.disabled = true;
    steerBar.setMode('elsewhere');
    if (stopWatch) return;
    const onStorage = (e) => { if (e.key === STORE_KEY && syncLessonFromStorage(lessonId)) renderStored(); };
    window.addEventListener('storage', onStorage);
    const offCache = localCache.storage?.onChange?.((key) => onStorage({ key })); // signed in: the account cache's feed
    let reopen = 0;
    stopWatch = lessonLocks.watch(lessonId, () => {
      window.removeEventListener('storage', onStorage);
      offCache?.();
      // the writer saves right before it releases; give that save a moment to land
      reopen = setTimeout(() => {
        if (ac.signal.aborted) return;
        syncLessonFromStorage(lessonId);
        const y = window.scrollY;
        route();
        window.scrollTo(0, y);
      }, 250);
    });
    teardown.push(() => { stopWatch?.(); clearTimeout(reopen); window.removeEventListener('storage', onStorage); offCache?.(); });
  }

  // In Resume / Revise mode, another tab may take the lesson (its own Resume / Revise): follow it.
  const stopTaken = lessonLocks.onTaken(lessonId, () => {
    if (busy || ac.signal.aborted) return;
    syncLessonFromStorage(lessonId);
    renderStored();
    showElsewhere();
  });
  teardown.push(stopTaken);

  // Decide what to show. A lesson another tab holds the lock for is never marked interrupted
  // here, and never streamed twice; ask the lock first (async), showing what is stored meanwhile.
  const initialPhase = lessonPhase(lesson, { pageId: PAGE_ID });
  if (lesson.dil && initialPhase !== 'new') renderStored();
  lessonLocks.isHeld(lessonId).then((elsewhere) => {
    if (ac.signal.aborted) return;
    const l = store.data.lessons[lessonId];
    const phase = lessonPhase(l, { pageId: PAGE_ID, lockedElsewhere: elsewhere });
    if (phase === 'elsewhere') {
      showElsewhere();
    } else if (phase === 'complete') {
      markComplete();
      steerBar.setMode('revise');
      requestAnimationFrame(() => { onPageScroll(); updatePages(); offerResumeReading(); });
    } else if (phase === 'interrupted' || phase === 'streaming') {
      // reload, closed tab or dropped connection mid-lesson: show what was written, offer Resume
      if (l.status !== 'interrupted') saveLesson(lessonId, { status: 'interrupted', streamOwner: null });
      showInterrupted(l.interruptedReason || '', { lost: !!l.interruptedReason });
    } else {
      runStream();
    }
  });

  /** Resume (no instruction), steer after a reload, or revise from page N: POST {continueFrom}. */
  function continueLesson({ instruction = '', fromPage, fallback = false } = {}) {
    if (streaming || busy) { queued = { instruction, fromPage, fallback }; return; }
    const l = store.data.lessons[lessonId];
    if (!String(l?.markdown || '').trim()) { runStream(); return; }
    // a live steer that missed the stream (Claude had finished) stays page-level like a live
    // steer: rewrite the last page. A resume (interrupted lesson) continues mid-page.
    if (fallback && !fromPage && l.status === 'complete' && pageCount(l.markdown) > 0) fromPage = pageCount(l.markdown);
    runStream({
      markdown: l.markdown,
      ...(instruction ? { instruction } : {}),
      ...(fromPage ? { fromPage } : {}),
      ...(l.messageId ? { messageId: l.messageId } : {}),
      sources: sourcesFromAppData(current.dil?.appData),
    });
  }

  /** Take the lesson's cross-tab lock for the whole stream; without it, wait for the other tab. */
  async function runStream(continueFrom = null) {
    busy = true;
    let lock = null;
    try {
      lock = await lessonLocks.acquire(lessonId);
      if (ac.signal.aborted) return;
      if (!lock) {
        // another tab took it first (both offered Resume): show its progress instead
        queued = null;
        syncLessonFromStorage(lessonId);
        renderStored();
        showElsewhere();
        return;
      }
      teardown.push(() => lock.release()); // leaving the screen frees it at once
      await streamLesson(continueFrom, lock);
    } finally {
      await lock?.release();
      busy = false;
      const retry = retryNext;
      retryNext = null;
      // a continuation the learner asked for wins over the automatic retry
      if (queued && !ac.signal.aborted) { const q = queued; queued = null; continueLesson(q); }
      else if (retry && !ac.signal.aborted) {
        if (!retry.continueFrom) surface.host.clear();
        runStream(retry.continueFrom);
      }
    }
  }

  async function streamLesson(continueFrom, lock) {
    streaming = true;
    errorBox.hidden = true;
    card.hidden = false;
    retryTail.hide();
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
    const onHide = () => { unloading = true; if (streaming && began) { persist(); store.flush(); } lock.release(); };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    if (!continueFrom) { current.dil = null; persist(); }
    reasoning.hidden = false;
    reasoning.querySelector('.reasoning-text').textContent = continueFrom ? (continueFrom.instruction ? 'Steering…' : 'Resuming the lesson…') : 'Planning the lesson…';
    updatePages();
    drawEnd();
    steerBar.setMode('live');
    let r = null;
    let quality = null; // Phase 7: the server's quality-report control
    let instruction = continueFrom?.instruction || ''; // the steer in force, carried into a retry
    try {
      r = await streamTurn('/api/lesson/stream', {
        streamKey: lessonId, // the server aborts an older request for this lesson first
        topic: l.topic, level: l.level, lessonTitle: l.lessonTitle, lessonSummary: l.lessonSummary, course: l.course, memoryEnabled: memoryEnabled(), mastery: requestMastery(store.data),
        variant: l.variant, learnerInsights: memoryEnabled() ? insightsForPrompt(store.data) : [], // Phase 9
        ...(l.materialId ? { materialId: l.materialId } : {}), // Phase 10
        ...(continueFrom ? { continueFrom } : {}),
      }, {
        signal: ac.signal,
        onControl: (d) => {
          if (d.kind === 'quality-report' && d.report) { quality = d.report; return; } // Phase 7
          if (d.kind === 'steering-status' && d.status === 'accepted' && d.instruction) instruction = d.instruction;
          steerBar.onControl(d);
        },
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
          if (pages || rec.dil) skeleton.remove();
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
          updatePages(msg.markdown);
          const t = lessonTitleFrom(msg.markdown, '');
          if (t && titleEl.textContent !== t) titleEl.textContent = t;
          if (Date.now() - lastSave > 1000) { lastSave = Date.now(); persist(); }
        },
      });
      if (r.failure) throw failureError(r.failure);
      const msg = r.message;
      const dil = msg.dil ? { code: msg.dil.code, constants: msg.dil.constants, appData: carried ? mergeContinuedAppData(carried, msg.dil.appData) : msg.dil.appData, requiredComponents: msg.dil.requiredComponents || [] } : null;
      current.dil = dil;
      latest = { markdown: msg.markdown, dil };
      streaming = false;
      autoRetried = false;
      saveLesson(lessonId, { status: 'complete', streamOwner: null, markdown: msg.markdown, dil, appData: current.appData, messageId, title: lessonTitleFrom(msg.markdown, l.title), truncated: !!r.final?.debug?.truncated, interruptedReason: null, quality });
      const qs = qualitySummary(quality);
      if (qs?.tone === 'fixed') toast(qs.headline, 4200);
      store.flush();
      if (dil) surface.pruneViewState(resolutionIdsOf(dil)); // widget state: drop widgets a revision removed or rewrote
      if (r.final?.debug?.truncated) toast('The lesson was cut short (length limit).');
      markComplete();
      steerBar.setMode('revise');
      onPageScroll();
    } catch (e) {
      streaming = false;
      if (ac.signal.aborted || unloading) { if (began) { persist('interrupted'); store.flush(); } return; }
      reasoning.hidden = true;
      const hasText = !!String(latest.markdown || '').trim();
      const retryable = e?.retryable === true;
      // What a retry re-runs: the same continuation if this one never replaced anything, else a
      // resume from what is on screen now (steer included), else the lesson from the start.
      // streamTurn has already aborted the failed request, so the retry never overlaps it.
      const retryFrom = !began ? continueFrom : hasText ? {
        markdown: latest.markdown,
        ...(instruction ? { instruction } : {}),
        ...(messageId ? { messageId } : {}),
        sources: sourcesFromAppData(current.dil?.appData),
      } : null;
      if (retryable && !autoRetried) {
        // one automatic retry with backoff (Retry-After when the server sent one)
        autoRetried = true;
        if (began && hasText) { persist('interrupted'); store.flush(); }
        skeleton.remove();
        const go = await retryTail.countdown(retryDelay(0, { retryAfterMs: e.retryAfterMs }), e.message || 'Connection lost.', ac.signal);
        if (go) retryNext = { continueFrom: retryFrom };
        return;
      }
      // signed out / today's cap used up on a brand-new lesson: the end panel says so (below)
      const gated = (e.code === 'signed_out' || e.code === 'daily_limit') && !continueFrom && !hasText;
      if (!began && !gated) {
        // the continuation never started: the persisted lesson is unchanged
        toast(e.message || 'Could not continue the lesson');
        if (prevPhase === 'complete') { markComplete(); steerBar.setMode('revise'); } else showInterrupted();
        steerBar.fail(e.message);
        if (retryable) { tailRetry = () => runStream(continueFrom); retryTail.show(e.message || 'Connection lost.', 'Retry'); }
        return;
      }
      const next = statusAfterStop({ markdown: latest.markdown, failureCode: e.code, retryable });
      if (next === 'interrupted') {
        // stalled / network / overloaded / client-side drop: keep the pages, offer Resume (continueFrom)
        failNote = e.code ? e.message : 'The connection dropped. Resume to continue from the last complete paragraph.';
        persist('interrupted');
        if (e.code) saveLesson(lessonId, { interruptedReason: failNote }); // a client-side drop may just be a reload: not persisted
        store.flush();
        showInterrupted(failNote, { lost: true, instruction });
        return;
      }
      // accounts on (server/usage.js): signed out -> sign in, then try again; today's cap used -> no retry
      const signedOut = e.code === 'signed_out';
      const limited = e.code === 'daily_limit';
      // refused only for being signed out, before a word was written: not kept (no "Failed" lesson
      // in Recent); signing in from the panel below starts the topic again (startAfterSignIn)
      const dropped = signedOut && gated && !lesson.courseId;
      if (dropped) store.update((d) => { delete d.lessons[lessonId]; return d; });
      else saveLesson(lessonId, { status: 'failed', streamOwner: null });
      steerBar.hide();
      skeleton.remove();
      drawEnd();
      updatePages(); // the bar stops saying "Writing…"
      if (!hasText) card.hidden = true; // nothing was written: no empty lesson card above the message
      if (dropped) endPanel.hidden = true;
      errorBox.hidden = false;
      errorBox.replaceChildren(
        el('h2', { class: 'h-md' }, signedOut ? 'Sign in to start this lesson' : limited ? 'Today\u2019s lesson limit is reached' : 'The lesson could not be generated'),
        el('p', { class: 'muted' }, e.message || 'Something went wrong.'),
        signedOut
          ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { if (dropped) startAfterSignIn(lesson.topic, lesson.level); signIn().catch((err) => toast(err.message || 'Sign-in is not available right now')); } }, 'Sign in')
          : limited ? el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/'; } }, 'Back to Today')
            : el('button', { class: 'btn', type: 'button', onclick: () => { card.hidden = false; surface.host.clear(); runStream(); } }, icon('refresh'), 'Try again'));
    } finally {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
    }
  }
}

/** Phase 7: the lesson's quality check, a collapsed note in the end panel. */
function qualityNote(report) {
  const q = qualitySummary(report);
  if (!q) return null;
  const ic = q.tone === 'warn' ? 'quote' : q.tone === 'lint' ? 'list' : 'check';
  if (!q.items.length) return el('div', { class: `quality-note ${q.tone}` }, el('p', null, icon(ic), el('span', null, q.headline)));
  return el('details', { class: `quality-note ${q.tone}` }, el('summary', null, icon(ic), el('span', null, q.headline)),
    el('ul', null, ...q.items.map((i) => el('li', { class: i.major ? 'major' : '' }, el('strong', null, `${i.label}. `), i.text))));
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
      // first attempt only: a retake right after seeing the answers is not evidence of mastery
      if (memoryEnabled()) storeEvidence(store, quizEvidence(p.results, { topic: store.data.lessons[lessonId]?.title || '' }));
      giveXp((Number(p.score) || 0) * XP.quizCorrect, `${p.score}/${p.total} on the quiz`);
      break;
    }
    case 'explain_graded': { // Phase 8: once per ExplainBack attempt
      const key = `${lessonId}:explain:${p.resolutionId}:${Number(p.attempt) || 0}`;
      if (store.data.awarded?.[key]) break;
      store.update((d) => { d.awarded = { ...(d.awarded || {}), [key]: true }; return d; });
      if (memoryEnabled()) storeEvidence(store, explainEvidence(p, { topic: store.data.lessons[lessonId]?.title || '' }));
      const pts = Math.max(0, Math.min(3, Number(p.score) || 0));
      if (pts && !(Number(p.attempt) > 0)) giveXp(pts * XP.explainPoint, `${pts}/3 on your explanation`);
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
      // web sources, or a cited page of the learner's own material (Phase 10)
      if (/^https?:\/\//i.test(p.url || '') || /^\/api\/materials\/file\?id=mat-[0-9a-f]{12}(#page=\d+)?$/.test(p.url || '')) window.open(p.url, '_blank', 'noopener,noreferrer');
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
  const form = el('form', { class: 'tutor-form', onsubmit: (e) => { e.preventDefault(); api.send(input.value); } }, el('div', { class: 'composer-box' }, input, sendBtn));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); api.send(input.value); } else if (e.key === 'Escape') api.onOpenChange?.(false); });
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
  input.addEventListener('input', autosize);
  const closeBtn = el('button', { class: 'icon-btn plain', type: 'button', 'aria-label': 'Close tutor', onclick: () => api.onOpenChange?.(false) }, icon('x'));
  const STARTERS = [
    ['list', 'Summarize the key ideas', 'Summarize the key ideas of this lesson in a few bullet points.'],
    ['book', 'Give me a real-world example', 'Give me a fresh real-world example of the main idea.'],
    ['target', 'Quiz me on this lesson', 'Quiz me on this lesson.'],
    ['quote', 'Explain it like I’m 12', 'Explain the main idea of this lesson like I am 12.'],
  ];
  const empty = el('div', { class: 'tutor-empty' },
    el('span', { class: 'tutor-avatar', 'aria-hidden': 'true' }, icon('quote')),
    el('p', null, 'Stuck on something? Ask about any part of the lesson, or highlight a passage and tap “Explain”.'),
    el('div', { class: 'tutor-starters' }, ...STARTERS.map(([ic, label, q]) => el('button', { class: 'tutor-starter', type: 'button', onclick: () => api.send(q) }, icon(ic), label))));
  // Phase 8: "Guide me" = Socratic tutoring (guiding questions before answers), remembered in settings
  const guided = () => store.data.settings?.tutorMode === 'socratic';
  const guideBtn = el('button', { class: 'guide-toggle', type: 'button', role: 'switch', 'aria-checked': String(guided()), title: 'Guide me: the tutor asks guiding questions instead of giving answers right away' },
    el('span', { class: 'switch small', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })), 'Guide me');
  guideBtn.addEventListener('click', () => {
    store.update((d) => { d.settings = { ...(d.settings || {}), tutorMode: guided() ? 'direct' : 'socratic' }; return d; });
    guideBtn.setAttribute('aria-checked', String(guided()));
    input.placeholder = guided() ? 'Ask, and the tutor will guide you to the answer…' : 'Ask anything about this lesson…';
    toast(guided() ? 'Guide me is on: the tutor asks before it tells' : 'Guide me is off');
  });
  if (guided()) input.placeholder = 'Ask, and the tutor will guide you to the answer…';
  const panel = el('aside', { class: 'tutor', 'aria-label': 'Lesson tutor' },
    el('header', { class: 'tutor-head' },
      el('div', { class: 'tutor-head-id' },
        el('span', { class: 'tutor-avatar small', 'aria-hidden': 'true' }, icon('quote')),
        el('div', null, el('strong', null, 'Tutor'), el('span', { class: 'muted small' }, status.mode === 'claude' ? 'Knows this lesson · Claude' : 'Knows this lesson · demo replies'))),
      el('div', { class: 'tutor-head-actions' }, guideBtn, closeBtn)),
    el('div', { class: 'tutor-scroll' }, empty, log, followups),
    form);
  const scrim = el('div', { class: 'tutor-scrim', 'aria-hidden': 'true', onclick: () => api.onOpenChange?.(false) });
  const fab = el('button', { class: 'tutor-fab btn', type: 'button', onclick: () => api.onOpenChange?.(true) }, icon('chat'), 'Ask tutor');
  const surfaces = [];
  let busy = false;
  let failed = null; // {rc, bot}: the reply waiting for a Retry (recoverable streams)
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

  // widget state: `index` of the saved tutor entry (null while the reply streams; the snapshot is
  // held in vsRef.pending and saved with the entry)
  function saveTutorViewState(i, v) {
    store.update((d) => {
      const t = d.lessons[lessonId]?.tutor;
      const m = t?.[i];
      if (m && m.role === 'assistant') { const { viewState: _old, ...rest } = m; t[i] = v ? { ...rest, viewState: v } : rest; }
      return d;
    });
  }

  const resetters = []; // one per tutor reply: clears its widgets, returns its graded quiz ids
  function addAssistant(index = null, viewState = null) {
    empty.hidden = true;
    const vsRef = { index, pending: null }; // widget state
    const mount = el('div', { class: 'msg-dil' });
    const typing = el('div', { class: 'typing', 'aria-label': 'Tutor is typing' }, el('i'), el('i'), el('i'));
    const wrapper = el('div', { class: 'msg msg-bot' }, el('span', { class: 'tutor-avatar small', 'aria-hidden': 'true' }, icon('quote')), el('div', { class: 'bot-body' }, typing, mount));
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
      viewState, // widget state
      onViewState: (vs) => { const v = hasViewState(vs) ? vs : null; if (vsRef.index == null) vsRef.pending = v; else saveTutorViewState(vsRef.index, v); },
    });
    surfaces.push(surface);
    resetters.push(() => {
      const graded = quizResolutionIds(appData);
      appData = {};
      vsRef.pending = null;
      if (dilRef) surface.setAppData(mergeComponentResults(dilRef.appData, null)); // grades first, then remount
      surface.resetViewState();
      return graded;
    });
    const body = wrapper.querySelector('.bot-body');
    return {
      typing,
      vsRef,
      body,
      retry: null, // the reply's retry control (recoverable streams)
      render(dil, animated) { dilRef = dil; surface.render({ code: dil.code, constants: dil.constants, appData: mergeComponentResults(dil.appData, appData.opGenui?.componentResults) }, { animated }); },
      /** A retry: drop the partial reply and show the typing dots again. */
      restart() { surface.host.clear(); dilRef = null; appData = {}; vsRef.pending = null; if (!typing.isConnected) body.insertBefore(typing, mount); },
    };
  }

  // restore transcript
  (lesson()?.tutor || []).forEach((m, i) => {
    if (m.role === 'user') addUser(m.content);
    else if (m.dil) { const a = addAssistant(i, m.viewState || null); a.typing.remove(); a.render(m.dil, false); }
  });
  const lastBot = [...(lesson()?.tutor || [])].reverse().find((m) => m.role === 'assistant');
  showFollowups(lastBot?.followups);

  const api = {
    /** Reset every tutor reply's widgets (and their saved state); returns graded quiz ids. */
    resetWidgets() {
      const graded = resetters.flatMap((f) => f());
      store.update((d) => {
        for (const m of d.lessons[lessonId]?.tutor || []) if (m?.role === 'assistant') delete m.viewState;
        return d;
      });
      return graded;
    },
    panel,
    fab,
    scrim,
    onOpenChange: null,
    focus() { setTimeout(() => input.focus(), 50); },
    /** Put text in the composer (e.g. a highlighted quote) and focus it. */
    prefill(text) { input.value = text; autosize(); setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 60); },
    async send(text) {
      const message = String(text || '').trim();
      if (!message || busy) return;
      const l = lesson();
      if (!l || l.status !== 'complete') { toast('Wait for the lesson to finish writing first'); return; }
      abandonFailed();
      input.value = '';
      input.style.height = 'auto';
      showFollowups([]);
      const history = (l.tutor || []).map((m) => ({ role: m.role, content: m.content }));
      addUser(message);
      const bot = addAssistant();
      scrollDown();
      await reply({ message, history, bot, turnId: uid('turn') });
    },
    destroy() { ac?.abort(); for (const s of surfaces) s.destroy(); },
  };

  // recoverable streams: a failed reply keeps the learner's message and gets one automatic
  // retry, then a Retry button on the reply itself. A retry re-sends the same message and
  // history under the same turnId (the server aborts any older request for it first).
  function abandonFailed() {
    if (!failed) return;
    failed.rc.hide();
    failed = null;
  }

  async function reply({ message, history, bot, turnId }, { auto = false } = {}) {
    busy = true;
    sendBtn.disabled = true;
    bot.retry?.hide();
    ac = new AbortController();
    let retryWith = null;
    try {
      const l = lesson();
      const useWebSearch = /\b(sources?|cite|citations?|latest|current(ly)?|recent(ly)?|news|today|this year|search|look (it )?up)\b/i.test(message); // Phase 3: tutor searches only when asked
      const r = await streamTurn('/api/tutor/stream', { message, history, lessonContext: { title: l.title, markdown: l.markdown }, useWebSearch, memoryEnabled: memoryEnabled(), mastery: requestMastery(store.data), mode: guided() ? 'socratic' : 'direct', streamKey: turnId }, {
        signal: ac.signal,
        onContent: (msg, rec) => {
          if (rec.dil) { bot.typing.remove(); bot.render(rec.dil, rec.status !== 'complete'); }
          scrollDown();
        },
      });
      if (r.failure) throw failureError(r.failure);
      const cur = lesson();
      const dil = r.message.dil ? { code: r.message.dil.code, constants: r.message.dil.constants, appData: r.message.dil.appData } : null;
      const prompts = r.final?.followupPrompts || [];
      bot.vsRef.index = (cur.tutor || []).length + 1; // widget state: later changes go to the saved entry
      saveLesson(lessonId, { tutor: [...(cur.tutor || []), { role: 'user', content: message }, { role: 'assistant', content: r.message.markdown, dil, followups: prompts, ...(bot.vsRef.pending ? { viewState: bot.vsRef.pending } : {}) }] });
      showFollowups(prompts);
    } catch (e) {
      if (!ac.signal.aborted) {
        bot.typing.remove();
        const rc = bot.retry || (bot.retry = retryControl({ className: 'msg-retry', onRetry: () => { abandonFailed(); bot.restart(); reply({ message, history, bot, turnId }); } }));
        bot.body.append(rc.el);
        if (e.retryable && !auto) {
          // the one automatic retry; the request that failed has already been aborted
          const go = await rc.countdown(retryDelay(0, { retryAfterMs: e.retryAfterMs }), e.message || 'Connection lost.', ac.signal);
          if (go) retryWith = true;
        } else {
          rc.show(e.message || 'Something went wrong.', 'Retry');
          failed = { rc, bot };
        }
      }
    } finally {
      busy = false;
      sendBtn.disabled = false;
      scrollDown();
    }
    if (retryWith) { bot.restart(); await reply({ message, history, bot, turnId }, { auto: true }); }
  }
  return api;
}

// ------------------------------------------------------------------ finish + pack opening

async function finishLesson(lessonId, btn, { onFinished } = {}) {
  const lesson = store.data.lessons[lessonId];
  if (!lesson || lesson.status !== 'complete') return;
  btn.disabled = true;
  const label = btn.lastChild.textContent;
  btn.lastChild.textContent = 'Collecting your cards…';
  try {
    const data = await postJson('/api/practice/extract', { lessonMarkdown: lesson.markdown });
    showPack(lesson, data, { onFinished });
    if (memoryEnabled() && !lesson.memoryExtracted) {
      saveLesson(lessonId, { memoryExtracted: true });
      const tutorThread = (lesson.tutor || []).filter((m) => m.role === 'user').map((m) => m.content);
      postJson('/api/memory/extract', { lessonTitle: lesson.title, quizResults: lesson.quizResults || [], tutorThread, memoryEnabled: true })
        .then((r) => { if (r.added?.length) setTimeout(() => toast(`Wonder will remember: ${r.added[0].fact}`, 4200), 1400); })
        .catch(() => {});
    }
  } catch (e) {
    toast(e.message || 'Could not create practice cards');
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = label;
  }
}

function showPack(lesson, data, { onFinished } = {}) {
  const cards = data.cards || [];
  const items = data.items || [];
  let opened = 0;
  const addBtn = el('button', { class: 'btn btn-lg', type: 'button' }, `File ${items.length} card${items.length === 1 ? '' : 's'} in my deck`);
  const sub = el('p', { class: 'pack-sub muted' }, 'Turn each card over to read it.');
  const grid = el('div', { class: 'pack-grid' }, ...cards.map((c, i) => {
    const card = el('button', { class: 'pack-card', type: 'button', style: { animationDelay: `${i * 70}ms` }, 'aria-label': `Turn over card ${i + 1}` },
      el('span', { class: 'pack-inner' },
        el('span', { class: 'pack-face pack-front' },
          el('span', { class: 'pack-no' }, `No. ${String(i + 1).padStart(2, '0')}`),
          el('span', { class: 'pack-front-title' }, lesson.title || lesson.topic),
          el('span', { class: 'pack-turn' }, 'Turn over')),
        el('span', { class: 'pack-face pack-back' },
          el('span', { class: 'pack-no' }, `No. ${String(i + 1).padStart(2, '0')}`),
          el('strong', null, c.term), el('span', { class: 'pack-def' }, inlineMd(c.definition)), c.example ? el('em', null, c.example) : null)));
    card.addEventListener('click', () => {
      if (card.classList.contains('flipped')) return;
      card.classList.add('flipped');
      card.setAttribute('aria-label', `${c.term}: ${c.definition}`);
      opened++;
      if (opened === cards.length) sub.textContent = 'All turned. File them to review them later.';
    });
    return card;
  }));
  const panel = el('div', { class: 'pack-panel' },
    el('p', { class: 'kicker' }, lesson.title || 'Lesson complete'),
    el('h2', { class: 'h-lg' }, `${cards.length} idea${cards.length === 1 ? '' : 's'} worth keeping`),
    sub,
    grid,
    el('div', { class: 'pack-actions' },
      el('button', { class: 'btn btn-secondary btn-lg', type: 'button', onclick: () => { for (const c of grid.children) c.click(); } }, 'Turn all'),
      addBtn));
  const overlay = el('div', { class: 'pack-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New index cards' }, panel);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
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
    const gained = first ? XP.lessonComplete + added * XP.cardsCollected : 0;
    if (gained) giveXp(gained, 'lesson finished');
    else toast(added ? `${added} new cards filed` : 'These cards are already in your deck');
    onFinished?.();
    // what next: the next course lesson, a review, or back to Today
    const day = dailyProgress(store.data.stats, store.data.settings);
    const nxt = lesson.courseId ? nextInCourse(lesson.courseId, lesson.id) : null;
    const due = deckStats(store.data.deck).due;
    const step = (title, sub2, onclick) => el('li', null, el('button', { class: 'numbered-row', type: 'button', onclick: () => { close(); onclick(); } },
      el('span', { class: 'numbered-kicker' }, sub2), el('span', { class: 'numbered-title' }, title)));
    panel.replaceChildren(el('div', { class: 'pack-done' },
      el('p', { class: 'kicker' }, 'Filed'),
      el('h2', { class: 'h-lg' }, `${added} card${added === 1 ? '' : 's'} added to your deck`),
      el('div', { class: 'ledger ledger-compact' },
        el('div', { class: 'ledger-item' }, el('span', { class: 'ledger-label' }, 'Earned'), el('span', { class: 'ledger-value' }, `+${gained}`, el('small', null, ' XP'))),
        el('div', { class: 'ledger-item' }, el('span', { class: 'ledger-label' }, 'Today'), el('span', { class: 'ledger-value' }, String(day.xp), el('small', null, ` / ${day.goal} XP`)), el('span', { class: `ledger-bar ${day.met ? 'met' : ''}`, 'aria-hidden': 'true' }, el('i', { style: { width: `${Math.round(day.pct * 100)}%` } })))),
      el('h3', { class: 'rubric' }, 'What next'),
      el('ol', { class: 'numbered' },
        nxt ? step(nxt.title, `Next in ${nxt.course.title}`, () => openCourseLesson(lesson.courseId, nxt.si, nxt.li)) : null,
        due ? step(`Review ${due} card${due === 1 ? '' : 's'} now`, 'Review', () => { location.hash = '#/review'; }) : null,
        step('Back to Today', 'Today', () => { location.hash = '#/'; }),
        step('Stay with this lesson', 'Reread, or ask the tutor', () => {}))));
    panel.querySelector('.numbered-row')?.focus();
  });
  document.body.append(overlay);
  teardown.push(close);
  setTimeout(() => grid.firstChild?.focus(), 80);
}

// ------------------------------------------------------------------ review + routing

function renderReviewScreen(lessonId = null) {
  const root = el('div', { class: 'review-wrap' });
  app.replaceChildren(root);
  const cleanup = renderReview(root, { store, lessonId, onExit: () => { location.hash = lessonId ? '#/you' : '#/'; }, onXp: () => { refreshChrome(); shell.bump(); } });
  if (typeof cleanup === 'function') teardown.push(cleanup);
}

function notFound() {
  app.replaceChildren(el('div', { class: 'card empty-state', style: { maxWidth: '560px', margin: '24px auto 0' } },
    el('h1', { class: 'h-lg' }, 'Not found'),
    el('p', { class: 'muted' }, 'This item is no longer stored in this browser.'),
    el('a', { class: 'btn', href: '#/' }, 'Back to Today')));
}

function route() {
  cleanupScreen();
  const h = location.hash || '#/';
  let m;
  let screen = 'home';
  // #/learn/<topic> starts a lesson on that topic (the landing page's composer links here). The
  // #/learn entry is replaced by Today first, so Back from the lesson goes home instead of
  // landing on #/learn again and starting another lesson. location.replace, not
  // history.replaceState: Next's router patches the latter and re-applies that URL afterwards.
  if ((m = /^#\/learn\/(.+)$/.exec(h))) {
    let t = '';
    try { t = decodeURIComponent(m[1]); } catch {}
    location.replace('#/');
    t = t.trim().slice(0, 200);
    if (ACCOUNTS && !localCache.account) beginSignIn(t); // an old link, signed out: sign in first
    else if (t) startLesson(t);
    return;
  }
  // #/start[/<topic>] is the landing page's "Continue with Google": sign in first, then onboarding
  // (offering the topic as the first lesson), then the lesson (public/start-core.js).
  if (/^#\/start(\/|$)/.test(h)) {
    const next = startAction({ accounts: ACCOUNTS, signedIn: !!localCache.account, needsOnboarding: needsOnboarding(store.data), topic: startTopic(h) });
    location.replace('#/');
    if (next.action === 'signin') beginSignIn(next.topic);
    else if (next.action === 'onboard') openOnboarding(next.topic);
    else if (next.action === 'lesson') startLesson(next.topic);
    return;
  }
  // #/signin opens sign-in over Today (the landing page's "Sign in" link; a plain / would send a
  // signed-out visitor back to the landing page).
  if (h === '#/signin') {
    location.replace('#/');
    beginSignIn();
    return;
  }
  if ((m = /^#\/lesson\/([\w-]+)$/.exec(h))) { screen = 'lesson'; document.body.dataset.screen = screen; renderLesson(m[1]); }
  else if ((m = /^#\/course\/([\w-]+)$/.exec(h))) { screen = 'course'; document.body.dataset.screen = screen; renderCourse(m[1]); }
  else if (h === '#/review') { screen = 'review'; document.body.dataset.screen = screen; renderReviewScreen(); }
  else if ((m = /^#\/review\/lesson\/([\w-]+)$/.exec(h))) { screen = 'review'; document.body.dataset.screen = screen; renderReviewScreen(m[1]); }
  else if ((m = /^#\/review\/course\/([\w-]+)$/.exec(h))) { screen = 'review'; document.body.dataset.screen = screen; renderCourseReview(screenCtx(), m[1]); }
  else if ((m = /^#\/teacher(?:\/([\w-]+))?$/.exec(h))) { screen = 'teacher'; document.body.dataset.screen = screen; renderTeacher(screenCtx(), m[1] || null); }
  else if (h === '#/library') { screen = 'library'; document.body.dataset.screen = screen; renderLibrary(screenCtx()); }
  else if (h === '#/you' || h === '#/memory' || h === '#/mastery' || h === '#/interests') { screen = 'you'; document.body.dataset.screen = screen; renderYou(screenCtx()); }
  else { document.body.dataset.screen = screen; renderToday(screenCtx()); }
  shell.setActive(screen);
  refreshChrome();
  if (h !== '#/memory' && h !== '#/mastery' && h !== '#/interests') window.scrollTo(0, 0);
  const titles = { home: 'Today', library: 'Library', review: 'Review', teacher: 'Teacher', you: 'You', course: 'Course', lesson: 'Lesson' };
  document.title = screen === 'home' ? 'Wonder' : `${titles[screen]} · Wonder`;
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => store.flush());
store.subscribe?.(() => refreshChrome());
applyFontScale();
observeMath(document.body);
refreshChrome();
loadStatus().then(() => {
  // A new account onboards first (the topic it brought waits in onboarding's last step); with
  // accounts on, onboarding only ever runs signed in.
  const afterSignIn = takeAfterSignIn();
  const onboard = needsOnboarding(store.data) && (!ACCOUNTS || !!localCache.account);
  if (afterSignIn && !onboard) startLesson(afterSignIn.topic, afterSignIn.level || undefined); // its hashchange routes
  else route();
  if (onboard) openOnboarding(afterSignIn?.topic || '');
  // account sync: changes from other devices redraw Today / Library when that cannot disturb reading
  onSyncStatus((s) => {
    if (s.state === 'synced' && s.applied && ['home', 'library'].includes(document.body.dataset.screen) && window.scrollY < 40 && !document.querySelector('.onboard, dialog[open]')) route();
    else refreshChrome();
  });
  startAccount({ store, toast }).catch((e) => console.warn('[wonder] account sync could not start', e));
});
