// Phase 3 + 5 catalog components, evaluated INSIDE the DIL sandbox like learning-catalog.js:
//
//   Cite           inline numbered pill; press -> expanded card (title, domain, snippet,
//                  "Open source" = open_url client action). Reads server-resolved state from
//                  appData.opGenui.componentResults[__resolutionId] = {items, active_index,
//                  sources_title} (ChatGPT's Cite contract, chatgpt-findings §8). It replaces
//                  chatgpt-dil's stock Cite pill for Wonder programs only (see EXTRAS_PRELUDE).
//   Sources        numbered end-of-lesson source list (same componentResults mechanism).
//   FunctionGraph  axes + grid + sampled curves with DIL svg/path primitives, pressable
//                  parameter sliders (−/+ and a segmented track), live re-render via
//                  DIL.useState. Expressions are evaluated with public/expr.js, injected as
//                  source text, so the sandbox never uses eval/Function on model output.
//
// `catalogExtras` must stay self-contained: its source text is injected into the program.

import { createExprCompiler } from './expr.js';

/** Components bound as free identifiers (Cite is swapped in place of the stock one). */
export const EXTRA_COMPONENT_NAMES = Object.freeze(['FunctionGraph', 'Sources']);
/** Extra components the server validates (catalog-schema.js LEARNING_COMPONENTS). */
export const EXTRA_SCHEMA_NAMES = Object.freeze(['FunctionGraph']);

