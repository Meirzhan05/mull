// Phase 6: "What works for you" on the You screen. Recall by teaching style and by visual,
// measured from delayed reviews (outcomes-core.js), each with its sample size and an honest
// "not enough data yet" state; the lessons that are fading, with Refresh (review that lesson's
// cards now) and Relearn (a new lesson on the topic in a different style); and the switch for
// the teaching-style experiment.

import { el, icon, toast } from './ui.js';
import { whatWorks, fadingLessons, STYLE_VARIANTS, VARIANT_IDS, RECALL_MIN, FINDING_MIN } from './outcomes-core.js';

const pct = (r) => `${Math.round(r * 100)}%`;
const reviews = (n) => `${n} review${n === 1 ? '' : 's'}`;

function bar(rate, n, min) {
  const known = rate != null && n >= min;
  return el('span', { class: 'ins-bar', 'aria-hidden': 'true' }, el('span', { class: 'ins-bar-fill', style: { width: known ? `${Math.round(rate * 100)}%` : '0%' } }));
}

/** A style to relearn a lesson in: the best-measured other style, else the next one. */
function relearnVariant(stats, current) {
  const others = stats.filter((s) => s.id !== current);
  const measured = others.filter((s) => s.n >= RECALL_MIN).sort((a, b) => b.rate - a.rate);
  return (measured[0] || others[0]).id;
}

/** @param {{store: object, createLesson: Function, refresh?: Function}} ctx */
export function insightsPanel(ctx) {
  const { store } = ctx;
  const now = new Date();
  const w = whatWorks(store.data, now);
  const fading = fadingLessons(store.data, now, 4);
  const on = () => store.data.settings?.styleExperiment !== false;

  const toggle = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on()), 'aria-label': 'Teaching-style experiment' }, el('span', { class: 'switch-knob' }));
  toggle.addEventListener('click', () => {
    const next = !on();
    store.update((d) => { d.settings = { ...(d.settings || {}), styleExperiment: next }; return d; });
    toggle.setAttribute('aria-checked', String(next));
    toast(next ? 'New lessons rotate teaching styles' : 'New lessons use the standard style');
  });

  const head = el('div', { class: 'section-head' },
    el('h2', { class: 'h-md' }, 'What works for you'),
    el('span', { class: 'muted small' }, w.totalReviews ? `${w.recall != null ? `${pct(w.recall)} recall · ` : ''}${reviews(w.totalReviews)} days later` : 'Measured from your reviews'));

  const findings = w.findings.length
    ? el('ul', { class: 'ins-findings' }, ...w.findings.map((f) => el('li', null, icon(f.positive === false ? 'x' : 'sparkles'), el('span', null, f.text))))
    : el('p', { class: 'muted small' }, w.totalReviews
      ? `No clear pattern yet. A finding needs at least ${FINDING_MIN} delayed reviews on each side and a 10-point gap, so keep reviewing.`
      : 'When a lesson’s cards come back for review a day or more later, Wonder checks what you still remember. Patterns show up here once there is enough data.');

  const styles = el('div', { class: 'ins-rows', role: 'list', 'aria-label': 'Recall by teaching style' },
    ...w.variants.map((v) => el('div', { class: 'ins-row', role: 'listitem' },
      el('span', { class: 'ins-label' }, el('strong', null, v.label), el('span', { class: 'muted tiny' }, v.hint)),
      bar(v.rate, v.n, RECALL_MIN),
      el('span', { class: 'ins-num' }, v.n >= RECALL_MIN ? pct(v.rate) : '–', el('span', { class: 'muted tiny' }, v.n ? `${reviews(v.n)} · ${v.lessons} lesson${v.lessons === 1 ? '' : 's'}` : v.assigned ? `${v.assigned} lesson${v.assigned === 1 ? '' : 's'}, not reviewed yet` : 'no lessons yet')))));

  const comps = w.components.filter((c) => c.with.n >= RECALL_MIN).slice(0, 5);
  const visuals = comps.length ? el('div', { class: 'ins-rows', role: 'list', 'aria-label': 'Recall with and without each visual' },
    ...comps.map((c) => el('div', { class: 'ins-row', role: 'listitem' },
      el('span', { class: 'ins-label' }, el('strong', null, c.label.replace(/ \(.*\)$/, '')), el('span', { class: 'muted tiny' }, `in ${c.with.lessons} lesson${c.with.lessons === 1 ? '' : 's'}`)),
      bar(c.with.rate, c.with.n, RECALL_MIN),
      el('span', { class: 'ins-num' }, pct(c.with.rate), el('span', { class: 'muted tiny' }, c.without.n >= RECALL_MIN ? `vs ${pct(c.without.rate)} without · ${reviews(c.with.n + c.without.n)}` : reviews(c.with.n)))))) : null;

  const fadingList = fading.length ? el('div', { class: 'ins-fading' },
    el('h3', { class: 'h-sm' }, 'Fading lessons'),
    ...fading.map((o) => {
      const lesson = store.data.lessons[o.lessonId];
      const measured = o.recall.n >= RECALL_MIN;
      const relearn = el('button', { class: 'btn btn-ghost', type: 'button', disabled: !lesson, onclick: () => {
        const variant = relearnVariant(w.variants, lesson?.variant || 'standard');
        const id = ctx.createLesson({ topic: lesson.topic || lesson.title, title: lesson.title || lesson.topic, level: lesson.level || 'beginner', variant, relearnOf: lesson.id });
        toast(`Relearning in the “${STYLE_VARIANTS[variant].label.toLowerCase()}” style`);
        location.hash = `#/lesson/${id}`;
      } }, icon('play'), 'Relearn');
      return el('div', { class: 'card ins-lesson' },
        el('div', { class: 'ins-lesson-text' },
          el('strong', null, o.title || 'Untitled lesson'),
          el('span', { class: 'muted small' }, measured ? `${pct(o.recall.rate)} recall over ${reviews(o.recall.n)}` : o.memoryToday != null ? `~${pct(o.memoryToday)} memory today` : 'Not measured yet',
            o.leeches.length ? ` · ${o.leeches.length} card${o.leeches.length === 1 ? '' : 's'} keep slipping` : '')),
        el('div', { class: 'ins-lesson-actions' },
          el('a', { class: 'btn btn-secondary', href: `#/review/lesson/${o.lessonId}` }, icon('repeat'), 'Refresh'),
          relearn));
    })) : null;

  return el('section', { class: 'section', id: 'insights', 'aria-label': 'What works for you' },
    head,
    el('div', { class: 'card insights' },
      findings,
      el('h3', { class: 'h-sm' }, 'By teaching style'),
      styles,
      visuals ? el('h3', { class: 'h-sm' }, 'By visual') : null,
      visuals,
      el('div', { class: 'mem-toggle ins-toggle' },
        el('div', null, el('strong', null, 'Teaching-style experiment'),
          el('p', { class: 'muted small' }, `New lessons rotate between ${VARIANT_IDS.length} styles until Wonder can tell which one you remember best, then mostly use that one.`)),
        toggle)),
    fadingList);
}
