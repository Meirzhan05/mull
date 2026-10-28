// "What you know" (Phase 6): the learner model on the You screen. Each concept shows its
// estimated mastery (mastery-core.js), grouped by status, with a "Practice" action for the
// weak ones (asks the Teacher to quiz them) and a per-concept reset.

import { el, icon, toast } from './ui.js';
import { masteryList, weakestConcepts, forgetConcept, STATUS_ORDER, STATUS_LABEL } from './mastery-core.js';

const STATUS_NOTE = {
  shaky: 'Missed recently. A quick quiz will firm these up.',
  fading: 'You knew these, but it has been a while.',
  learning: 'Getting there. A few more right answers to lock them in.',
  mastered: 'Solid, based on your recent answers.',
};
const SOURCE_NOTE = { quiz: 'lesson quizzes', teacher_quiz: 'Teacher quizzes', review: 'reviews', explain: 'explanations' };

/** Ask the Teacher to quiz the given concepts (navigates to #/teacher). */
export function practiceConcepts(actions, labels) {
  if (!labels.length) return;
  actions?.askTeacher?.(`Quiz me on the concepts I'm shakiest on: ${labels.join(', ')}.`);
}

export function masteryPanel(ctx) {
  const { store } = ctx;
  const wrap = el('div', { class: 'mastery', id: 'mastery', 'aria-label': 'What you know' });

  function draw() {
    const list = masteryList(store.data.mastery);
    const weak = weakestConcepts(store.data.mastery);
    const head = el('div', { class: 'section-head' },
      el('h2', { class: 'rubric' }, 'What you know', list.length ? el('span', { class: 'count' }, String(list.length)) : null),
      weak.length ? el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => practiceConcepts(ctx.actions, weak) }, 'Practice weak spots') : null);
    if (!list.length) {
      wrap.replaceChildren(head, el('div', { class: 'card mastery-empty' }, el('p', { class: 'muted' },
        'Answer a lesson quiz or review a few cards and Mull will start estimating how well you know each concept. Lessons, the tutor and your Teacher use it to recap what is shaky and skip what you already know.')));
      return;
    }
    const groups = STATUS_ORDER.map((status) => {
      const items = list.filter((c) => c.status === status);
      if (!items.length) return null;
      if (status === 'mastered') items.reverse();
      return el('div', { class: 'mastery-group', dataset: { status } },
        el('div', { class: 'mastery-group-head' },
          el('h3', { class: 'mastery-group-title' }, el('span', { class: 'status-dot', 'aria-hidden': 'true' }), STATUS_LABEL[status], el('span', { class: 'count' }, String(items.length))),
          el('span', { class: 'muted small' }, STATUS_NOTE[status])),
        el('ul', { class: 'mastery-items' }, ...items.slice(0, 24).map((c) => {
          const pct = Math.round(c.mastery * 100);
          const srcs = [...new Set((store.data.mastery?.[c.key]?.events || []).map((e) => SOURCE_NOTE[e.source]).filter(Boolean))];
          return el('li', { class: 'mastery-item' },
            el('div', { class: 'mastery-text' },
              el('strong', null, c.label),
              el('span', { class: 'muted small' }, `${c.attempts} answer${c.attempts === 1 ? '' : 's'}${srcs.length ? ` from ${srcs.join(', ')}` : ''}${c.topic ? ` · ${c.topic}` : ''}`)),
            el('div', { class: 'mastery-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${c.label}: ${pct}% mastery` },
              el('span', { class: 'mastery-fill', style: { width: `${pct}%` } })),
            el('span', { class: 'mastery-pct' }, `${pct}%`),
            el('button', { class: 'icon-btn plain', type: 'button', 'aria-label': `Reset ${c.label}`, title: 'Reset this concept', onclick: () => {
              store.update((d) => { d.mastery = forgetConcept(d.mastery, c.key); return d; });
              toast(`Reset ${c.label}`);
              draw();
            } }, icon('trash')));
        })));
    }).filter(Boolean);
    wrap.replaceChildren(head, el('div', { class: 'card mastery-card' }, ...groups));
  }

  draw();
  return wrap;
}
