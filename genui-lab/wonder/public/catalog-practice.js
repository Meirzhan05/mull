// Visual practice widgets for the review screen, evaluated INSIDE the DIL sandbox like
// learning-catalog.js and written only with DIL primitives:
//
//   PracticeNumberLine   a number line: tap a tick (touch/mouse) or use the −/+ buttons
//                        (keyboard, screen readers) to place the marker, then Check.
//   PracticeChartSelect  a small bar or line chart whose bars/points are buttons; pick one, Check.
//   PracticeOrderSteps   a scrambled list with move up/down buttons on every step, then Check.
//
// The widgets never see the answer. Check dispatches a client action
//   {handler:'client', type:'practice_answer', payload:{itemId, answer}}
// and the review screen grades it (practice-core.js), then sets appData.practiceResult so the
// widget locks and shows the right answer. `practiceProgram(item)` builds the one-component
// program the review screen renders; the props it passes are display-only.
//
// `practiceCatalog` must stay self-contained: its source text is injected into the program.

import { numberLineStops, orderStepsStart, formatPracticeNumber, stepDecimals, withUnit } from './practice-core.js';

export const PRACTICE_COMPONENT_NAMES = Object.freeze(['PracticeNumberLine', 'PracticeChartSelect', 'PracticeOrderSteps']);
export const PRACTICE_COMPONENT_FOR = Object.freeze({ number_line: 'PracticeNumberLine', chart_select: 'PracticeChartSelect', order_steps: 'PracticeOrderSteps' });

