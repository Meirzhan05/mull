// First-run welcome, a full-screen flow in three steps that ends in the learner's first lesson:
// 1. what they're curious about (interests, with a live preview of the topics they unlock),
// 2. their pace (the level lessons start at and a daily goal),
// 3. a first lesson, picked from those topics or typed in.
// Skippable at any point (Esc or Skip keeps what was chosen so far); the choices live in
// store.settings: name, interests, level, dailyGoal.

import { el, icon } from './ui.js';
import { INTERESTS, DAILY_GOALS, DEFAULT_GOAL, suggestedTopics, topicInterest } from './progress-core.js';

export const LEVELS = Object.freeze([
  { id: 'beginner', label: 'Beginner', hint: 'Start from the ground up' },
  { id: 'intermediate', label: 'Intermediate', hint: 'I know the basics' },
  { id: 'advanced', label: 'Advanced', hint: 'Skip ahead to the depth' },
]);
const STEPS = ['Interests', 'Pace', 'First lesson'];

export function needsOnboarding(data) {
  return !data.settings?.onboarded && !Object.keys(data.lessons || {}).length && !(data.courses || []).length;
}

/**
 * @param {{store: object, onDone?: () => void, startLesson?: (topic: string, level: string) => void}} opts
 *   startLesson opens the first lesson; without it the last step only finishes.
 */
