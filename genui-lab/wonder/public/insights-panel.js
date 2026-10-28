// Phase 9: "What works for you" on the You screen, next to "What you know". Recall by teaching
// style and by visual, measured from delayed reviews (outcomes-core.js), each with its sample
// size and an honest "not enough data yet" state; the lessons that are fading, with Refresh
// (review that lesson's cards now) and Relearn (a new lesson on the topic in another style); and
// the switch for the teaching-style experiment. Laid out like the mastery panel (same classes).

import { el, icon, toast } from './ui.js';
import { whatWorks, fadingLessons, STYLE_VARIANTS, VARIANT_IDS, RECALL_MIN, FINDING_MIN, FINDING_LESSONS } from './outcomes-core.js';

const pct = (r) => `${Math.round(r * 100)}%`;
const reviews = (n) => `${n} review${n === 1 ? '' : 's'}`;

/** A style to relearn a lesson in: the best-measured other style, else the next one. */
function relearnVariant(stats, current) {
  const others = stats.filter((s) => s.id !== current);
  const measured = others.filter((s) => s.n >= RECALL_MIN).sort((a, b) => b.rate - a.rate);
  return (measured[0] || others[0]).id;
}

/** Phase 9 Relearn: a new lesson on the same topic in another teaching style, opened now. */
export function relearnLesson(ctx, lesson, variants = whatWorks(ctx.store.data).variants) {
  const variant = relearnVariant(variants, lesson?.variant || 'standard');
  const id = ctx.createLesson({ topic: lesson.topic || lesson.title, title: lesson.title || lesson.topic, level: lesson.level || 'beginner', variant, relearnOf: lesson.id, ...(lesson.materialId ? { materialId: lesson.materialId, materialTitle: lesson.materialTitle } : {}) });
  toast(`Relearning in the “${STYLE_VARIANTS[variant].label.toLowerCase()}” style`);
  location.hash = `#/lesson/${id}`;
}

/** One measured row: label + note, a bar, the percentage (or a dash below the threshold). */
function meterRow(label, note, rate, n) {
  const known = rate != null && n >= RECALL_MIN;
  const value = known ? Math.round(rate * 100) : 0;
  return el('li', { class: 'mastery-item works-item' },
    el('div', { class: 'mastery-text' }, el('strong', null, label), el('span', { class: 'muted small' }, note)),
    el('div', { class: 'mastery-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(value), 'aria-label': known ? `${label}: ${value}% recall` : `${label}: not measured yet` },
      el('span', { class: 'mastery-fill', style: { width: `${value}%` } })),
    el('span', { class: 'mastery-pct' }, known ? `${value}%` : '–'));
}

const group = (title, note, ...kids) => el('div', { class: 'mastery-group works-group' },
  el('div', { class: 'mastery-group-head' }, el('h3', { class: 'mastery-group-title' }, title), note ? el('span', { class: 'muted small' }, note) : null),
  ...kids);

/** @param {{store: object, createLesson: Function}} ctx */
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
    el('h2', { class: 'rubric' }, 'What works for you', w.totalReviews ? el('span', { class: 'count' }, String(w.totalReviews)) : null),
    el('span', { class: 'muted small' }, w.recall != null ? `${pct(w.recall)} recalled days later` : 'Measured from your reviews'));

  const findings = w.findings.length
    ? el('ul', { class: 'works-findings' }, ...w.findings.map((f) => el('li', { dataset: { tone: f.positive === false ? 'down' : 'up' } }, el('span', { class: 'status-dot', 'aria-hidden': 'true' }), el('span', null, f.text))))
    : el('p', { class: 'muted small works-empty' }, w.totalReviews
      ? `No clear pattern yet. A finding needs ${FINDING_LESSONS} lessons and ${FINDING_MIN} delayed reviews on each side, and a 10-point gap.`
      : 'When a lesson’s cards come back for review a day or more later, Mull checks what you still remember. Patterns show up here once there is enough data.');

  const styles = el('ul', { class: 'mastery-items' }, ...w.variants.map((v) => meterRow(v.label,
    v.n ? `${v.hint} · ${reviews(v.n)}, ${v.lessons} lesson${v.lessons === 1 ? '' : 's'}` : v.assigned ? `${v.hint} · ${v.assigned} lesson${v.assigned === 1 ? '' : 's'}, not reviewed yet` : `${v.hint} · no lessons yet`,
    v.rate, v.n)));

  const comps = w.components.filter((c) => c.with.n >= RECALL_MIN && c.with.lessons >= FINDING_LESSONS).slice(0, 5); // one lesson is an anecdote
  const visuals = comps.length ? el('ul', { class: 'mastery-items' }, ...comps.map((c) => meterRow(
    c.label.replace(/ \(.*\)$/, '').replace(/^./, (ch) => ch.toUpperCase()),
    `in ${c.with.lessons} lesson${c.with.lessons === 1 ? '' : 's'}${c.without.n >= RECALL_MIN ? ` · ${pct(c.without.rate)} without` : ''} · ${reviews(c.with.n)}`,
    c.with.rate, c.with.n))) : null;

  const fadingList = fading.length ? el('ul', { class: 'works-lessons' }, ...fading.map((o) => {
    const lesson = store.data.lessons[o.lessonId];
    const measured = o.recall.n >= RECALL_MIN;
    const relearn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: !lesson, onclick: () => relearnLesson(ctx, lesson, w.variants) }, 'Relearn');
    return el('li', { class: 'works-lesson' },
      el('div', { class: 'mastery-text' },
        el('strong', null, o.title || 'Untitled lesson'),
        el('span', { class: 'muted small' }, measured ? `${pct(o.recall.rate)} recall over ${reviews(o.recall.n)}` : o.memoryToday != null ? `about ${pct(o.memoryToday)} remembered today` : 'Not measured yet',
          o.leeches.length ? ` · ${o.leeches.length} card${o.leeches.length === 1 ? '' : 's'} keep slipping` : '')),
      el('div', { class: 'works-actions' },
        el('a', { class: 'btn btn-secondary btn-sm', href: `#/review/lesson/${o.lessonId}` }, 'Refresh'),
        relearn));
  })) : null;

  return el('div', { class: 'mastery works', id: 'works', 'aria-label': 'What works for you' },
    head,
    el('div', { class: 'card mastery-card' },
      group('Findings', null, findings),
      group('By teaching style', 'Recall when the cards came back a day or more later', styles),
      visuals ? group('By visual', 'Lessons that used it', visuals) : null,
      fadingList ? el('div', { class: 'mastery-group works-group', dataset: { status: 'fading' } },
        el('div', { class: 'mastery-group-head' }, el('h3', { class: 'mastery-group-title' }, el('span', { class: 'status-dot', 'aria-hidden': 'true' }), 'Fading lessons', el('span', { class: 'count' }, String(fading.length))), el('span', { class: 'muted small' }, 'Review them now, or relearn from another angle')),
        fadingList) : null,
      el('div', { class: 'setting works-toggle' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Teaching-style experiment'),
          el('p', { class: 'muted small' }, `New lessons rotate between ${VARIANT_IDS.length} styles until Mull can tell which one you remember best, then mostly use that one.`)),
        toggle)));
}