export function practiceCatalog(__dil, DIL, GenUI) {
  const h = __dil.jsx;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const useResult = () => DIL.useAppData((ad) => ad?.practiceResult || null);
  const answer = (props, value) => GenUI.dispatchAction({ handler: 'client', type: 'practice_answer', payload: { itemId: str(props.itemId), answer: value } });

  function Shell(props) {
    return h('col', { __component: props.name, gap: props.gap ?? 4, padding: { x: 0, y: 1 } }, props.children);
  }
  function CheckRow(props) {
    return h('row', { gap: 2, justify: 'between', align: 'center', wrap: true },
      h('text', { size: 'sm', color: 'secondary', ariaLive: 'polite', flex: '1 1 12rem', minWidth: 0 }, props.status),
      props.locked ? null : h('button', { size: 'md', disabled: !props.ready, onClick: props.onCheck }, 'Check'));
  }

  // ------------------------------------------------------------------ number line
  function PracticeNumberLine(props) {
    const stops = arr(props.stops).map(Number).filter(Number.isFinite);
    const labels = arr(props.labels);
    const n = stops.length;
    const result = useResult();
    const [pos, setPos] = DIL.useState(null);
    const isMobile = DIL.useIsMobile();
    if (n < 2) return null;
    const locked = !!result;
    const at = locked && Number.isInteger(result.index) ? result.index : pos;
    const fmt = (i) => str(props.display?.[i] ?? stops[i]);
    const clamp = (i) => Math.max(0, Math.min(n - 1, i));
    const place = (i) => { if (!locked) setPos(clamp(i)); };
    // functional updates: presses that arrive before the next render still add up
    const nudge = (d) => { if (!locked) setPos((p) => (p == null ? Math.floor((n - 1) / 2) : clamp(p + d))); }; // the first press places it mid-line
    const inBand = (i) => locked && i >= result.lo && i <= result.hi;
    const H = isMobile ? 52 : 60;
    const pin = (color, label) => h('box', { size: 16, radius: 'full', background: color, border: { size: 2, color: 'surface' }, ariaHidden: true, tooltip: label });
    const track = h('row', { gap: 0, align: 'stretch', height: H, border: { size: 2, color: 'strong', side: 'bottom' }, ariaHidden: true, __component: 'PracticeNLTrack' },
      ...stops.map((_, i) => {
        const major = labels.includes(i);
        const mine = at === i;
        const right = locked && result.answerIndex === i;
        const markers = [];
        if (mine && !right) markers.push(pin(locked && !result.correct ? 'danger' : 'accent', 'Your answer'));
        if (right) markers.push(pin('success', 'Correct answer'));
        return h('col', {
          key: `t${i}`, flex: 1, minWidth: 0, gap: 1, align: 'center', justify: 'end', radius: 'sm',
          background: inBand(i) ? 'success-subtle' : undefined, __component: locked ? 'PracticeNLCellLocked' : 'PracticeNLCell',
          onClick: locked ? undefined : () => place(i),
        }, ...markers, h('box', { width: major ? 2 : 1, height: major ? 14 : 8, background: major ? 'var(--d-border-strong)' : 'var(--d-text-tertiary)', opacity: major ? 1 : 0.55 }));
      }));
    const labelRow = h('row', { gap: 0, ariaHidden: true },
      ...stops.map((_, i) => h('col', { key: `l${i}`, flex: 1, minWidth: 0, align: 'center', __component: 'PracticeNLLabel' },
        labels.includes(i) ? h('text', { size: 'xs', color: 'tertiary', tabularNums: true }, fmt(i)) : null)));
    const status = locked
      ? (result.correct ? 'Inside the accepted range (green).' : `The accepted range is shaded green.`)
      : at == null ? 'Tap the line, or use − and + to place the marker.' : `Marker at ${fmt(at)}`;
    return h(Shell, { name: 'PracticeNumberLine', gap: 3 },
      h('col', { gap: 1, padding: { x: 2 }, role: 'img', ariaLabel: `Number line from ${fmt(0)} to ${fmt(n - 1)}${at == null ? ', no marker placed' : `, marker at ${fmt(at)}`}` }, track, labelRow),
      h('row', { gap: 2, align: 'center', justify: 'center' },
        h('pressable', { variant: 'stepper', size: 44, radius: 'full', align: 'center', justify: 'center', disabled: locked || at === 0, ariaLabel: 'Move marker left', onClick: () => nudge(-1) }, h('icon', { name: 'minus', size: 'sm' })),
        h('box', { minWidth: 96, align: 'center', padding: { x: 2 } }, h('title', { size: 'md', tabularNums: true, textAlign: 'center' }, at == null ? '–' : fmt(at))),
        h('pressable', { variant: 'stepper', size: 44, radius: 'full', align: 'center', justify: 'center', disabled: locked || at === n - 1, ariaLabel: 'Move marker right', onClick: () => nudge(1) }, h('icon', { name: 'plus', size: 'sm' }))),
      h(CheckRow, { status, locked, ready: at != null, onCheck: () => { if (pos != null && !locked) answer(props, stops[pos]); } }));
  }

  // ------------------------------------------------------------------ chart select
  function PracticeChartSelect(props) {
    const points = arr(props.points).filter((p) => p && Number.isFinite(Number(p.value)));
    const n = points.length;
    const result = useResult();
    const [sel, setSel] = DIL.useState(null);
    const isMobile = DIL.useIsMobile();
    if (n < 2) return null;
    const locked = !!result;
    const picked = locked && Number.isInteger(result.picked) ? result.picked : sel;
    const H = isMobile ? 120 : 150;
    const vals = points.map((p) => Number(p.value));
    const value = (i) => str(points[i].display ?? points[i].value);
    const stateOf = (i) => (locked ? (i === result.answer ? 'right' : i === picked ? 'wrong' : 'dim') : i === sel ? 'on' : 'off');
    const fill = { right: 'success', wrong: 'danger', dim: 'brand-muted', on: 'accent', off: 'brand-muted' };
    const pick = (i) => { if (!locked) setSel(i); };
    const label = (i) => `${str(points[i].label)}${props.showValues ? `: ${value(i)}` : ''}`;
    const columnProps = (i) => ({
      key: `p${i}`, flex: 1, minWidth: 0, radius: 'lg', padding: { x: props.chart === 'line' ? 0 : 1, top: 2, bottom: 2 }, // a line runs edge to edge
      variant: locked ? (stateOf(i) === 'dim' && props.chart === 'line' ? 'pick' : `pick-${stateOf(i)}`) : sel === i ? 'pick-on' : 'pick', // dimming columns would break a line ariaPressed: picked === i, disabled: locked,
      ariaLabel: locked ? `${label(i)}${i === result.answer ? ' (correct answer)' : i === picked ? ' (your pick)' : ''}` : `Choose ${label(i)}`,
      onClick: () => pick(i),
    });
    const caption = (i) => h('col', { gap: 0, align: 'center', width: '100%' },
      h('text', { size: 'xs', weight: picked === i ? 'semibold' : 'regular', textAlign: 'center', __component: 'PracticeChartLabel' }, str(points[i].label)),
      props.showValues && props.chart === 'line' ? h('text', { size: 'xs', color: 'tertiary', tabularNums: true, textAlign: 'center' }, value(i)) : null);
    let plot;
    if (props.chart === 'line') {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const y = (v) => (hi === lo ? H / 2 : H * 0.88 - ((v - lo) / (hi - lo)) * H * 0.76);
      const mid = (a, b) => (y(vals[a]) + y(vals[b])) / 2;
      plot = h('row', { gap: 0, align: 'stretch' }, ...points.map((_, i) => {
        const s = stateOf(i);
        const yi = y(vals[i]).toFixed(1);
        const seg = `${i > 0 ? `M0 ${mid(i - 1, i).toFixed(1)} L50 ${yi}` : `M50 ${yi}`}${i < n - 1 ? ` L100 ${mid(i, i + 1).toFixed(1)}` : ''}`;
        return h('pressable', columnProps(i), h('col', { gap: 2, width: '100%', align: 'center' },
          h('svg', { viewBox: `0 0 100 ${H}`, width: '100%', height: H, preserveAspectRatio: 'none', ariaHidden: true },
            s === 'on' || s === 'right' || s === 'wrong' ? h('path', { d: `M50 0 L50 ${H}`, stroke: fill[s], strokeWidth: 1.5, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke', fill: 'none' }) : null,
            h('path', { d: seg, fill: 'none', stroke: 'accent', strokeWidth: 2.5, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }),
            h('path', { d: `M50 ${yi} L50 ${yi}`, stroke: s === 'off' || s === 'dim' ? 'accent' : fill[s], strokeWidth: s === 'off' || s === 'dim' ? 9 : 15, strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' })),
          caption(i)));
      }));
    } else {
      const max = Math.max(1e-9, ...vals.map(Math.abs));
      plot = h('row', { gap: isMobile ? 1 : 2, align: 'stretch' }, ...points.map((p, i) => {
        const s = stateOf(i);
        const pct = Math.max(3, (Math.abs(vals[i]) / max) * 100);
        return h('pressable', columnProps(i), h('col', { gap: 2, width: '100%', align: 'center' },
          h('col', { height: H, width: '100%', justify: 'end', align: 'center', gap: 1 },
            props.showValues ? h('text', { size: 'xs', color: 'secondary', tabularNums: true, textAlign: 'center', __component: 'PracticeChartLabel' }, value(i)) : null,
            h('box', { height: `${(pct * (props.showValues ? 0.82 : 1)).toFixed(1)}%`, width: '72%', maxWidth: 56, radius: 'md', background: fill[s] })),
          caption(i)));
      }));
    }
    const status = locked ? '' : sel == null ? `Pick the ${props.chart === 'line' ? 'point' : 'bar'} that answers the question.` : `Selected: ${str(points[sel].label)}`;
    return h(Shell, { name: 'PracticeChartSelect', gap: 3 },
      props.title || props.unit ? h('row', { justify: 'between', gap: 2, wrap: true },
        h('text', { size: 'sm', weight: 'semibold', color: 'secondary' }, str(props.title)),
        props.unit ? h('text', { size: 'xs', color: 'tertiary' }, str(props.unit)) : null) : null,
      plot,
      h(CheckRow, { status, locked, ready: sel != null, onCheck: () => { if (sel != null && !locked) answer(props, sel); } }));
  }

  // ------------------------------------------------------------------ order steps
  function PracticeOrderSteps(props) {
    const steps = arr(props.steps).map(str);
    const n = steps.length;
    const start = arr(props.start);
    const valid = start.length === n && start.every((x, i) => Number.isInteger(x) && start.indexOf(x) === i && x >= 0 && x < n);
    const result = useResult();
    const [order, setOrder] = DIL.useState(valid ? start : steps.map((_, i) => i));
    if (n < 2) return null;
    const locked = !!result;
    const shown = locked && Array.isArray(result.order) && result.order.length === n ? result.order : order;
    const move = (s, d) => {
      if (locked) return;
      setOrder((cur) => {
        const k = cur.indexOf(s);
        if (k < 0 || k + d < 0 || k + d >= n) return cur;
        const next = cur.slice();
        [next[k], next[k + d]] = [next[k + d], next[k]];
        return next;
      });
    };
    return h(Shell, { name: 'PracticeOrderSteps', gap: 3 },
      h('col', { gap: 2, role: 'list', ariaLabel: 'Steps in your order' }, ...shown.map((s, k) => {
        const ok = locked && s === k;
        const text = steps[s];
        return h('row', {
          key: `s${s}`, role: 'listitem', gap: 3, align: 'center', padding: { x: 3, y: 2 }, radius: 'xl', minHeight: 56,
          border: { size: 1, color: locked ? (ok ? 'success' : 'danger') : 'default' }, background: locked ? (ok ? 'success-subtle' : 'danger-subtle') : 'surface',
          __component: 'PracticeOrderRow',
        },
        h('box', { size: 28, radius: 'full', align: 'center', justify: 'center', background: 'surface-tertiary', ariaHidden: true }, h('text', { size: 'sm', weight: 'semibold', tabularNums: true }, String(k + 1))),
        h('col', { gap: 0, flex: 1, minWidth: 0 },
          h('text', { size: 'sm' }, text),
          locked && !ok ? h('text', { size: 'xs', color: 'secondary' }, `Belongs at step ${s + 1}`) : null),
        locked ? h('icon', { name: ok ? 'check' : 'x', size: 'sm', color: ok ? 'success' : 'danger', ariaLabel: ok ? 'In the right place' : `Belongs at step ${s + 1}` }) : h('row', { gap: 1 },
          h('pressable', { variant: 'stepper', size: 40, radius: 'full', align: 'center', justify: 'center', disabled: k === 0, ariaLabel: `Move "${text}" up`, onClick: () => move(s, -1) }, h('icon', { name: 'chevron-up', size: 'sm' })),
          h('pressable', { variant: 'stepper', size: 40, radius: 'full', align: 'center', justify: 'center', disabled: k === n - 1, ariaLabel: `Move "${text}" down`, onClick: () => move(s, 1) }, h('icon', { name: 'chevron-down', size: 'sm' }))));
      })),
      h(CheckRow, { status: locked ? '' : 'Use the arrows to put the steps in order.', locked, ready: true, onCheck: () => { if (!locked) answer(props, order.slice()); } }));
  }

  return { PracticeNumberLine, PracticeChartSelect, PracticeOrderSteps };
}

/** Prelude appended after EXTRAS_PRELUDE: binds the practice widgets for every program. */
export const PRACTICE_PRELUDE = `const {${PRACTICE_COMPONENT_NAMES.join(',')}}=(${practiceCatalog.toString()})(__dil,DIL,GenUI);\n`;

/**
 * Indices of the grid stops that get a label: the ends plus round values, at most `max`.
 * Prefers a label spacing of 1, 2, 2.5, 3 or 5 × 10^n that lands on both ends.
 */
export function numberLineLabels(stops, max = 6) {
  const n = stops.length;
  const span = stops[n - 1] - stops[0];
  const step = span / (n - 1);
  const onGrid = (x) => Math.abs(x - Math.round(x)) < 1e-6;
  for (let e = Math.floor(Math.log10(step)) - 1; e <= Math.ceil(Math.log10(span)) + 1; e++) {
    for (const m of [1, 2, 2.5, 3, 5]) {
      const L = m * 10 ** e;
      if (L < step - 1e-9 || !onGrid(L / step) || !onGrid(span / L) || span / L + 1 > max) continue;
      const k = Math.round(L / step);
      return Array.from({ length: Math.round(span / L) + 1 }, (_, i) => i * k);
    }
  }
  const k = Math.max(1, Math.ceil((n - 1) / (max - 1)));
  const out = [];
  for (let i = 0; i < n; i += k) out.push(i);
  if (out[out.length - 1] !== n - 1) {
    if (n - 1 - out[out.length - 1] <= k / 2 && out.length > 1) out.pop();
    out.push(n - 1);
  }
  return out;
}

/** Display-only widget props for a normalized visual item (never includes the answer). */
export function practiceWidgetProps(item) {
  const base = { itemId: item.id };
  if (item.type === 'number_line') {
    const stops = numberLineStops(item);
    const d = stepDecimals(item.step);
    return { ...base, stops, labels: numberLineLabels(stops), display: stops.map((v) => withUnit(formatPracticeNumber(v, d), item.unit)) };
  }
  if (item.type === 'chart_select') {
    const decimals = Math.min(2, Math.max(0, ...item.points.map((p) => stepDecimals(p.value))));
    return { ...base, chart: item.chart, title: item.title || '', unit: item.unit || '', showValues: item.showValues !== false, points: item.points.map((p) => ({ label: p.label, value: p.value, display: formatPracticeNumber(p.value, decimals) })) };
  }
  if (item.type === 'order_steps') return { ...base, steps: item.steps, start: orderStepsStart(item) };
  return base;
}

/**
 * appData.practiceResult for a graded visual item: what the locked widget shows.
 * `answer` is what the widget sent, `grade` is gradePracticeItem's result.
 */
export function practiceResultFor(item, answer, grade) {
  if (item.type === 'number_line') {
    const stops = numberLineStops(item);
    const slack = item.step * 1e-6;
    const inside = stops.map((v, i) => (Math.abs(v - item.answer) <= item.tolerance + slack ? i : -1)).filter((i) => i >= 0);
    let answerIndex = 0;
    stops.forEach((v, i) => { if (Math.abs(v - item.answer) < Math.abs(stops[answerIndex] - item.answer)) answerIndex = i; });
    const index = stops.findIndex((v) => Math.abs(v - Number(answer)) <= slack);
    return { correct: grade.correct, index: index >= 0 ? index : null, answerIndex, lo: inside[0] ?? answerIndex, hi: inside[inside.length - 1] ?? answerIndex };
  }
  if (item.type === 'chart_select') return { correct: grade.correct, picked: Number.isInteger(answer) ? answer : null, answer: item.answer };
  if (item.type === 'order_steps') return { correct: grade.correct, order: Array.isArray(answer) ? answer.slice() : [] };
  return { correct: grade.correct };
}

/** The one-component DIL program the review screen renders for a visual item. */
export function practiceProgram(item) {
  const name = PRACTICE_COMPONENT_FOR[item.type];
  if (!name) return null;
  const key = JSON.stringify(`practice:${item.id}`);
  return {
    code: `DIL.render(__dil.jsx(()=>{const __dilConstants=DIL.useConstants();return __dil.jsx(${name},__dilConstants["0"]);},{"key":${key}}));`,
    constants: { 0: practiceWidgetProps(item) },
  };
}
