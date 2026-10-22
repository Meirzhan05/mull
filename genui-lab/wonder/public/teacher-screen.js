// Teacher screen (#/teacher, #/teacher/<threadId>): Wondering's Teacher tab (findings §2.3)
// with a thread list and a chat whose replies are streamed DIL programs. Tool results arrive
// as server-resolved TeacherCards (appData.opGenui.componentResults); their buttons round-trip
// through /api/widget_action and may return client actions (start a lesson, save a plan, …).
// Threads, compiled programs and card states persist in localStorage.

import { uid } from './store.js';
import { DilSurface, mergeComponentResults } from './dil-surface.js';
import { hasViewState } from './view-state.js';
import { streamTurn, postJson } from './stream-client.js';
import { XP, dateKey } from './deck.js';
import { el, icon, toast } from './ui.js';
import { progressSnapshot, historyForModel, threadTitle, TEACHER_OPENER } from './teacher-core.js';

const STARTERS = [
  ['calendar', 'I want to get good at statistics in a week. I already know basic algebra.'],
  ['sparkles', 'What should I study today?'],
  ['target', 'Quiz me on my last lesson'],
  ['layers', 'Make me a 5-day plan to learn the basics of Spanish'],
];

let pendingMessage = null;
/** Open a thread (or a new chat) and send a message as soon as it renders. */
export function queueTeacherMessage(text) { pendingMessage = String(text || ''); }
let pendingOpener = false;
/** Phase 7: open the Teacher with a check-in turn (the Teacher speaks first). */
export function queueTeacherOpener() { pendingOpener = true; }

