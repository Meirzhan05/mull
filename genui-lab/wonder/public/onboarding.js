// First-run welcome, a full-screen flow in three steps that ends in the learner's first lesson:
// 1. what they're curious about (interests, with a live preview of the topics they unlock),
// 2. their pace (a daily goal),
// 3. a first lesson, picked from those topics or typed in.
// Skippable at any point (Esc or Skip keeps what was chosen so far); the choices live in
// store.settings: name, interests, dailyGoal. Only what the learner actually set is
// written, so settings that arrive meanwhile (account sync on a new device) are not reset.

import { el, icon } from './ui.js';
import { INTERESTS, DAILY_GOALS, suggestedTopics, topicInterest, goalOf, levelOf } from './progress-core.js';

const STEPS = ['Interests', 'Pace', 'First lesson'];

export function needsOnboarding(data) {
  return !data.settings?.onboarded && !Object.keys(data.lessons || {}).length && !(data.courses || []).length;
}

/** The interest chips (onboarding, You): toggles report the key and whether it is now on. */
export function interestGrid(selected, onToggle) {
  return el('div', { class: 'interest-grid', role: 'group', 'aria-label': 'Interests' }, ...Object.entries(INTERESTS).map(([k, v]) => el('button', {
    class: 'interest', type: 'button', 'aria-pressed': String(selected.has(k)),
    onclick: (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      onToggle(k, on);
    },
  }, el('span', null, v.label), icon('check'))));
}

/**
 * @param {{store: object, onDone?: () => void, startLesson?: (topic: string, level: string) => void,
 *   firstTopic?: string, accountName?: Promise<string> | null}} opts
 *   startLesson opens the first lesson; without it the last step only finishes. firstTopic (the
 *   topic brought from the landing page) leads the last step, ready to start. accountName fills
 *   an untouched, empty name field with the signed-in account's first name.
 */
