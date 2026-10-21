// First-run welcome: name, interests (they drive Today's topic suggestions) and a daily goal.
// Three short steps, skippable at any point; the choices live in store.settings.

import { el, icon } from './ui.js';
import { INTERESTS, DAILY_GOALS, DEFAULT_GOAL } from './progress-core.js';

export function needsOnboarding(data) {
  return !data.settings?.onboarded && !Object.keys(data.lessons || {}).length && !(data.courses || []).length;
}

export function showOnboarding({ store, onDone }) {
  const pick = { name: '', interests: new Set(), dailyGoal: DEFAULT_GOAL };
  let step = 0;
  const panel = el('div', { class: 'onboard', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'onboard-title' });
  const overlay = el('div', { class: 'modal-overlay' }, panel);

  function finish(skipped = false) {
    store.update((d) => {
      d.settings = { ...(d.settings || {}), onboarded: true, ...(skipped ? {} : { name: pick.name.trim(), interests: [...pick.interests], dailyGoal: pick.dailyGoal }) };
      return d;
    });
    store.flush();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onDone?.();
  }
  const onKey = (e) => { if (e.key === 'Escape') finish(true); };
  document.addEventListener('keydown', onKey);

  function draw() {
    const steps = el('div', { class: 'onboard-steps', 'aria-hidden': 'true' }, ...[0, 1, 2].map((i) => el('i', { class: i <= step ? 'on' : '' })));
    const skip = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => finish(true) }, 'Skip');
    if (step === 0) {
      const input = el('input', { class: 'onboard-input', type: 'text', maxlength: '40', placeholder: 'Your first name (optional)', value: pick.name, 'aria-label': 'Your name' });
      const next = el('button', { class: 'btn btn-lg', type: 'submit' }, 'Continue', icon('arrow-right'));
      panel.replaceChildren(steps,
        el('span', { class: 'brand-mark', style: { width: '48px', height: '48px', borderRadius: '15px' }, 'aria-hidden': 'true' }, markSvg()),
        el('div', { style: { display: 'grid', gap: '8px' } },
          el('h1', { class: 'h-lg', id: 'onboard-title' }, 'Welcome to Wonder'),
          el('p', { class: 'muted' }, 'Ask about anything and get a short, interactive lesson written for you, with a tutor on hand and reviews spaced so it sticks.')),
        el('form', { style: { display: 'grid', gap: '14px' }, onsubmit: (e) => { e.preventDefault(); pick.name = input.value; step = 1; draw(); } },
          el('label', { class: 'h-sm', style: { textTransform: 'none', letterSpacing: 0, fontSize: '0.9rem', color: 'var(--ink-2)' } }, 'What should we call you?'),
          input,
          el('div', { class: 'onboard-actions' }, skip, next)));
      setTimeout(() => input.focus(), 60);
    } else if (step === 1) {
      const grid = el('div', { class: 'interest-grid' }, ...Object.entries(INTERESTS).map(([k, v]) => el('button', {
        class: 'interest', type: 'button', 'aria-pressed': String(pick.interests.has(k)),
        onclick: (e) => { if (pick.interests.has(k)) pick.interests.delete(k); else pick.interests.add(k); e.currentTarget.setAttribute('aria-pressed', String(pick.interests.has(k))); },
      }, v.label, icon('check'))));
      panel.replaceChildren(steps,
        el('div', { style: { display: 'grid', gap: '8px' } },
          el('h1', { class: 'h-lg', id: 'onboard-title' }, `What are you curious about${pick.name.trim() ? `, ${pick.name.trim()}` : ''}?`),
          el('p', { class: 'muted' }, 'Pick a few. Wonder suggests lessons from these; you can learn anything regardless.')),
        grid,
        el('div', { class: 'onboard-actions' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { step = 0; draw(); } }, icon('arrow-left'), 'Back'),
          el('button', { class: 'btn btn-lg', type: 'button', onclick: () => { step = 2; draw(); } }, 'Continue', icon('arrow-right'))));
      grid.firstChild?.focus();
    } else {
      const opts = el('div', { class: 'goal-options', role: 'radiogroup', 'aria-label': 'Daily goal' }, ...DAILY_GOALS.map((g) => el('button', {
        class: 'goal-option', type: 'button', role: 'radio', 'aria-checked': String(g.xp === pick.dailyGoal), dataset: { xp: String(g.xp) },
        onclick: (e) => { pick.dailyGoal = g.xp; for (const b of opts.children) b.setAttribute('aria-checked', String(b === e.currentTarget)); },
      }, el('span', { class: 'goal-option-text' }, el('strong', null, g.label), el('span', { class: 'muted small' }, g.hint)), el('b', null, `${g.xp} XP`))));
      panel.replaceChildren(steps,
        el('div', { style: { display: 'grid', gap: '8px' } },
          el('h1', { class: 'h-lg', id: 'onboard-title' }, 'Set a daily goal'),
          el('p', { class: 'muted' }, 'Small and steady beats big and rare. You can change it any time.')),
        opts,
        el('div', { class: 'onboard-actions' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { step = 1; draw(); } }, icon('arrow-left'), 'Back'),
          el('button', { class: 'btn btn-lg', type: 'button', onclick: () => finish(false) }, 'Start learning', icon('sparkles'))));
      opts.querySelector('[aria-checked="true"]')?.focus();
    }
  }
  draw();
  document.body.append(overlay);
}

function markSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M8 11l3.2 11 4.3-8.2L19.8 22 23 11');
  svg.appendChild(p);
  return svg;
}