function relTime(iso) {
  const ms = Date.now() - Date.parse(iso || 0);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/**
 * @param {{app: HTMLElement, store: object, status: object, teardown: Function[], createLesson: Function, giveXp: Function}} ctx
 * @param {string|null} threadId
 */
export function renderTeacher(ctx, threadId) {
  const { app, store, status } = ctx;
  let thread = threadId ? store.data.teacherThreads.find((t) => t.id === threadId) || null : null;
  if (threadId && !thread) { location.replace('#/teacher'); return; }
  const memoryOn = () => store.data.settings?.memoryEnabled !== false;

  // -- chrome
  const listEl = el('ul', { class: 'thread-list' });
  const threadsPanel = el('aside', { class: 'threads card', 'aria-label': 'Teacher chats' },
    el('div', { class: 'threads-head' },
      el('strong', null, 'Chats'),
      el('a', { class: 'btn btn-sm', href: '#/teacher', onclick: (e) => { if (location.hash === '#/teacher') { e.preventDefault(); ctx.reroute(); } } }, icon('plus'), 'New')),
    listEl);
  const log = el('div', { class: 'teacher-log', 'aria-live': 'polite' });
  const followups = el('div', { class: 'followups teacher-followups' });
  const input = el('textarea', { rows: '1', maxlength: '4000', placeholder: 'Message your Teacher…', 'aria-label': 'Message your Teacher' });
  const sendBtn = el('button', { class: 'btn send-btn', type: 'submit', 'aria-label': 'Send' }, icon('send'));
  const form = el('form', { class: 'teacher-form', onsubmit: (e) => { e.preventDefault(); send(input.value); } }, el('div', { class: 'composer-box' }, input, sendBtn));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; });
  const toggleThreads = el('button', { class: 'icon-btn threads-toggle', type: 'button', 'aria-label': 'Show chats', 'aria-expanded': 'false' }, icon('menu'));
  const memChip = el('a', { class: `mem-chip ${memoryOn() ? 'on' : ''}`, href: '#/memory', title: 'Learner memory' }, icon('brain'), memoryOn() ? 'Memory on' : 'Memory off');
  const empty = el('div', { class: 'teacher-empty' },
    el('span', { class: 'tutor-avatar big', 'aria-hidden': 'true' }, icon('teacher')),
    el('h1', { class: 'h-lg' }, 'Your Teacher'),
    el('p', { class: 'muted' }, 'Tell me what you want to get good at. I can plan your week, suggest the next lesson, quiz you, and remember what matters to you. I can see your progress, streak and review deck.'),
    el('div', { class: 'starter-grid' }, ...STARTERS.map(([ic, q]) => el('button', { class: 'starter', type: 'button', onclick: () => send(q) }, icon(ic), q))));
  const scroller = el('div', { class: 'teacher-scroll' }, empty, log, followups);
  const main = el('section', { class: 'teacher-main card' },
    el('header', { class: 'teacher-head' },
      toggleThreads,
      el('div', { class: 'teacher-head-mid' },
        el('strong', { class: 'teacher-title' }, thread?.title || 'New chat'),
        el('span', { class: 'muted small' }, status.mode === 'claude' ? 'Teacher · Claude' : 'Teacher · demo replies')),
      memChip),
    scroller,
    form);
  const layout = el('div', { class: 'teacher-layout' }, threadsPanel, main);
  app.replaceChildren(layout);
  toggleThreads.addEventListener('click', () => {
    const open = !layout.classList.contains('threads-open');
    layout.classList.toggle('threads-open', open);
    toggleThreads.setAttribute('aria-expanded', String(open));
  });

  function renderThreadList() {
    const threads = store.data.teacherThreads.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    listEl.replaceChildren(...(threads.length ? threads.map((t) => el('li', { class: `thread-row ${thread && t.id === thread.id ? 'active' : ''}` },
      el('a', { href: `#/teacher/${t.id}`, class: 'thread-link' }, el('span', { class: 'thread-title' }, t.title), el('span', { class: 'muted small' }, relTime(t.updatedAt))),
      el('button', { class: 'icon-btn thread-del', type: 'button', 'aria-label': `Delete chat ${t.title}`, onclick: () => {
        if (!confirm('Delete this chat?')) return;
        store.update((d) => { d.teacherThreads = d.teacherThreads.filter((x) => x.id !== t.id); return d; });
        if (thread?.id === t.id) location.hash = '#/teacher'; else renderThreadList();
      } }, icon('trash'))))
      : [el('li', { class: 'muted small thread-empty' }, 'No chats yet.')]));
  }
  renderThreadList();

  // -- messages
  const surfaces = [];
  let busy = false;
  let ac = null;
  ctx.teardown.push(() => { ac?.abort(); for (const s of surfaces) s.destroy(); });
  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };
  const showFollowups = (list) => followups.replaceChildren(...(list || []).map((q) => el('button', { class: 'followup-chip', type: 'button', onclick: () => send(q) }, q)));

  function persist() {
    if (!thread) return;
    thread.updatedAt = new Date().toISOString();
    store.update((d) => {
      const i = d.teacherThreads.findIndex((t) => t.id === thread.id);
      if (i >= 0) d.teacherThreads[i] = thread; else d.teacherThreads.unshift(thread);
      return d;
    });
  }

  function addUser(text) {
    empty.hidden = true;
    log.append(el('div', { class: 'msg msg-user' }, el('div', { class: 'bubble' }, text)));
  }

  /** One assistant message: its own sandbox surface, status line, and card actions. */
  function addAssistant(msg) {
    empty.hidden = true;
    const mount = el('div', { class: 'msg-dil' });
    const statusLine = el('div', { class: 'reasoning small-reasoning', hidden: true }, el('span', { class: 'reasoning-dot', 'aria-hidden': 'true' }), el('span', { class: 'reasoning-text shimmer' }));
    const typing = el('div', { class: 'typing', 'aria-label': 'Teacher is typing' }, el('i'), el('i'), el('i'));
    const body = el('div', { class: 'bot-body' }, statusLine, typing, mount);
    log.append(el('div', { class: 'msg msg-bot' }, el('span', { class: 'tutor-avatar small', 'aria-hidden': 'true' }, icon('teacher')), body));
    const state = { msg, dil: msg?.dil || null, pendingViewState: null };
    const appData = () => mergeComponentResults(state.dil?.appData, state.msg?.componentResults);
    const surface = new DilSurface(mount, {
      onAction: (a) => onAction(a, state, surface, appData),
      // widget state (view-state.js): saved on the message entry; held until the reply is saved
      viewState: msg?.viewState || null,
      onViewState: (vs) => {
        const v = hasViewState(vs) ? vs : null;
        if (!state.msg) { state.pendingViewState = v; return; }
        if (v) state.msg.viewState = v; else delete state.msg.viewState;
        persist();
      },
    });
    surfaces.push(surface);
    return {
      state,
      body,
      status(text) { if (!text) { statusLine.hidden = true; return; } statusLine.hidden = false; statusLine.lastChild.textContent = text; },
      done() { typing.remove(); statusLine.hidden = true; },
      render(dil, animated) { state.dil = dil; typing.remove(); surface.render({ code: dil.code, constants: dil.constants, appData: appData() }, { animated }); },
    };
  }

  async function onAction(a, st, surface, appData) {
    const p = a.payload || {};
    if (a.handler === 'server') {
      if (!st.msg) { toast('Wait for the reply to finish'); return; }
      try {
        const res = await postJson('/api/widget_action', { componentName: a.componentName, action_type: a.type, payload: p, resolutionId: a.nativeWidgetResolutionId });
        if (res.componentResults) {
          st.msg.componentResults = { ...(st.msg.componentResults || {}), ...res.componentResults };
          syncSavedPlans(res.componentResults);
          persist();
          surface.setAppData(appData());
        }
        for (const ca of res.clientActions || []) runClientAction(ca);
        if (res.issueTurn?.message) send(res.issueTurn.message);
      } catch (e) { toast(e.message || 'That action failed'); }
      return;
    }
    switch (a.type) {
      case 'issue_new_turn': if (p.query) send(String(p.query)); break;
      case 'quiz_complete': {
        const key = `teacher:${thread?.id}:${p.resolutionId}`;
        if (store.data.awarded?.[key]) break;
        store.update((d) => { d.awarded = { ...(d.awarded || {}), [key]: true }; return d; });
        ctx.giveXp((Number(p.score) || 0) * XP.quizCorrect, `${p.score}/${p.total} on the quiz`);
        break;
      }
      case 'open_url': if (/^https?:\/\//i.test(p.url || '') || /^\/api\/materials\/file\?id=mat-[0-9a-f]{12}(#page=\d+)?$/.test(p.url || '')) window.open(p.url, '_blank', 'noopener,noreferrer'); break;
      default:
    }
  }

  /** Keep the saved copy of a plan (home screen) in step with its card. */
  function syncSavedPlans(results) {
    store.update((d) => {
      for (const [rid, r] of Object.entries(results)) {
        const i = (d.plans || []).findIndex((x) => x.id === rid);
        if (i >= 0 && r.state?.kind === 'plan') d.plans[i] = { ...d.plans[i], goal: r.state.goal, days: r.state.days };
      }
      return d;
    });
  }

  function runClientAction(ca) {
    const p = ca.payload || {};
    switch (ca.type) {
      case 'start_lesson': {
        const known = p.resolutionId && store.data.teacherLessons?.[p.resolutionId];
        if (known && store.data.lessons[known]) { location.hash = `#/lesson/${known}`; return; }
        const id = ctx.createLesson({ topic: p.topic, title: p.title || p.topic, level: p.level || 'beginner', teacherThreadId: thread?.id || null });
        if (p.resolutionId) store.update((d) => { d.teacherLessons = { ...(d.teacherLessons || {}), [p.resolutionId]: id }; return d; });
        store.flush();
        location.hash = `#/lesson/${id}`;
        return;
      }
      case 'save_plan':
        store.update((d) => {
          // Phase 7: the plan keeps its calendar dates (startDate) and deadline
          d.plans = [{ id: p.resolutionId, threadId: thread?.id || null, goal: p.plan?.goal, startDate: p.plan?.startDate || undefined, deadline: p.plan?.deadline || undefined, days: p.plan?.days || [], savedAt: new Date().toISOString() }, ...(d.plans || []).filter((x) => x.id !== p.resolutionId)].slice(0, 5);
          return d;
        });
        toast('Plan saved to your home screen');
        return;
      case 'unsave_plan':
        store.update((d) => { d.plans = (d.plans || []).filter((x) => x.id !== p.resolutionId); return d; });
        toast('Plan removed from home');
        return;
      case 'open_review': location.hash = '#/review'; return;
      case 'issue_new_turn': if (p.query) send(String(p.query)); return;
      default:
    }
  }

  // -- restore
  for (const m of thread?.messages || []) {
    if (m.role === 'user') { if (!m.opener) addUser(m.content); }
    else if (m.dil) { const a = addAssistant(m); a.done(); a.render(m.dil, false); }
    else if (m.content) { const a = addAssistant(m); a.done(); a.body.append(el('p', { class: 'muted small' }, 'This reply was archived to save space.')); }
  }
  showFollowups([...(thread?.messages || [])].reverse().find((m) => m.role === 'assistant')?.followups);
  setTimeout(scrollDown, 0);

  // -- send
  async function send(text, { opener = false } = {}) {
    const message = opener ? TEACHER_OPENER : String(text || '').trim();
    if (!message || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';
    showFollowups([]);
    if (!thread) {
      thread = { id: uid('thread'), title: opener ? `Check-in · ${new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : threadTitle(message), messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      history.replaceState(null, '', `#/teacher/${thread.id}`);
      main.querySelector('.teacher-title').textContent = thread.title;
    }
    const history2 = historyForModel(thread.messages);
    thread.messages.push({ role: 'user', content: message, ...(opener ? { opener: true } : {}) });
    persist();
    renderThreadList();
    if (!opener) addUser(message);
    const bot = addAssistant(null);
    scrollDown();
    ac = new AbortController();
    try {
      const r = await streamTurn('/api/teacher/stream', { threadId: thread.id, history: history2, ...(opener ? { opener: true } : { message }), progress: progressSnapshot(store.data), memoryEnabled: memoryOn() }, {
        signal: ac.signal,
        onReasoning: (s) => bot.status(s.active === false ? '' : s.text),
        onContent: (msg, rec) => { if (rec.dil) bot.render(rec.dil, rec.status !== 'complete'); scrollDown(); },
      });
      if (r.failure) throw new Error(r.failure.message || 'The Teacher could not answer');
      bot.done();
      const d = r.message.dil;
      const dil = d ? { code: d.code, constants: d.constants, appData: d.appData } : null;
      const entry = { role: 'assistant', content: r.message.markdown, dil, componentResults: d?.appData?.opGenui?.componentResults || {}, followups: r.final?.followupPrompts || [], ...(bot.state.pendingViewState ? { viewState: bot.state.pendingViewState } : {}) };
      bot.state.msg = entry;
      thread.messages.push(entry);
      persist();
      store.flush();
      showFollowups(entry.followups);
      if (r.final?.debug?.truncated) toast('The reply was cut short (length limit).');
    } catch (e) {
      if (!ac.signal.aborted) {
        bot.done();
        bot.body.append(el('p', { class: 'error-text' }, e.message || 'Something went wrong.'));
        thread.messages.pop(); // let the learner resend
        persist();
        if (!opener) input.value = message;
      }
    } finally {
      busy = false;
      sendBtn.disabled = false;
      scrollDown();
      renderThreadList();
    }
  }

  // Phase 7: a check-in asked for from Today, or the first visit of the day to a new chat
  const today = dateKey(new Date());
  const autoCheckIn = !thread && store.data.settings?.teacherCheckIn !== false && store.data.settings?.lastCheckIn !== today && Object.keys(store.data.lessons || {}).length > 0;
  if (pendingMessage) { const m = pendingMessage; pendingMessage = null; pendingOpener = false; send(m); }
  else if (pendingOpener || autoCheckIn) {
    pendingOpener = false;
    store.update((d) => { d.settings = { ...(d.settings || {}), lastCheckIn: today }; return d; });
    send('', { opener: true });
  } else setTimeout(() => input.focus(), 60);
}