export function catalogExtras(__dil, DIL, GenUI, expr) {
  const h = __dil.jsx;
  const F = __dil.Fragment;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const fmt = (v) => {
    if (!Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
    return String(Number(v.toFixed(d)));
  };
  const useResult = (rid) => DIL.useAppData((ad) => ad?.opGenui?.componentResults?.[rid] || null);

  // ------------------------------------------------------------------ Cite
  function Cite(props) {
    const res = useResult(props.__resolutionId);
    const [open, setOpen] = DIL.useState(false);
    const items = res && res.status === 'resolved' ? arr(res.state?.items).filter((i) => i && i.url) : [];
    if (!items.length) return null;
    const label = items.map((i) => str(i.index || '?')).join(',');
    const pill = h('pressable', {
      __component: 'Cite', inline: true, variant: 'cite', ariaPressed: open,
      ariaLabel: `Source ${label}: ${str(items[0].title)}${items.length > 1 ? ` and ${items.length - 1} more` : ''}`,
      tooltip: items.map((i) => `${str(i.index)}. ${str(i.title)} (${str(i.domain)})`).join('\n'),
      onClick: () => setOpen(!open),
    }, label);
    if (!open) return pill;
    return h(F, null, pill,
      h('col', { __component: 'CiteCard', gap: 3, padding: 4, radius: 'xl', border: { size: 1, color: 'default' }, background: 'surface' },
        ...items.map((it) => h('col', { key: `c${it.ref}`, gap: 1 },
          h('row', { gap: 2, align: 'center' },
            h('badge', { color: 'info' }, str(it.index)),
            h('text', { size: 'xs', weight: 'semibold', color: 'secondary' }, str(it.domain))),
          h('text', { size: 'sm', weight: 'semibold' }, str(it.title)),
          it.snippet ? h('text', { size: 'xs', color: 'secondary' }, `“${str(it.snippet)}”`) : null,
          h('row', { gap: 2 },
            h('button', { size: 'sm', variant: 'ghost', ariaLabel: `Open ${str(it.title)}`, onClick: () => GenUI.openUrl(it.url) }, 'Open source')))),
        h('row', { justify: 'end' }, h('button', { size: 'sm', variant: 'outline', onClick: () => setOpen(false) }, 'Close'))));
  }

  // ------------------------------------------------------------------ Sources
  function Sources(props) {
    const res = useResult(props.__resolutionId);
    const items = res && res.status === 'resolved' ? arr(res.state?.items).filter((i) => i && i.url) : [];
    if (!items.length) return null;
    return h('col', { __component: 'Sources', gap: 2, padding: 4, radius: '2xl', border: { size: 1, color: 'default' }, background: 'surface-secondary' },
      h('row', { gap: 2, align: 'center' },
        h('icon', { name: 'globe', size: 'sm', color: 'brand-strong' }),
        h('text', { size: 'sm', weight: 'semibold', color: 'secondary' }, str(res.state.sources_title) || 'Sources')),
      h('col', { gap: 1 }, ...items.map((it) => h('pressable', {
        key: `s${it.ref}`, variant: 'source', padding: { x: 2, y: 2 }, radius: 'lg', ariaLabel: `Source ${str(it.index)}: ${str(it.title)} (${str(it.domain)})`,
        onClick: () => GenUI.openUrl(it.url),
      }, h('row', { gap: 3, align: 'start', width: '100%' },
        h('box', { size: 24, radius: 'full', align: 'center', justify: 'center', flex: '0 0 auto', background: 'brand-subtle' },
          h('text', { size: 'xs', weight: 'bold', color: 'brand-strong' }, str(it.index))),
        h('col', { gap: 0, flex: 1, minWidth: 0 },
          h('text', { size: 'sm', weight: 'medium' }, str(it.title)),
          h('text', { size: 'xs', color: 'tertiary' }, str(it.domain))),
        h('icon', { name: 'external-link', size: 'sm', color: 'tertiary' }))))));
  }

  // ------------------------------------------------------------------ FunctionGraph
  const COLORS = ['brand-strong', 'warning', 'success'];
  const okRange = (r, d) => (Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1] ? r : d);
  function ticks(a, b, target) {
    const raw = (b - a) / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let t = Math.ceil(a / step) * step; t <= b + step * 1e-9 && out.length < 40; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    return out;
  }
  /** Polyline segments -> an SVG path clipped to the y window (no <clipPath> primitive). */
  function curvePath(segs, sx, sy, y0, y1) {
    const P = (x, y) => `${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`;
    const inside = (y) => y >= y0 && y <= y1;
    const cross = (a, b, yb) => [a[0] + ((yb - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), yb];
    let d = '';
    for (const seg of segs) {
      let down = false;
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1];
        const b = seg[i];
        const ia = inside(a[1]);
        const ib = inside(b[1]);
        if (ia && ib) { if (!down) { d += `M${P(a[0], a[1])}`; down = true; } d += `L${P(b[0], b[1])}`; }
        else if (ia && !ib) { const c = cross(a, b, b[1] > y1 ? y1 : y0); if (!down) d += `M${P(a[0], a[1])}`; d += `L${P(c[0], c[1])}`; down = false; }
        else if (!ia && ib) { const c = cross(a, b, a[1] > y1 ? y1 : y0); d += `M${P(c[0], c[1])}L${P(b[0], b[1])}`; down = true; }
        else if ((a[1] > y1) !== (b[1] > y1)) { const c1 = cross(a, b, a[1] > y1 ? y1 : y0); const c2 = cross(a, b, b[1] > y1 ? y1 : y0); d += `M${P(c1[0], c1[1])}L${P(c2[0], c2[1])}`; down = false; }
        else down = false;
      }
    }
    return d;
  }
  const snap = (q, v) => {
    const step = q.step > 0 ? q.step : (q.max - q.min) / 20;
    const s = q.min + Math.round((Math.min(q.max, Math.max(q.min, v)) - q.min) / step) * step;
    return Number(Math.min(q.max, Math.max(q.min, s)).toFixed(10));
  };
  const substitute = (src, vals) => str(src).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => (Object.prototype.hasOwnProperty.call(vals, id) ? fmt(vals[id]) : id));

  function ParamControl(props) {
    const { q, value, onChange } = props;
    const steps = Math.round((q.max - q.min) / (q.step || 1));
    const n = Math.max(2, Math.min(11, steps + 1));
    const stops = Array.from({ length: n }, (_, j) => snap(q, q.min + ((q.max - q.min) * j) / (n - 1)));
    const eps = (q.max - q.min) * 1e-6;
    const unit = q.unit ? ` ${str(q.unit)}` : '';
    return h('col', { gap: 1, __component: 'GraphParam' },
      h('row', { justify: 'between', align: 'baseline', gap: 2 },
        h('text', { size: 'sm', color: 'secondary' }, q.label ? `${str(q.label)} (${q.name})` : str(q.name)),
        h('text', { size: 'sm', weight: 'semibold', tabularNums: true }, `${q.name} = ${fmt(value)}${unit}`)),
      h('row', { gap: 2, align: 'center' },
        h('pressable', { variant: 'stepper', size: 34, radius: 'full', align: 'center', justify: 'center', disabled: value <= q.min + eps, ariaLabel: `Decrease ${q.name}`, onClick: () => onChange(snap(q, value - q.step)) }, h('icon', { name: 'minus', size: 'sm' })),
        h('row', { gap: 1, flex: 1, minWidth: 0 }, ...stops.map((sv, j) => h('pressable', {
          key: `t${j}`, flex: 1, height: 22, radius: 'md', variant: sv <= value + eps ? 'track-on' : 'track',
          ariaPressed: Math.abs(sv - value) <= eps, ariaLabel: `Set ${q.name} to ${fmt(sv)}`, onClick: () => onChange(sv),
        }))),
        h('pressable', { variant: 'stepper', size: 34, radius: 'full', align: 'center', justify: 'center', disabled: value >= q.max - eps, ariaLabel: `Increase ${q.name}`, onClick: () => onChange(snap(q, value + q.step)) }, h('icon', { name: 'plus', size: 'sm' }))));
  }

  function FunctionGraph(props) {
    const fns = arr(props.fns).filter((f) => f && typeof f.fn === 'string');
    const params = arr(props.params).filter((q) => q && typeof q.name === 'string' && q.max > q.min);
    const isMobile = DIL.useIsMobile();
    const initial = () => Object.fromEntries(params.map((q) => [q.name, snap(q, Number(q.value))]));
    const [vals, setVals] = DIL.useState(initial);
    const names = ['x', ...params.map((q) => q.name)];
    const compiled = DIL.useMemo(() => fns.map((f) => expr.compile(f.fn, names)), [fns.map((f) => f.fn).join('\u0000'), names.join(',')]);
    if (!fns.length) return null;
    const [x0, x1] = okRange(props.xRange, [-10, 10]);
    const [y0, y1] = okRange(props.yRange, [-10, 10]);
    const W = isMobile ? 320 : 600;
    const H = isMobile ? 220 : 300;
    const sx = (x) => ((x - x0) / (x1 - x0)) * W;
    const sy = (y) => H - ((y - y0) / (y1 - y0)) * H;
    const scope = { ...initial(), ...vals };
    const grid = [...ticks(x0, x1, isMobile ? 4 : 8).map((t) => `M${sx(t).toFixed(1)} 0V${H}`), ...ticks(y0, y1, isMobile ? 4 : 6).map((t) => `M0 ${sy(t).toFixed(1)}H${W}`)].join('');
    const axes = `${x0 <= 0 && x1 >= 0 ? `M${sx(0).toFixed(1)} 0V${H}` : ''}${y0 <= 0 && y1 >= 0 ? `M0 ${sy(0).toFixed(1)}H${W}` : ''}`;
    const span = y1 - y0;
    const curves = compiled.map((c, i) => (c.ok
      ? h('path', { key: `f${i}`, d: curvePath(expr.sample(c.fn, scope, x0, x1, isMobile ? 160 : 260, Math.max(Math.abs(y0), Math.abs(y1)) + span * 40), sx, sy, y0, y1) || 'M0 0', fill: 'none', stroke: COLORS[i % 3], strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke', __component: 'GraphCurve' })
      : null));
    const points = arr(props.points).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    const dots = points.filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
      .map((p, i) => h('circle', { key: `p${i}`, cx: Number(sx(p.x).toFixed(1)), cy: Number(sy(p.y).toFixed(1)), r: isMobile ? 4 : 5, fill: 'surface', stroke: 'danger', strokeWidth: 2.5, vectorEffect: 'non-scaling-stroke' }));
    const changed = params.some((q) => Math.abs((vals[q.name] ?? q.value) - snap(q, q.value)) > 1e-9);
    const setParam = (name, v) => setVals({ ...scope, [name]: v });
    const yLabel = str(props.yLabel) || 'y';
    const xLabel = str(props.xLabel) || 'x';
    return h('col', { __component: 'FunctionGraph', border: { size: 1, color: 'default' }, radius: '2xl', padding: isMobile ? 4 : 5, gap: 3, background: 'surface', clip: true },
      h('row', { justify: 'between', align: 'center', gap: 3, wrap: true },
        h('row', { gap: 2, align: 'center', flex: '1 1 auto', minWidth: 0 },
          h('icon', { name: 'trending-up', size: 'md', color: 'brand-strong' }),
          h('text', { size: 'sm', weight: 'semibold', color: 'secondary' }, str(props.title) || 'Explore the graph')),
        changed ? h('button', { size: 'sm', variant: 'ghost', onClick: () => setVals(initial()) }, 'Reset') : null),
      h('col', { gap: 1 }, ...fns.map((f, i) => h('row', { key: `l${i}`, gap: 2, align: 'center', wrap: true },
        h('box', { width: 14, height: 4, radius: 'full', background: COLORS[i % 3], flex: '0 0 auto' }),
        h('text', { size: 'sm', __component: 'GraphFormula' }, h('code', null, `y = ${substitute(f.fn, scope).replace(/\*/g, '·')}`)),
        f.label ? h('text', { size: 'xs', color: 'secondary' }, str(f.label)) : null))),
      h('col', { gap: 1 },
        h('text', { size: 'xs', color: 'tertiary', tabularNums: true }, `${yLabel}: ${fmt(y0)} to ${fmt(y1)}`),
        h('box', { radius: 'lg', background: 'surface-secondary', clip: true },
          h('svg', { viewBox: `-6 -6 ${W + 12} ${H + 12}`, width: '100%', role: 'img', ariaLabel: `Graph of y = ${fns.map((f) => substitute(f.fn, scope)).join(' and ')} for ${xLabel} from ${fmt(x0)} to ${fmt(x1)}` },
            h('path', { d: grid, fill: 'none', stroke: 'tertiary', strokeOpacity: 0.22, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }),
            axes ? h('path', { d: axes, fill: 'none', stroke: 'secondary', strokeOpacity: 0.75, strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' }) : null,
            ...curves,
            ...dots)),
        h('row', { justify: 'between', gap: 2 },
          h('text', { size: 'xs', color: 'tertiary', tabularNums: true }, fmt(x0)),
          h('text', { size: 'xs', color: 'tertiary' }, xLabel),
          h('text', { size: 'xs', color: 'tertiary', tabularNums: true }, fmt(x1)))),
      points.length ? h('row', { gap: 2, wrap: true }, ...points.map((p, i) => h('badge', { key: `b${i}`, color: 'danger' }, `${p.label ? `${str(p.label)} ` : ''}(${fmt(p.x)}, ${fmt(p.y)})`))) : null,
      params.length ? h('col', { gap: 3, padding: { top: 1 } }, ...params.map((q) => h(ParamControl, { key: `q${q.name}`, q, value: scope[q.name], onChange: (v) => setParam(q.name, v) }))) : null,
      props.caption ? h('text', { size: 'sm', color: 'secondary' }, str(props.caption)) : null);
  }

  return { FunctionGraph, Sources, WonderCite: Cite };
}

/**
 * Prelude appended after LEARNING_PRELUDE. Binds FunctionGraph/Sources and swaps the stock
 * Cite (a Function parameter of the program, so it is reassigned, not redeclared).
 */
export const EXTRAS_PRELUDE = `const {${EXTRA_COMPONENT_NAMES.join(',')},WonderCite}=(${catalogExtras.toString()})(__dil,DIL,GenUI,(${createExprCompiler.toString()})());\ntry{Cite=WonderCite}catch{}\n`;
