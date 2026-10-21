// Phase 4: the lesson screen's "Steer" composer, shown only while a lesson streams.
// Sends POST /api/lesson/steer {operationId, instruction}; the outcome arrives on the lesson's
// own NDJSON stream as control records (steering-status / steering-message), and the kept
// pages + new tail arrive as an ordinary `replace` content record.

import { el, icon, toast } from './ui.js';
import { postJson } from './stream-client.js';
import { STEER_CHIPS, MAX_STEER_CHARS, steerReducer } from './steering-core.js';

export function createSteerBar() {
  let operationId = null;
  let state = steerReducer(null, {});
  const status = el('span', { class: 'steer-status', 'aria-live': 'polite' }, 'Change the lesson while it is being written');
  const input = el('input', { type: 'text', maxlength: String(MAX_STEER_CHARS), placeholder: 'e.g. focus on real examples', 'aria-label': 'Steer the lesson' });
  const sendBtn = el('button', { class: 'btn btn-sm', type: 'submit' }, icon('send'), 'Steer');
  const chips = STEER_CHIPS.map((c) => el('button', { class: 'steer-chip', type: 'button', onclick: () => steer(c.instruction, c.label) }, c.label));
  const form = el('form', { class: 'steer-bar', hidden: true, onsubmit: (e) => { e.preventDefault(); steer(input.value, input.value); } },
    el('div', { class: 'steer-head' }, icon('sparkles'), el('strong', null, 'Steer'), status),
    el('div', { class: 'steer-chips' }, ...chips),
    el('div', { class: 'steer-row' }, input, sendBtn));

  const setBusy = (busy) => { for (const b of [...chips, sendBtn]) b.disabled = busy; input.disabled = busy; };

  async function steer(instruction, label) {
    const text = String(instruction || '').trim();
    if (!text) { input.focus(); return; }
    if (!operationId) { toast('The lesson has not started yet'); return; }
    state = steerReducer(state, { type: 'request', instruction: text });
    setBusy(true);
    status.textContent = `Steering: ${String(label || text).slice(0, 60)}…`;
    try {
      await postJson('/api/lesson/steer', { operationId, instruction: text });
      input.value = '';
    } catch (e) {
      state = steerReducer(state, { type: 'rejected', reason: e.message });
      status.textContent = e.message || 'Could not steer right now';
      setBusy(false);
    }
  }

  return {
    el: form,
    get state() { return state; },
    /** Feed every control record of the lesson stream. */
    onControl(detail) {
      if (detail?.operationId && !operationId) operationId = detail.operationId;
      if (detail?.kind !== 'steering-status') return;
      state = steerReducer(state, { type: 'control', detail });
      setBusy(false);
      status.textContent = detail.status === 'accepted'
        ? `Rewriting the rest: ${String(detail.instruction || '').slice(0, 60)}`
        : 'That change could not be applied';
      if (detail.status === 'accepted') toast('Steering the lesson');
    },
    show() { form.hidden = false; },
    hide() { form.hidden = true; operationId = null; state = steerReducer(state, { type: 'complete' }); setBusy(false); },
  };
}