export function showOnboarding({ store, onDone, startLesson, firstTopic = '', accountName = null }) {
  const settings = store.data?.settings || {};
  const pick = { name: String(settings.name || '').trim(), interests: new Set(settings.interests || []), level: levelOf(settings), dailyGoal: goalOf(settings) };
  const touched = new Set(); // the picks the learner made; only these are saved
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
  // and the page behind does not scroll under it
  const scroller = document.documentElement;
  const overflow = scroller.style.overflow;
  scroller.style.overflow = 'hidden';

  function finish(topic) {
    const patch = { onboarded: true };
    if (touched.has('interests')) patch.interests = [...pick.interests];
    if (touched.has('dailyGoal')) patch.dailyGoal = pick.dailyGoal;
    const name = pick.name.trim();
    store.update((d) => {
      if (touched.has('name') || (name && !d.settings?.name)) patch.name = name;
      d.settings = { ...(d.settings || {}), ...patch };
      return d;
    });
    store.flush();
    for (const n of behind) n.inert = false;
    scroller.style.overflow = overflow;
    root.remove();
    document.removeEventListener('keydown', onKey);
    // the lesson first: its hash change is the route, and onDone then has no Today to redraw
    if (topic) startLesson?.(topic, pick.level);
    onDone?.();
  }
  // Esc skips, unless it is cancelling an IME composition or another layer (the palette) took it
  const onKey = (e) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) finish(); };
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
    const grid = interestGrid(pick.interests, (k, on) => {
      if (on) pick.interests.add(k); else pick.interests.delete(k);
      touched.add('interests');
      drawPreview();
    });
    const nameInput = el('input', { class: 'onboard-input', type: 'text', maxlength: '40', placeholder: 'Your first name', value: pick.name, autocomplete: 'given-name', 'aria-label': 'Your first name (optional)', oninput: (e) => { pick.name = e.target.value; touched.add('name'); } });
    // the Google account's first name (it arrives on its own time) fills an untouched, empty field
    accountName?.then?.((n) => {
      if (n && !pick.name && !touched.has('name') && !nameInput.value) { pick.name = n; nameInput.value = n; }
    }).catch(() => {});
    drawPreview();
    const form = el('form', { class: 'onboard-step', onsubmit: (e) => { e.preventDefault(); go(1); } },
      heading('What are you curious about?',
        'Wonder writes a short lesson on anything you name, with working diagrams and a tutor beside the text. Pick a few subjects and it will suggest where to start.'),
      el('label', { class: 'onboard-field' }, el('span', null, 'What should we call you? ', el('span', { class: 'muted' }, '(optional)')), nameInput),
      el('div', { class: 'onboard-field' }, el('span', { class: 'onboard-field-row' }, el('span', null, 'Subjects'), count), grid),
      el('aside', { class: 'onboard-preview', 'aria-live': 'polite' }, el('p', { class: 'onboard-preview-title' }, icon('sparkles'), 'Your front page will suggest'), preview),
      actions(el('button', { class: 'btn btn-lg', type: 'submit' }, 'Continue', icon('arrow-right'))));
    return [form, pick.name ? grid.firstChild : nameInput];
  }

  function paceStep() {
    const choice = (label, items, current, onPick) => {
      // a saved value that is not one of the options (a custom goal) leaves the first one tabbable
      const tabStop = items.some((it) => it.value === current) ? current : items[0]?.value;
      const group = el('div', { class: 'goal-options', role: 'radiogroup', 'aria-label': label }, ...items.map((it) => el('button', {
        class: 'goal-option', type: 'button', role: 'radio', 'aria-checked': String(it.value === current), tabindex: it.value === tabStop ? '0' : '-1',
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
    const goal = choice('Daily goal', DAILY_GOALS.map((g) => ({ value: g.xp, label: g.label, hint: g.hint, tag: `${g.xp} XP` })), pick.dailyGoal, (v) => { pick.dailyGoal = v; touched.add('dailyGoal'); });
    const node = el('div', { class: 'onboard-step' },
      heading(`How much each day${pick.name.trim() ? `, ${pick.name.trim()}` : ''}?`, 'A starting point. You can change it any time in You.'),
      el('div', { class: 'onboard-pace' },
        el('div', { class: 'onboard-field' }, el('span', null, 'Daily goal'), goal)),
      actions(el('button', { class: 'btn btn-lg', type: 'button', onclick: () => go(2) }, 'Continue', icon('arrow-right'))));
    return [node, goal.querySelector('[tabindex="0"]')];
  }

  function firstLessonStep() {
    // the topic brought from the landing page leads, ready to start; suggestions follow it
    const mine = String(firstTopic || '').trim();
    const suggested = suggestedTopics({ interests: [...pick.interests] }, {}, new Date(), 3).filter((t) => t.toLowerCase() !== mine.toLowerCase());
    const topics = mine ? [mine, ...suggested.slice(0, 2)] : suggested;
    const input = el('input', { class: 'onboard-input', type: 'text', maxlength: '200', placeholder: 'Or ask about anything: how tides work, the Cold War…', 'aria-label': 'Your own topic' });
    const send = el('button', { class: 'onboard-ask-go', type: 'submit', 'aria-label': 'Begin this lesson' }, icon('arrow-right'));
    input.addEventListener('input', () => send.classList.toggle('ready', !!input.value.trim()));
    const node = el('div', { class: 'onboard-step' },
      heading(mine ? 'Your first lesson' : 'Pick your first lesson', `About eight minutes, written for you as you read${pick.level === 'beginner' ? '' : ` at ${pick.level} level`}. The key ideas come back later as review cards, so they stick.`),
      el('div', { class: 'onboard-topics' }, ...topics.map((t, i) => el('button', { class: `onboard-topic${i === 0 ? ' featured' : ''}`, type: 'button', onclick: () => finish(t) },
        el('span', { class: 'onboard-topic-tag' }, mine && i === 0 ? 'Your pick' : topicInterest(t) || 'Popular'),
        el('span', { class: 'onboard-topic-title' }, t),
        mine && i === 0 ? el('span', { class: 'onboard-topic-go' }, 'Start this lesson') : null,
        icon('arrow-right')))),
      mine ? el('p', { class: 'onboard-or muted' }, 'Or ask about something else:') : null,
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
