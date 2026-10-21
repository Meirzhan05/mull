// Phase 4: the lesson screen's "Steer" composer. Three modes, same chips + input:
//
//   live    while a lesson streams: POST /api/lesson/steer {operationId, instruction}. The
//           outcome arrives on the lesson's own NDJSON stream as control records
//           (steering-status / steering-message) and the kept pages + new tail as an ordinary
//           `replace` content record. A 409 not_streaming (Claude already finished) falls back
//           to onContinue({instruction}) automatically.
//   revise  a finished lesson: "Revise from this page" (the page in view -> fromPage).
//   resume  an interrupted lesson (reload, closed tab, network drop): "Resume lesson", or
//           resume with a change. It continues from the last complete paragraph.
//   elsewhere  another tab holds the lesson's lock (public/lesson-lock.js) and is writing it:
//           a notice only, no chips, input or Resume.
//
// revise and resume call onContinue({instruction, fromPage?}); the screen then streams
// POST /api/lesson/stream {continueFrom}.

import { el, icon, toast } from './ui.js';
import { STEER_CHIPS, MAX_STEER_CHARS, steerReducer } from './steering-core.js';

const HEAD = {
  live: ['Steer', 'Change the lesson while it is being written'],
  revise: ['Revise from this page', ''],
  resume: ['Lesson interrupted', 'It stopped before the end. Resume it, or resume with a change:'],
  elsewhere: ['Writing in another tab', 'This lesson is being written in another tab. This page updates when it finishes.'],
};