export function showOnboarding({ store, onDone, startLesson }) {
  const known = String(store.data?.settings?.name || globalThis.Clerk?.user?.firstName || '').trim();
  const pick = { name: known, interests: new Set(store.data?.settings?.interests || []), level: 'beginner', dailyGoal: DEFAULT_GOAL };
  let step = 0;
  let back = false;
  const body = el('div', { class: 'onboard-body' });
  const progress = el('ol', { class: 'onboard-progress', 'aria-label': 'Steps' });
  const root = el('div', { class: 'onboard', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'onboard-title' },
    el('header', { class: 'onboard-top' },
      el('p', { class: 'brand', 'aria-hidden': 'true' }, el('span', { class: 'brand-name' }, 'Wonder'), el('span', { class: 'brand-dot' }, '.')),
      progress,
      el('button', { class: 'btn btn-ghost btn-sm onboard-skip', type: 'button', onclick: () => finish() }, 'Skip')),
    body);
  // the app behind stays out of reach of Tab and screen readers while the welcome is up
  const behind = [...document.body.children].filter((n) => !n.inert);
  for (const n of behind) n.inert = true;

  function finish(topic) {
    const name = pick.name.trim();
    store.update((d) => {
      d.settings = { ...(d.settings || {}), onboarded: true, interests: [...pick.interests], level: pick.level, dailyGoal: pick.dailyGoal, ...(name ? { name } : {}) };
      return d;
    });
    store.flush();
    for (const n of behind) n.inert = false;
    root.remove();
    document.removeEventListener('keydown', onKey);
    onDone?.();
    if (topic) startLesson?.(topic, pick.level);
  }
  const onKey = (e) => { if (e.key === 'Escape') finish(); };
  document.addEventListener('keydown', onKey);

  const go = (n) => { back = n < step; step = n; draw(); };
  const actions = (...right) => el('div', { class: 'onboard-actions' },
    step > 0 ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => go(step - 1) }, icon('arrow-left'), 'Back') : el('span'),
    ...right);
  const heading = (title, sub) => el('div', { class: 'onboard-head' },
    el('p', { class: 'onboard-kicker' }, `Step ${step + 1} of ${STEPS.length}`),
    el('h1', { class: 'onboard-title', id: 'onboard-title' }, title),
    el('p', { class: 'onboard-sub' }, sub));

  function interestsStep() {
    const preview = el('ul', { class: 'onboard-preview-list' });
    const count = el('span', { class: 'onboard-count' });
    const drawPreview = () => {
      const topics = suggestedTopics({ interests: [...pick.interests] }, {}, new Date(), 3);
      preview.replaceChildren(...topics.map((t) => el('li', null, el('span', { class: 'onboard-preview-tag' }, topicInterest(t) || 'Popular'), el('span', null, t))));
      count.textContent = pick.interests.size ? `${pick.interests.size} chosen` : 'Choose a few';
    };
    const grid = el('div', { class: 'interest-grid', role: 'group', 'aria-label': 'Interests' }, ...Object.entries(INTERESTS).map(([k, v]) => el('button', {
      class: 'interest', type: 'button', 'aria-pressed': String(pick.interests.has(k)),
      onclick: (e) => {
        if (pick.interests.has(k)) pick.interests.delete(k); else pick.interests.add(k);
        e.currentTarget.setAttribute('aria-pressed', String(pick.interests.has(k)));
        drawPreview();
      },
    }, el('span', null, v.label), icon('check'))));
    const nameInput = el('input', { class: 'onboard-input', type: 'text', maxlength: '40', placeholder: 'Your first name', value: pick.name, autocomplete: 'given-name', 'aria-label': 'Your first name (optional)', oninput: (e) => { pick.name = e.target.value; } });
    drawPreview();
    const form = el('form', { class: 'onboard-step', onsubmit: (e) => { e.preventDefault(); go(1); } },
      heading(known ? `Hi ${known}. What are you curious about?` : 'What are you curious about?',
        'Wonder writes a short lesson on anything you name, with working diagrams and a tutor beside the text. Pick a few subjects and it will suggest where to start.'),
      known ? null : el('label', { class: 'onboard-field' }, el('span', null, 'What should we call you? ', el('span', { class: 'muted' }, '(optional)')), nameInput),
      el('div', { class: 'onboard-field' }, el('span', { class: 'onboard-field-row' }, el('span', null, 'Subjects'), count), grid),
      el('aside', { class: 'onboard-preview', 'aria-live': 'polite' }, el('p', { class: 'onboard-preview-title' }, icon('sparkles'), 'Your front page will suggest'), preview),
      actions(el('button', { class: 'btn btn-lg', type: 'submit' }, 'Continue', icon('arrow-right'))));
    return [form, known ? grid.firstChild : nameInput];
  }

  function paceStep() {
    const choice = (label, items, current, onPick) => {
      const group = el('div', { class: 'goal-options', role: 'radiogroup', 'aria-label': label }, ...items.map((it) => el('button', {
        class: 'goal-option', type: 'button', role: 'radio', 'aria-checked': String(it.value === current), tabindex: it.value === current ? '0' : '-1',
        onclick: (e) => { onPick(it.value); for (const b of group.children) { const on = b === e.currentTarget; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } },
      }, el('span', { class: 'goal-option-text' }, el('strong', null, it.label), el('span', { class: 'muted small' }, it.hint)), it.tag ? el('b', null, it.tag) : null, el('i', { class: 'goal-option-dot', 'aria-hidden': 'true' }))));
      // arrow keys move within a radio group, as they do in a native one
      group.addEventListener('keydown', (e) => {
        const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (!dir) return;
        e.preventDefault();
        const list = [...group.children];
        const next = list[(list.indexOf(document.activeElement) + dir + list.length) % list.length];
        next.click();
        next.focus();
      });
      return group;
    };
    const level = choice('Level', LEVELS.map((l) => ({ value: l.id, label: l.label, hint: l.hint })), pick.level, (v) => { pick.level = v; });
    const goal = choice('Daily goal', DAILY_GOALS.map((g) => ({ value: g.xp, label: g.label, hint: g.hint, tag: `${g.xp} XP` })), pick.dailyGoal, (v) => { pick.dailyGoal = v; });
    const node = el('div', { class: 'onboard-step' },
      heading(`How should lessons feel${pick.name.trim() ? `, ${pick.name.trim()}` : ''}?`, 'Both are a starting point. You can change the level on any lesson, and the goal in You.'),
      el('div', { class: 'onboard-pace' },
        el('div', { class: 'onboard-field' }, el('span', null, 'Start lessons at'), level),
        el('div', { class: 'onboard-field' }, el('span', null, 'Daily goal'), goal)),
      actions(el('button', { class: 'btn btn-lg', type: 'button', onclick: () => go(2) }, 'Continue', icon('arrow-right'))));
    return [node, level.querySelector('[aria-checked="true"]')];
  }

  function firstLessonStep() {
    const topics = suggestedTopics({ interests: [...pick.interests] }, {}, new Date(), 3);
    const input = el('input', { class: 'onboard-input', type: 'text', maxlength: '200', placeholder: 'Or ask about anything: how tides work, the Cold War…', 'aria-label': 'Your own topic' });
    const send = el('button', { class: 'onboard-ask-go', type: 'submit', 'aria-label': 'Begin this lesson' }, icon('arrow-right'));
    input.addEventListener('input', () => send.classList.toggle('ready', !!input.value.trim()));
    const node = el('div', { class: 'onboard-step' },
      heading('Pick your first lesson', `About eight minutes, written for you as you read${pick.level === 'beginner' ? '' : ` at ${pick.level} level`}. The key ideas come back later as review cards, so they stick.`),
      el('div', { class: 'onboard-topics' }, ...topics.map((t, i) => el('button', { class: `onboard-topic${i === 0 ? ' featured' : ''}`, type: 'button', onclick: () => finish(t) },
        el('span', { class: 'onboard-topic-tag' }, topicInterest(t) || 'Popular'),
        el('span', { class: 'onboard-topic-title' }, t),
        icon('arrow-right')))),
      el('form', { class: 'onboard-ask', onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (t) finish(t); else input.focus(); } }, icon('search'), input, send),
      el('div', { class: 'onboard-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => go(1) }, icon('arrow-left'), 'Back'),
        el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => finish() }, 'Look around first')));
    return [node, node.querySelector('.onboard-topic')];
  }

  function draw() {
    progress.replaceChildren(...STEPS.map((label, i) => el('li', { class: i < step ? 'done' : i === step ? 'on' : '', 'aria-current': i === step ? 'step' : null },
      el('i', { 'aria-hidden': 'true' }, i < step ? icon('check') : String(i + 1)), el('span', null, label))));
    const [node, focus] = [interestsStep, paceStep, firstLessonStep][step]();
    node.classList.add(back ? 'from-left' : 'from-right');
    body.replaceChildren(node);
    body.scrollTop = 0;
    setTimeout(() => focus?.focus({ preventScroll: true }), 60);
  }
  draw();
  document.body.append(root);
}
