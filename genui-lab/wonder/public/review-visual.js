// Visual practice cards (number_line / chart_select / order_steps) in the review session.
//
// One DIL surface (sandboxed worker + DOM host, dil-surface.js) per review session renders
// the widgets from catalog-practice.js; its mount moves into each visual card. The widget sends
// `practice_answer`; this module grades it with practice-core.js (pure code, no model call),
// locks the widget with appData.practiceResult, and hands the grade to review.js, which
// records it (FSRS + mastery evidence via item.concept) and shows the usual feedback.

import { el, inlineMd } from './ui.js';
import { DilSurface } from './dil-surface.js';
import { practiceProgram, practiceResultFor } from './catalog-practice.js';
import { gradePracticeItem, VISUAL_PRACTICE_TYPES, formatPracticeNumber, withUnit } from './practice-core.js';

export const VISUAL_TYPE_LABEL = Object.freeze({ number_line: 'Number line', chart_select: 'Read the chart', order_steps: 'Put in order' });
const LEAD = { number_line: 'Place the marker on the number line.', chart_select: 'Pick the answer on the chart.', order_steps: 'Put these steps in order.' };
const HINTS = { number_line: [['← →', 'move'], ['↵', 'check']], order_steps: [['Tab', 'move between arrows'], ['↵', 'check']] };
const OPPOSITE = [[' up', ' down'], [' left', ' right']];

export const isVisualItem = (item) => VISUAL_PRACTICE_TYPES.includes(item?.type);

/** Feedback title for a graded visual item (the generic one says "Correct!" / "Not quite"). */
export function visualFeedbackTitle(item, g) {
  if (item.type === 'number_line') {
    if (g.correct) return g.rating >= 3 ? 'Correct!' : 'In range, near the edge';
    return g.close ? `Close: off by ${withUnit(formatPracticeNumber(g.distance, 4), item.unit)}` : 'Not quite';
  }
  if (item.type === 'order_steps') {
    if (g.correct) return g.inversions === 0 ? 'Correct!' : 'Nearly: one pair swapped';
    return g.inversions == null ? 'Not quite' : `${g.inPlace} of ${item.steps.length} in the right place`;
  }
  return g.correct ? 'Correct!' : 'Not quite';
}

export function createVisualPractice() {
  let surface = null;
  let mount = null;
  let current = null;

  const buttons = () => (mount ? [...mount.querySelectorAll('button')] : []);
  const byLabel = (label) => buttons().find((b) => b.getAttribute('aria-label') === label && !b.disabled);
  const clickLabel = (label) => byLabel(label)?.click();
  const checkButton = () => buttons().find((b) => b.getAttribute('data-d-component') === 'button' && b.textContent.trim() === 'Check' && !b.disabled);
  const picks = () => buttons().filter((b) => /^pick/.test(b.getAttribute('data-variant') || ''));

  // A re-render can replace or move the focused button (a reordered step, a stepper that just
  // became disabled): put focus back on the same control, or its opposite, so keyboard use flows.
  function keepFocus(e) {
    const pick = e.target.closest?.('button[data-variant^="pick"]');
    if (pick) current?.onPick?.(pick);
    const b = e.target.closest?.('button[aria-label]');
    if (!b || !mount.contains(b) || document.activeElement !== b) return; // only focus it already had
    const label = b.getAttribute('aria-label');
    for (const delay of [60, 160, 320]) {
      setTimeout(() => {
        if (!mount?.isConnected || mount.contains(document.activeElement)) return;
        let target = byLabel(label);
        for (const [a, z] of OPPOSITE) if (!target) target = byLabel(label.endsWith(a) ? label.slice(0, -a.length) + z : label.endsWith(z) ? label.slice(0, -z.length) + a : '');
        target?.focus();
      }, delay);
    }
  }

  function ensure(container) {
    if (!mount) {
      mount = el('div', { class: 'review-visual-surface' });
      mount.addEventListener('click', keepFocus, true); // capture: the DIL host stops click propagation
    }
    container.append(mount);
    if (!surface) surface = new DilSurface(mount, { onAction: (a) => current?.onAction(a), onError: (e) => console.warn('[practice]', e.phase, e.message) });
  }

  /**
   * Render a visual item into `card`. `onGraded(grade)` runs once, after the learner checks.
   * Returns the key map for review.js.
   */
  function show(card, item, onGraded, hint) {
    card.append(el('p', { class: 'muted small' }, LEAD[item.type] || ''), el('h2', { class: 'review-prompt' }, inlineMd(item.prompt)));
    const holder = el('div', { class: 'review-visual', dataset: { type: item.type } });
    card.append(holder, el('div', { class: 'review-actions' }, hint(...(item.type === 'chart_select' ? [[`1–${item.points.length}`, 'pick'], ['↵', 'check']] : HINTS[item.type]))));
    ensure(holder);
    const program = practiceProgram(item);
    let done = false;
    current = {
      onAction(a) {
        if (done || a?.type !== 'practice_answer' || a.payload?.itemId !== item.id) return;
        done = true;
        const answer = a.payload.answer;
        const g = gradePracticeItem(item, answer);
        surface.setAppData({ practiceResult: practiceResultFor(item, answer, g) });
        onGraded(g, answer);
      },
    };
    surface.render({ code: program.code, constants: program.constants, appData: {} });
    // keys: a focused widget button handles Enter/Space itself (review.js skips those keys there)
    const keys = { enter: () => checkButton()?.click() };
    if (item.type === 'number_line') {
      keys.arrowleft = () => clickLabel('Move marker left');
      keys.arrowright = () => clickLabel('Move marker right');
    } else if (item.type === 'chart_select') {
      // the pick is tracked here: the widget's aria-pressed lags a worker round trip behind
      let at = -1;
      const pick = (i) => { const b = picks()[i]; if (b && !b.disabled) { at = i; b.click(); } };
      current.onPick = (b) => { const i = picks().indexOf(b); if (i >= 0) at = i; };
      item.points.forEach((_, i) => { keys[String(i + 1)] = () => pick(i); });
      const step = (d) => pick(Math.max(0, Math.min(item.points.length - 1, at < 0 ? 0 : at + d)));
      keys.arrowleft = () => step(-1);
      keys.arrowright = () => step(1);
    }
    return keys;
  }

  function destroy() {
    current = null;
    try { surface?.destroy(); } catch {}
    surface = null;
    mount?.remove();
    mount = null;
  }

  return { show, destroy };
}