export function createSteerBar({ onContinue, onMode, onOpen } = {}) {
  let mode = 'hidden';
  let operationId = null;
  let page = { n: 0, title: '' }; // set by the screen (setPage) before the first revise
  let state = steerReducer(null, {});
  const title = el('strong', null, 'Steer');
  const status = el('span', { class: 'steer-status', 'aria-live': 'polite' });
  const input = el('input', { type: 'text', maxlength: String(MAX_STEER_CHARS), placeholder: 'e.g. focus on real examples', 'aria-label': 'Steer the lesson' });
  const sendBtn = el('button', { class: 'btn btn-sm', type: 'submit' }, icon('send'), el('span', null, 'Steer'));
  const chips = STEER_CHIPS.map((c) => el('button', { class: 'steer-chip', type: 'button', onclick: () => steer(c.instruction, c.label) }, c.label));
  const resumeBtn = el('button', { class: 'btn btn-sm steer-resume', type: 'button', onclick: () => resume() }, icon('play'), 'Resume lesson');
  const openBtn = el('button', { class: 'steer-open', type: 'button', 'aria-expanded': 'false', onclick: () => setOpen(true) }, icon('sparkles'), el('span', { class: 'steer-open-text' }, 'Revise from this page'));
  const closeBtn = el('button', { class: 'icon-btn steer-close', type: 'button', 'aria-label': 'Close', onclick: () => setOpen(false) }, icon('x'));
  const body = el('div', { class: 'steer-body' },
    el('div', { class: 'steer-chips' }, ...chips),
    el('div', { class: 'steer-row' }, input, sendBtn));
  const head = el('div', { class: 'steer-head' }, icon('sparkles'), title, status, resumeBtn, closeBtn);
  const form = el('form', { class: 'steer-bar', hidden: true, onsubmit: (e) => { e.preventDefault(); steer(input.value, input.value); } },
    openBtn,
    head,
    body);

  const setBusy = (busy) => { for (const b of [...chips, sendBtn, resumeBtn]) b.disabled = busy; input.disabled = busy; };
  const pageLabel = () => `Rewrites page ${Math.max(1, page.n)}${page.title ? ` “${page.title.slice(0, 48)}”` : ''} and everything after it`;

  function setOpen(open) {
    form.classList.toggle('is-open', open);
    openBtn.setAttribute('aria-expanded', String(open));
    if (open) { onOpen?.(); input.focus({ preventScroll: true }); }
  }

  function setMode(next) {
    mode = next;
    onMode?.(next, form);
    form.hidden = next === 'hidden';
    form.dataset.mode = next;
    if (next === 'live') operationId = null;
    const [t, s] = HEAD[next] || HEAD.live;
    title.textContent = t;
    status.textContent = next === 'revise' ? pageLabel() : s;
    resumeBtn.hidden = next !== 'resume';
    closeBtn.hidden = next !== 'revise';
    body.hidden = next === 'elsewhere';
    // the notice gets its own wrapping row, like resume mode (inline: no extras.css rule for this mode)
    const notice = next === 'elsewhere';
    head.style.flexWrap = notice ? 'wrap' : '';
    head.style.rowGap = notice ? '4px' : '';
    Object.assign(status.style, { whiteSpace: notice ? 'normal' : '', flex: notice ? '1 0 100%' : '', order: notice ? '5' : '' });
    sendBtn.lastChild.textContent = next === 'live' ? 'Steer' : next === 'resume' ? 'Resume' : 'Revise';
    input.placeholder = next === 'revise' ? 'e.g. use a cooking analogy' : 'e.g. focus on real examples';
    setOpen(next !== 'revise');
    setBusy(false);
  }

  function resume() {
    state = steerReducer(state, { type: 'request', instruction: '' });
    setBusy(true);
    status.textContent = 'Resuming…';
    onContinue?.({ instruction: '' });
  }

  async function steer(instruction, label) {
    const text = String(instruction || '').trim();
    if (!text) { input.focus(); return; }
    const short = String(label || text).slice(0, 60);
    if (mode === 'revise' || mode === 'resume') {
      state = steerReducer(state, { type: 'request', instruction: text });
      setBusy(true);
      status.textContent = mode === 'revise' ? `Rewriting from page ${page.n}: ${short}…` : `Resuming: ${short}…`;
      input.value = '';
      onContinue?.(mode === 'revise' ? { instruction: text, fromPage: Math.max(1, page.n) } : { instruction: text });
      return;
    }
    if (!operationId) { toast('The lesson has not started yet'); return; }
    state = steerReducer(state, { type: 'request', instruction: text });
    setBusy(true);
    status.textContent = `Steering: ${short}…`;
    let res = null;
    let data = null;
    try {
      res = await fetch('/api/lesson/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId, instruction: text }) });
      data = await res.json().catch(() => null);
    } catch { /* network: handled below */ }
    if (res?.ok && data?.ok) { input.value = ''; return; } // the stream reports the outcome
    if (res?.status === 409 && data?.reason === 'not_streaming') {
      // Claude finished before the steer landed: apply it as a continuation of the lesson
      input.value = '';
      status.textContent = `Applying after the last page: ${short}…`;
      onContinue?.({ instruction: text, fallback: true });
      return;
    }
    state = steerReducer(state, { type: 'rejected', reason: data?.reason || 'error' });
    status.textContent = data?.error || 'Could not steer right now';
    setBusy(false);
  }

  return {
    el: form,
    get state() { return state; },
    get mode() { return mode; },
    setMode,
    /** Revise mode: the page currently in view (1-based) and its heading. */
    setPage(n, pageTitle = '') {
      if (n === page.n && pageTitle === page.title) return;
      page = { n, title: pageTitle };
      openBtn.lastChild.textContent = n > 1 ? `Revise from page ${n}` : 'Revise this lesson';
      if (mode === 'revise' && !input.disabled) status.textContent = pageLabel();
    },
    /** Feed every control record of the lesson stream. */
    onControl(detail) {
      if (detail?.operationId && !operationId) operationId = detail.operationId;
      if (detail?.kind !== 'steering-status') return;
      state = steerReducer(state, { type: 'control', detail });
      setBusy(false);
      if (detail.status !== 'accepted') { status.textContent = 'That change could not be applied'; return; }
      status.textContent = detail.resume ? 'Resuming where the lesson stopped' : `Rewriting the rest: ${String(detail.instruction || '').slice(0, 60)}`;
      toast(detail.resume ? 'Resuming the lesson' : 'Steering the lesson');
    },
    /** A continuation could not start: back to the previous mode with a message. */
    fail(message) {
      state = steerReducer(state, { type: 'rejected', reason: 'error' });
      setBusy(false);
      status.textContent = message || 'Could not continue right now';
    },
    setStatus(text) { status.textContent = text; },
    show() { setMode('live'); },
    hide() { setMode('hidden'); state = steerReducer(state, { type: 'complete' }); },
  };
}
