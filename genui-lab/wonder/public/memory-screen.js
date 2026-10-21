// Memory screen (#/memory): what Wonder remembers about the learner (Wondering's learner
// memory + teacher memory lines, findings §5). View, add and delete items, "Forget everything",
// and the "Use memory" switch (Wondering's noMemory flag) that sets memoryEnabled on requests.

import { el, icon, toast } from './ui.js';

const KINDS = [['goal', 'Goal'], ['preference', 'Preference'], ['struggle', 'Struggle'], ['background', 'Background']];
const SOURCE = { teacher: 'from your Teacher', lesson: 'from a lesson', user: 'added by you' };

async function api(method, body, query = '') {
  const res = await fetch(`/api/memory${query}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/** The memory section (switch, add form, grouped items, forget all), as one element. */
export function memoryPanel(ctx) {
  const { store } = ctx;
  const on = () => store.data.settings?.memoryEnabled !== false;
  const list = el('div', { class: 'mem-list', 'aria-live': 'polite' }, el('p', { class: 'muted' }, 'Loading…'));
  const toggle = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on()), 'aria-label': 'Use memory' }, el('span', { class: 'switch-knob' }));
  const toggleNote = el('p', { class: 'muted small' });
  const setToggle = () => {
    toggle.setAttribute('aria-checked', String(on()));
    toggleNote.textContent = on()
      ? 'On: lessons, the tutor and your Teacher see the facts below and personalize to them.'
      : 'Off: nothing below is sent with your requests, and nothing new is remembered.';
  };
  toggle.addEventListener('click', () => {
    store.update((d) => { d.settings = { ...(d.settings || {}), memoryEnabled: !on() }; return d; });
    store.flush();
    setToggle();
    toast(on() ? 'Memory is on' : 'Memory is off');
  });
  setToggle();

  const fact = el('input', { type: 'text', maxlength: '200', placeholder: 'e.g. I learn best with worked examples', 'aria-label': 'Something Wonder should remember' });
  const kind = el('select', { 'aria-label': 'Kind' }, ...KINDS.map(([v, l]) => el('option', { value: v }, l)));
  kind.value = 'preference';
  const addBtn = el('button', { class: 'btn', type: 'submit' }, icon('plus'), 'Add');
  const form = el('form', { class: 'mem-add', onsubmit: async (e) => {
    e.preventDefault();
    const f = fact.value.trim();
    if (!f) { fact.focus(); return; }
    addBtn.disabled = true;
    try {
      const r = await api('POST', { fact: f, kind: kind.value });
      fact.value = '';
      toast(r.duplicate ? 'Wonder already remembers that' : 'Remembered');
      draw(r.items);
    } catch (err) { toast(err.message); } finally { addBtn.disabled = false; }
  } }, fact, kind, addBtn);

  const forgetAll = el('button', { class: 'btn btn-secondary btn-danger', type: 'button', onclick: async () => {
    if (!confirm('Forget everything Wonder remembers about you? This cannot be undone.')) return;
    try { const r = await api('DELETE', { all: true }); toast(`Forgot ${r.removed} item${r.removed === 1 ? '' : 's'}`); draw([]); } catch (err) { toast(err.message); }
  } }, icon('trash'), 'Forget everything');

  function draw(items) {
    forgetAll.disabled = !items.length;
    if (!items.length) {
      list.replaceChildren(el('div', { class: 'mem-empty' }, el('p', { class: 'muted' }, 'Nothing yet. Tell your Teacher about your goals, or add a fact above. After each lesson Wonder may note what you found tricky.')));
      return;
    }
    list.replaceChildren(...KINDS.map(([k, label]) => {
      const group = items.filter((i) => i.kind === k);
      if (!group.length) return null;
      return el('section', { class: 'mem-group' },
        el('h3', { class: 'h-sm' }, `${label}${group.length > 1 ? 's' : ''}`),
        el('ul', { class: 'mem-items' }, ...group.map((i) => el('li', { class: 'mem-item' },
          el('div', { class: 'mem-text' },
            el('span', null, i.fact),
            el('span', { class: 'muted small' }, `${SOURCE[i.source] || ''} · ${new Date(i.createdAt).toLocaleDateString()}`)),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Forget: ${i.fact}`, onclick: async () => {
            try { const r = await api('DELETE', null, `?id=${encodeURIComponent(i.id)}`); toast('Forgotten'); draw(r.items); } catch (err) { toast(err.message); }
          } }, icon('trash'))))));
    }).filter(Boolean));
  }

  api('GET').then((r) => draw(r.items)).catch((e) => list.replaceChildren(el('p', { class: 'error-text' }, e.message)));
  return el('div', { class: 'memory-page', id: 'memory' },
    el('header', { class: 'card mem-head' },
      el('div', { class: 'mem-head-row' },
        el('span', { class: 'icon-tile', 'aria-hidden': 'true' }, icon('brain')),
        el('div', null, el('h2', { class: 'h-md' }, 'Memory'), el('p', { class: 'muted small' }, 'A few facts that personalize your lessons, tutor and Teacher. Stored by your local Wonder server.'))),
      el('div', { class: 'mem-toggle' }, el('div', null, el('strong', null, 'Use memory'), toggleNote), toggle),
      form),
    list,
    el('div', { class: 'mem-foot' }, forgetAll));
}

/** #/memory: kept for old links; the panel now lives on the You screen. */
export function renderMemory(ctx) {
  ctx.app.replaceChildren(el('div', { class: 'you' }, el('a', { class: 'back-link', href: '#/you' }, icon('arrow-left'), 'You'), memoryPanel(ctx)));
}
