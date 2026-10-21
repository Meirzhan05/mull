// Wonder learning catalog: Wondering's lesson widgets rebuilt as DIL catalog components.
//
// These run INSIDE the DIL sandbox (worker), next to chatgpt-dil's catalog, and are written
// only with DIL primitives (box/row/col/text/title/pressable/button/badge/icon/svg/...) and
// DIL hooks. `learningCatalog` must stay fully self-contained: its source text is injected
// in front of every program (see learning-runtime.js), so it may not reference anything
// outside its own body. Props arrive already validated by server/catalog-schema.js, but every
// component still guards against missing fields (a stale persisted program, a partial tree).
//
// Widgets whose state should survive a reload use `useSaved(props, key, initial, restore)`
// (view-state.js) instead of DIL.useState: LessonStepper, Reveal, CompareToggle,
// InputOutputSlider, Quiz (local progress; server componentResults win) and Flashcards.
// `restore` validates a saved value against the current props and returns undefined to fall
// back to `initial`. Popovers and selections (KeyTerm, Flowchart, Timeline, ...) stay ephemeral.

import { createUseSaved } from './view-state.js';

export const LEARNING_COMPONENT_NAMES = Object.freeze([
  'LessonStepper', 'Reveal', 'CompareToggle', 'InputOutputSlider', 'Flowchart', 'Timeline', 'BarChart',
  'ConceptMap', 'Cycle', 'Quiz', 'Flashcards', 'KeyTerm', 'Callout', 'Celebration', 'TeacherCard',
]);

export function learningCatalog(__dil, DIL, GenUI, useSavedImpl) {
  const h = __dil.jsx;
  const useSaved = useSavedImpl || ((_props, _key, initial) => DIL.useState(initial));
  const isInt = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
  const F = __dil.Fragment;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  // Inline markdown -> DIL primitives (bold/italic/code/inline math). Built here instead of
  // using the host's text-only-markdown, whose "$...$" math rule swallows dollar amounts
  // ("$1,000 × 10% = **$100**").
  const INLINE_RE = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|`([^`]+)`/g;
  // Math spans first, with the same rules as server/math-spans.js: \(…\) and \[…\], $$…$$, and
  // $…$ only when the opener is not followed by whitespace, the next "$" on the line is not
  // preceded by whitespace or followed by a digit, and the content looks like math. Prices
  // ("$40,000 … $3, $4", "costs $5 and $10") stay text.
  const MATHY = /[A-Za-z\\^_={}]/;
  function splitMath(s) {
    const out = [];
    let buf = '';
    let i = 0;
    const push = (v, display) => { if (buf) out.push(buf); buf = ''; if (v) out.push({ math: v, display }); };
    while (i < s.length) {
      const c = s[i];
      if (c === '`') {
        const e = s.indexOf('`', i + 1);
        if (e > i) { buf += s.slice(i, e + 1); i = e + 1; continue; }
      }
      if (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '[')) {
        const e = s.indexOf(s[i + 1] === '(' ? '\\)' : '\\]', i + 2);
        if (e >= 0) { push(s.slice(i + 2, e).trim(), s[i + 1] === '['); i = e + 2; continue; }
      }
      if (c === '\\' && s[i + 1] === '$') { buf += '$'; i += 2; continue; }
      if (c === '$' && s[i + 1] === '$') {
        const e = s.indexOf('$$', i + 2);
        if (e >= 0) { push(s.slice(i + 2, e).trim(), true); i = e + 2; continue; }
      } else if (c === '$' && s[i + 1] && !/\s/.test(s[i + 1])) {
        let j = i + 1;
        while (j < s.length && s[j] !== '$' && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
        if (s[j] === '$' && !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] || '') && MATHY.test(s.slice(i + 1, j))) {
          push(s.slice(i + 1, j), false);
          i = j + 1;
          continue;
        }
      }
      buf += c;
      i++;
    }
    if (buf) out.push(buf);
    return out;
  }
  function inline(s) {
    const out = [];
    for (const piece of splitMath(s)) {
      if (typeof piece !== 'string') { out.push(h('math', piece.display ? { display: true } : null, piece.math)); continue; }
      let last = 0;
      let m;
      INLINE_RE.lastIndex = 0;
      while ((m = INLINE_RE.exec(piece))) {
        if (m.index > last) out.push(piece.slice(last, m.index));
        if (m[1] != null || m[2] != null) out.push(h('bold', null, m[1] ?? m[2]));
        else if (m[3] != null) out.push(h('italic', null, m[3]));
        else out.push(h('code', null, m[4]));
        last = INLINE_RE.lastIndex;
      }
      if (last < piece.length) out.push(piece.slice(last));
    }
    return out;
  }
  const md = (s, props) => h('text', props || null, ...inline(str(s)));
  const LETTERS = 'ABCDEFGH';

  function Card(props) {
    const { name, children, padding, gap } = props;
    return h('col', { __component: name, border: { size: 1, color: 'default' }, radius: '2xl', padding: padding ?? 5, gap: gap ?? 4, background: 'surface', clip: true }, children);
  }
  function Header(props) {
    return h('row', { justify: 'between', align: 'center', gap: 3, wrap: true },
      h('row', { gap: 2, align: 'center', flex: '1 1 auto', minWidth: 0 },
        props.icon ? h('icon', { name: props.icon, size: 'md', color: 'brand-strong' }) : null,
        h('text', { size: 'sm', weight: 'semibold', color: 'secondary' }, props.title)),
      props.right || null);
  }

  // ------------------------------------------------------------------ KeyTerm (inline)
  function KeyTerm(props) {
    const [open, setOpen] = DIL.useState(false);
    const term = str(props.term);
    return h(F, null,
      h('pressable', { __component: 'KeyTerm', inline: true, variant: 'keyterm', ariaPressed: open, ariaLabel: `Key term ${term}. Show definition`, onClick: () => setOpen(!open) }, h('bold', null, term)),
      open ? h('caption', { color: 'secondary', __component: 'KeyTermDefinition' }, ` (${str(props.definition)}) `) : null,
      open ? h('pressable', {
        inline: true, variant: 'keyterm-more', ariaLabel: `Explain ${term} in more detail`,
        onClick: () => GenUI.dispatchWidgetAction({ type: 'explain_more', componentName: 'KeyTerm', nativeWidgetResolutionId: props.__resolutionId, payload: { topic: term, query: `Can you explain "${term}" in more detail, with an example from this lesson?` } }),
      }, h('caption', { color: 'brand-strong' }, 'Explain more')) : null);
  }

  // ------------------------------------------------------------------ Callout (wondering-lens)
  const TONE = {
    insight: ['lightbulb', 'Wonder lens'], tip: ['sparkles', 'Tip'], info: ['info', 'Note'], warning: ['alert-triangle', 'Watch out'], example: ['book', 'Example'],
  };
  function Callout(props) {
    const tone = TONE[props.tone] ? props.tone : 'insight';
    const [icon, label] = TONE[tone];
    const kids = props.children;
    return h('row', { __component: 'Callout', align: 'start', gap: 3, padding: 4, radius: 'xl', background: `callout-${tone}`, border: { side: 'left', size: 4, color: `callout-${tone}-edge` } },
      h('box', { size: 32, radius: 'full', align: 'center', justify: 'center', background: `callout-${tone}-edge`, flex: '0 0 auto' }, h('icon', { name: icon, size: 'sm', color: 'white' })),
      h('col', { gap: 1, flex: 1, minWidth: 0 },
        h('text', { size: 'xs', weight: 'bold', color: `callout-${tone}-ink` }, label.toUpperCase()),
        props.title ? h('title', { size: 'sm' }, str(props.title)) : null,
        props.body ? md(props.body) : null,
        kids == null ? null : h('col', { gap: 2 }, kids)));
  }

  // ------------------------------------------------------------------ LessonStepper
  function LessonStepper(props) {
    const steps = arr(props.steps);
    const n = steps.length;
    const [i, setI] = useSaved(props, 'i', 0, (v) => (isInt(v, n) ? v : undefined));
    if (!n) return null;
    const k = Math.min(i, n - 1);
    const s = steps[k];
    return h(Card, { name: 'LessonStepper' },
      h(Header, { icon: 'arrow-right', title: str(props.title) || 'Step by step', right: h('badge', { color: 'info' }, `${k + 1} / ${n}`) }),
      h('row', { gap: 1 }, ...steps.map((_, j) => h('pressable', {
        key: `dot${j}`, flex: 1, height: 6, radius: 'full', background: j <= k ? 'brand' : 'surface-tertiary', ariaLabel: `Step ${j + 1}`, ariaPressed: j === k, onClick: () => setI(j),
      }))),
      h('col', { gap: 2, key: `step${k}`, __component: 'StepBody' },
        s.label ? h('title', { size: 'md' }, str(s.label)) : null,
        md(s.text, { size: 'md' })),
      h('row', { justify: 'between', gap: 3 },
        h('button', { variant: 'outline', size: 'md', disabled: k === 0, onClick: () => setI(k - 1) }, 'Back'),
        k < n - 1
          ? h('button', { size: 'md', onClick: () => setI(k + 1) }, 'Next step')
          : h('button', { size: 'md', variant: 'secondary', onClick: () => setI(0) }, 'Start over')));
  }

  // ------------------------------------------------------------------ Reveal
  function Reveal(props) {
    const items = arr(props.items);
    const [open, setOpen] = useSaved(props, 'open', {}, (v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([j, on]) => on === true && isInt(Number(j), items.length)))
      : undefined));
    const all = items.length > 0 && items.every((_, j) => open[j]);
    return h(Card, { name: 'Reveal', gap: 3 },
      h(Header, { icon: 'search', title: str(props.title) || 'Predict, then check',
        right: items.length > 1 ? h('button', { size: 'sm', variant: 'ghost', onClick: () => setOpen(all ? {} : Object.fromEntries(items.map((_, j) => [j, true]))) }, all ? 'Hide all' : 'Reveal all') : null }),
      ...items.map((it, j) => h('col', { key: `r${j}`, gap: 0, radius: 'xl', border: { size: 1, color: open[j] ? 'brand' : 'subtle' }, clip: true },
        h('pressable', { padding: { x: 4, y: 3 }, ariaPressed: !!open[j], variant: 'ghost', onClick: () => setOpen({ ...open, [j]: !open[j] }) },
          h('row', { gap: 3, align: 'center', justify: 'between', width: '100%' },
            md(it.label, { weight: 'medium' }),
            h('icon', { name: open[j] ? 'chevron-up' : 'chevron-down', size: 'md', color: 'secondary' }))),
        open[j] ? h('box', { padding: { x: 4, bottom: 4, top: 1 }, background: 'surface-secondary' }, md(it.content)) : null)));
  }

  // ------------------------------------------------------------------ CompareToggle
  function CompareToggle(props) {
    const left = props.left || { label: 'A', points: [] };
    const right = props.right || { label: 'B', points: [] };
    const isMobile = DIL.useIsMobile();
    const [saved, setView] = useSaved(props, 'view', 'left', (v) => (v === 'left' || v === 'right' || v === 'both' ? v : undefined));
    const view = isMobile && saved === 'both' ? 'left' : saved; // no side-by-side on phones
    const seg = (key, label) => h('pressable', {
      key, flex: 1, padding: { x: 3, y: 2 }, radius: 'full', variant: view === key ? 'segment-on' : 'segment', ariaPressed: view === key, onClick: () => setView(key),
    }, h('text', { size: 'sm', weight: 'semibold', textAlign: 'center' }, label));
    const sideView = (s, accent) => h('col', { key: s.label, gap: 2, flex: 1, minWidth: 0, padding: 4, radius: 'xl', background: accent },
      h('title', { size: 'sm' }, str(s.label)),
      h('list', { marker: 'bullet' }, ...arr(s.points).map((p, j) => h('list-item', { key: `p${j}` }, md(p)))));
    return h(Card, { name: 'CompareToggle', gap: 3 },
      h(Header, { icon: 'copy', title: str(props.title) || 'Compare' }),
      h('row', { gap: 1, padding: 1, radius: 'full', background: 'surface-tertiary' }, seg('left', left.label), seg('right', right.label), isMobile ? null : seg('both', 'Side by side')),
      view === 'both'
        ? h('row', { gap: 3, align: 'stretch' }, sideView(left, 'compare-left'), sideView(right, 'compare-right'))
        : sideView(view === 'left' ? left : right, view === 'left' ? 'compare-left' : 'compare-right'));
  }

  // ------------------------------------------------------------------ InputOutputSlider
  function InputOutputSlider(props) {
    const stops = arr(props.stops);
    const n = stops.length;
    const [i, setI] = useSaved(props, 'i', 0, (v) => (isInt(v, n) ? v : undefined));
    if (!n) return null;
    const k = Math.min(i, n - 1);
    const s = stops[k];
    const pct = n > 1 ? (k / (n - 1)) * 100 : 100;
    const unit = props.unit ? ` ${str(props.unit)}` : '';
    return h(Card, { name: 'InputOutputSlider' },
      h(Header, { icon: 'trending-up', title: str(props.title) || 'Drag to explore' }),
      h('col', { gap: 2 },
        h('row', { justify: 'between', align: 'baseline' },
          h('text', { size: 'sm', color: 'secondary' }, str(props.inputLabel)),
          h('text', { size: 'sm', weight: 'semibold', tabularNums: true }, `${s.label ? str(s.label) : str(s.value)}${s.label ? '' : unit}`)),
        h('box', { height: 8, radius: 'full', background: 'surface-tertiary', clip: true },
          h('box', { height: 8, radius: 'full', background: 'brand', width: `${Math.max(pct, 4)}%` })),
        h('row', { gap: 1, justify: 'between' }, ...stops.map((st, j) => h('pressable', {
          key: `s${j}`, flex: 1, padding: { y: 2 }, radius: 'lg', variant: j === k ? 'stop-on' : 'stop', ariaPressed: j === k, ariaLabel: `${str(props.inputLabel)} ${str(st.label || st.value)}`, onClick: () => setI(j),
        }, h('text', { size: 'xs', weight: j === k ? 'bold' : 'regular', textAlign: 'center', tabularNums: true }, str(st.label || st.value)))))),
      h('col', { gap: 1, padding: 4, radius: 'xl', background: 'brand-subtle', key: `o${k}` },
        h('text', { size: 'xs', weight: 'semibold', color: 'secondary' }, str(props.outputLabel).toUpperCase()),
        h('title', { size: 'xl' }, str(s.output)),
        s.description ? md(s.description, { size: 'sm', color: 'secondary' }) : null));
  }

  // ------------------------------------------------------------------ Flowchart
  const NODE_STYLE = { start: ['Start', 'success'], end: ['End', 'info'], decision: ['Decision', 'warning'], process: ['Step', 'default'] };
  function Flowchart(props) {
    const nodes = arr(props.nodes);
    const conns = arr(props.connections);
    const initial = Math.max(0, nodes.findIndex((n) => n.highlighted));
    const [sel, setSel] = DIL.useState(nodes.some((n) => n.highlighted) ? initial : -1);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const out = [];
    nodes.forEach((node, j) => {
      const [badge, color] = NODE_STYLE[node.type] || NODE_STYLE.process;
      const active = sel === j;
      const outgoing = conns.filter((c) => c.from === node.id);
      const next = nodes[j + 1];
      const toNext = next ? outgoing.find((c) => c.to === next.id) : null;
      const jumps = outgoing.filter((c) => c !== toNext);
      out.push(h('pressable', {
        key: `n${node.id}`, padding: { x: 4, y: 3 }, radius: node.type === 'decision' ? 'lg' : 'xl', variant: active ? 'node-on' : `node-${node.type || 'process'}`, ariaPressed: active,
        onClick: () => setSel(active ? -1 : j),
      }, h('row', { gap: 3, align: 'center', width: '100%' },
        h('badge', { color }, badge),
        h('text', { weight: 'medium', flex: 1 }, str(node.label)),
        jumps.length ? h('icon', { name: 'arrow-up-right', size: 'sm', color: 'secondary' }) : null)));
      if (jumps.length && (active || node.type === 'decision')) {
        out.push(h('col', { key: `j${node.id}`, gap: 1, padding: { left: 6 } }, ...jumps.map((c, q) => h('row', { key: `jj${q}`, gap: 2, align: 'center' },
          h('icon', { name: 'arrow-up-right', size: 'xs', color: 'warning' }),
          h('text', { size: 'sm', color: 'secondary' }, `${c.label ? `${str(c.label)}: ` : ''}go to "${str(byId[c.to]?.label || c.to)}"`)))));
      }
      if (next) {
        out.push(h('row', { key: `a${node.id}`, gap: 2, align: 'center', padding: { left: 5 } },
          h('icon', { name: 'chevron-down', size: 'md', color: toNext ? 'brand-strong' : 'tertiary' }),
          toNext && toNext.label ? h('text', { size: 'xs', color: 'secondary' }, str(toNext.label)) : null));
      }
    });
    return h(Card, { name: 'Flowchart', gap: 3 },
      h(Header, { icon: 'arrow-right', title: str(props.title) || 'How it flows', right: h('text', { size: 'xs', color: 'tertiary' }, 'Tap a step') }),
      h('col', { gap: 1 }, ...out));
  }

  // ------------------------------------------------------------------ Timeline
  function Timeline(props) {
    const events = arr(props.events);
    const [sel, setSel] = DIL.useState(Math.max(0, events.findIndex((e) => e.highlighted)));
    return h(Card, { name: 'Timeline', gap: 2 },
      h(Header, { icon: 'clock', title: str(props.title) || 'Timeline' }),
      h('col', { gap: 0 }, ...events.map((e, j) => {
        const active = j === sel;
        return h('pressable', { key: `e${j}`, radius: 'lg', variant: 'ghost', ariaPressed: active, onClick: () => setSel(j) },
          h('row', { align: 'stretch', gap: 3, width: '100%' },
            h('col', { width: 18, align: 'center', gap: 0, flex: '0 0 auto' },
              h('box', { size: active ? 16 : 12, radius: 'full', background: active ? 'brand' : 'surface-tertiary', border: { size: 2, color: 'brand' }, margin: { top: 1 } }),
              j < events.length - 1 ? h('box', { width: 2, flex: 1, background: 'border-timeline', minHeight: 18 }) : null),
            h('col', { gap: 0, flex: 1, minWidth: 0, padding: { bottom: 3 } },
              h('text', { size: 'xs', weight: 'bold', color: 'brand-strong' }, str(e.date)),
              h('text', { weight: active ? 'semibold' : 'medium' }, str(e.label)),
              active && e.description ? md(e.description, { size: 'sm', color: 'secondary' }) : null)));
      })));
  }

  // ------------------------------------------------------------------ BarChart
  function BarChart(props) {
    const bars = arr(props.bars);
    const [sel, setSel] = DIL.useState(Math.max(0, bars.findIndex((b) => b.highlighted)));
    const max = Math.max(1e-9, ...bars.map((b) => Math.abs(Number(b.value) || 0)));
    const unit = str(props.unit);
    const fmt = (v) => { const x = Number(v) || 0; return Math.abs(x) >= 1000 ? x.toLocaleString('en-US') : String(Math.round(x * 100) / 100); };
    const chosen = bars[sel];
    return h(Card, { name: 'BarChart', gap: 3 },
      h(Header, { icon: 'trending-up', title: str(props.title) || 'Compare the numbers', right: props.yLabel ? h('text', { size: 'xs', color: 'tertiary' }, str(props.yLabel)) : null }),
      h('col', { gap: 2 }, ...bars.map((b, j) => {
        const pct = (Math.abs(Number(b.value) || 0) / max) * 100;
        const active = j === sel;
        return h('pressable', { key: `b${j}`, radius: 'lg', variant: 'ghost', ariaPressed: active, ariaLabel: `${str(b.label)}: ${fmt(b.value)} ${unit}`, onClick: () => setSel(j) },
          h('col', { gap: 1, width: '100%', padding: { x: 1, y: 1 } },
            h('row', { justify: 'between', gap: 2 },
              h('text', { size: 'sm', weight: active ? 'semibold' : 'regular' }, str(b.label)),
              h('text', { size: 'sm', tabularNums: true, color: 'secondary' }, `${fmt(b.value)} ${unit}`)),
            h('box', { height: 12, radius: 'full', background: 'surface-tertiary', clip: true },
              h('box', { height: 12, radius: 'full', width: `${Math.max(pct, 2)}%`, background: active ? 'brand' : 'brand-muted' }))));
      })),
      chosen && chosen.description ? h('box', { padding: 3, radius: 'lg', background: 'surface-secondary', key: `d${sel}` }, md(chosen.description, { size: 'sm' })) : null,
      props.xLabel ? h('text', { size: 'xs', color: 'tertiary', textAlign: 'center' }, str(props.xLabel)) : null);
  }

  // ------------------------------------------------------------------ ConceptMap
  function ConceptMap(props) {
    const nodes = arr(props.nodes);
    const conns = arr(props.connections);
    const isMobile = DIL.useIsMobile();
    const [sel, setSel] = DIL.useState(null);
    const label = (id) => (nodes.find((n) => n.id === id)?.label ?? (id === 'center' ? props.centerConcept : id));
    const linked = sel ? new Set(conns.filter((c) => c.from === sel || c.to === sel).flatMap((c) => [c.from, c.to])) : null;
    return h(Card, { name: 'ConceptMap', gap: 3 },
      h(Header, { icon: 'globe', title: str(props.title) || 'How the ideas connect', right: h('text', { size: 'xs', color: 'tertiary' }, 'Tap a concept') }),
      h('box', { padding: { x: 4, y: 3 }, radius: 'xl', background: 'brand', align: 'center' }, h('title', { size: 'md', color: 'on-brand', textAlign: 'center' }, str(props.centerConcept))),
      h('grid', { columns: isMobile ? 1 : 2, gap: 2 }, ...nodes.map((n) => {
        const rels = conns.filter((c) => c.to === n.id || c.from === n.id);
        const dim = linked && !linked.has(n.id);
        return h('pressable', {
          key: `c${n.id}`, padding: 3, radius: 'xl', variant: sel === n.id ? 'node-on' : n.level === 2 ? 'node-sub' : 'node-process', opacity: dim ? 0.45 : 1, ariaPressed: sel === n.id,
          onClick: () => setSel(sel === n.id ? null : n.id),
        }, h('col', { gap: 1, width: '100%' },
          h('text', { weight: 'semibold', size: n.level === 2 ? 'sm' : 'md' }, str(n.label)),
          ...rels.slice(0, 3).map((c, q) => h('text', { key: `r${q}`, size: 'xs', color: 'secondary' },
            c.from === n.id ? `${str(c.relationship)} → ${str(label(c.to))}` : `${str(label(c.from))} → ${str(c.relationship)}`))));
      })));
  }

  // ------------------------------------------------------------------ Cycle
  function Cycle(props) {
    const stages = arr(props.stages);
    const n = stages.length;
    const isMobile = DIL.useIsMobile();
    const [i, setI] = DIL.useState(Math.max(0, stages.findIndex((s) => s.highlighted)));
    if (!n) return null;
    const k = Math.min(i, n - 1);
    const R = 70;
    const pts = stages.map((_, j) => { const a = -Math.PI / 2 + (j / n) * Math.PI * 2; return [100 + R * Math.cos(a), 100 + R * Math.sin(a)]; });
    const ring = h('svg', { viewBox: '0 0 200 200', width: isMobile ? '140px' : '170px', ariaLabel: `Cycle with ${n} stages`, role: 'img' },
      h('circle', { cx: 100, cy: 100, r: R, fill: 'none', stroke: 'surface-tertiary', strokeWidth: 10 }),
      h('path', { d: `M ${100} ${100 - R} A ${R} ${R} 0 ${k / n > 0.5 ? 1 : 0} 1 ${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}`, fill: 'none', stroke: 'brand', strokeWidth: 10, strokeLinecap: 'round' }),
      ...pts.map(([x, y], j) => h('circle', { key: `p${j}`, cx: Number(x.toFixed(1)), cy: Number(y.toFixed(1)), r: j === k ? 13 : 8, fill: j <= k ? 'brand' : 'surface', stroke: 'brand', strokeWidth: 3 })));
    const s = stages[k];
    return h(Card, { name: 'Cycle', gap: 3 },
      h(Header, { icon: 'loader', title: str(props.title) || 'The cycle', right: props.centerLabel ? h('badge', { color: 'info' }, str(props.centerLabel)) : null }),
      h(isMobile ? 'col' : 'row', { gap: 4, align: 'center' },
        ring,
        h('col', { gap: 2, flex: 1, minWidth: 0, width: '100%' },
          h('text', { size: 'xs', weight: 'bold', color: 'brand-strong' }, `STAGE ${k + 1} OF ${n}`),
          h('title', { size: 'md', key: `t${k}` }, str(s.label)),
          s.description ? md(s.description, { size: 'sm', color: 'secondary' }) : null,
          h('row', { gap: 1, wrap: true }, ...stages.map((st, j) => h('pressable', { key: `c${j}`, padding: { x: 2, y: 1 }, radius: 'full', variant: j === k ? 'stop-on' : 'stop', ariaPressed: j === k, onClick: () => setI(j) },
            h('text', { size: 'xs' }, `${j + 1}. ${str(st.label)}`)))),
          h('row', { gap: 2 }, h('button', { size: 'sm', onClick: () => setI((k + 1) % n) }, k === n - 1 ? 'Back to the start' : 'Next stage')))));
  }

  // ------------------------------------------------------------------ Quiz
  function QuizOption(props) {
    const { option, letter, state, onSelect, disabled } = props;
    const icon = state === 'correct' ? 'check' : state === 'wrong' ? 'x' : null;
    return h('pressable', { padding: { x: 3, y: 3 }, radius: 'xl', variant: `option-${state}`, disabled, ariaPressed: state === 'picked' || state === 'wrong' || state === 'correct', onClick: onSelect },
      h('row', { gap: 3, align: 'center', width: '100%' },
        h('box', { size: 30, radius: 'full', align: 'center', justify: 'center', flex: '0 0 auto', variant: 'letter', background: state === 'correct' ? 'success' : state === 'wrong' ? 'danger' : state === 'picked' ? 'brand' : 'surface-tertiary' },
          icon ? h('icon', { name: icon, size: 'sm', color: 'white' }) : h('text', { size: 'sm', weight: 'bold', color: state === 'picked' ? 'on-brand' : 'default' }, letter)),
        h('box', { flex: 1, minWidth: 0 }, md(option.label))));
  }

  function Quiz(props) {
    const questions = arr(props.questions);
    const rid = props.__resolutionId;
    const server = DIL.useAppData((ad) => ad?.opGenui?.componentResults?.[rid]?.state || null);
    // Local progress persists (useSaved); server-graded componentResults win when present.
    const [st, setSt] = useSaved(props, 'quiz', () => {
      const answers = {};
      for (const [qid, a] of Object.entries(server?.answers || {})) answers[qid] = { selected: arr(a.selected_values), correct: !!a.is_correct };
      const firstOpen = questions.findIndex((q) => !answers[q.id]);
      return { i: firstOpen < 0 ? questions.length : firstOpen, answers, hint: false, picked: [], attempt: server?.attempt || 0, reported: firstOpen < 0 };
    }, (v) => {
      if (server || !v || typeof v !== 'object' || !v.answers || typeof v.answers !== 'object') return undefined;
      const answers = {};
      for (const q of questions) {
        const a = v.answers[q.id];
        if (a && Array.isArray(a.selected) && a.selected.every((x) => typeof x === 'string')) answers[q.id] = { selected: a.selected, correct: a.correct === true };
      }
      const i = Number.isInteger(v.i) ? Math.max(0, Math.min(v.i, questions.length)) : 0;
      return { i, answers, hint: false, picked: [], attempt: Number.isInteger(v.attempt) && v.attempt >= 0 ? v.attempt : 0, reported: v.reported === true };
    });
    const n = questions.length;
    const score = questions.filter((q) => st.answers[q.id]?.correct).length;
    const done = n > 0 && st.i >= n;
    DIL.useEffect(() => {
      if (!done || st.reported) return;
      // report completion once per attempt (the host awards XP)
      setSt((s) => ({ ...s, reported: true }));
      GenUI.dispatchAction({ handler: 'client', type: 'quiz_complete', payload: { score, total: n, resolutionId: rid, results: questions.map((q) => ({ prompt: q.prompt, correct: !!st.answers[q.id]?.correct, ...(q.concept ? { concept: q.concept } : {}) })) } });
    }, [done, st.attempt]);
    if (!n) return null;
    const send = (type, payload) => GenUI.dispatchWidgetAction({ type, componentName: 'Quiz', nativeWidgetResolutionId: rid, payload: { attempt: st.attempt, ...payload } });

    if (done) {
      const great = score >= Math.ceil(n * 0.66);
      return h(Card, { name: 'Quiz', gap: 4 },
        h('celebration', { trigger: great, key: `cele${st.attempt}` }),
        h(Header, { icon: 'star', title: str(props.title) || 'Check your understanding' }),
        h('col', { gap: 1, align: 'center', padding: { y: 2 } },
          h('title', { size: '3xl' }, `${score} / ${n}`),
          h('text', { color: 'secondary', textAlign: 'center' }, great ? 'Great work. That idea is sticking.' : score > 0 ? 'Good start. Review the ones you missed.' : 'This one is tricky. Ask the tutor to explain it another way.')),
        h('col', { gap: 2 }, ...questions.map((q, j) => {
          const a = st.answers[q.id];
          return h('row', { key: `res${q.id}`, gap: 3, align: 'start' },
            h('box', { size: 26, radius: 'full', align: 'center', justify: 'center', flex: '0 0 auto', background: a?.correct ? 'success' : 'danger' },
              h('icon', { name: a?.correct ? 'check' : 'x', size: 'xs', color: 'white' })),
            h('col', { gap: 0, flex: 1, minWidth: 0 },
              md(q.prompt, { size: 'sm', weight: 'medium' }),
              h('text', { size: 'xs', color: 'secondary' }, `Answer: ${q.options.filter((o) => q.correct_values.includes(o.value)).map((o) => o.label).join(', ')}`)));
        })),
        h('row', { gap: 2, wrap: true, justify: 'end' },
          h('button', { variant: 'outline', size: 'md', onClick: () => { setSt({ i: 0, answers: {}, hint: false, picked: [], attempt: st.attempt + 1, reported: false }); send('quiz_restart', {}); } }, 'Try again'),
          h('button', { size: 'md', onClick: () => GenUI.issueNewTurn('Quiz me with three new questions on this lesson.', { source: 'Quiz' }) }, 'Quiz me more')));
    }

    const q = questions[st.i];
    const answer = st.answers[q.id];
    const multi = q.question_type === 'multi_select';
    const submit = (values) => {
      if (answer || !values.length) return;
      const correct = values.length === q.correct_values.length && values.every((v) => q.correct_values.includes(v));
      setSt({ ...st, answers: { ...st.answers, [q.id]: { selected: values, correct } }, picked: values, hint: false });
      send('quiz_answer', { question_id: q.id, selected_values: values, question: q });
    };
    const select = (v) => {
      if (answer) return;
      if (multi) setSt({ ...st, picked: st.picked.includes(v) ? st.picked.filter((x) => x !== v) : [...st.picked, v] });
      else submit([v]);
    };
    const stateOf = (o) => {
      if (!answer) return st.picked.includes(o.value) ? 'picked' : 'idle';
      if (q.correct_values.includes(o.value)) return 'correct';
      return answer.selected.includes(o.value) ? 'wrong' : 'dim';
    };
    const correctLabels = q.options.filter((o) => q.correct_values.includes(o.value)).map((o) => o.label).join(', ');
    const pickedLabels = answer ? q.options.filter((o) => answer.selected.includes(o.value)).map((o) => o.label).join(', ') : '';
    return h(Card, { name: 'Quiz', gap: 4 },
      h(Header, { icon: 'star', title: str(props.title) || 'Check your understanding', right: h('text', { size: 'sm', color: 'secondary', tabularNums: true }, `${st.i + 1} of ${n}`) }),
      h('row', { gap: 1 }, ...questions.map((qq, j) => {
        const a = st.answers[qq.id];
        return h('box', { key: `seg${j}`, flex: 1, height: 6, radius: 'full', background: a ? (a.correct ? 'success' : 'danger') : j === st.i ? 'brand' : 'surface-tertiary' });
      })),
      h('box', { key: `prompt${q.id}` }, md(q.prompt, { size: 'lg', weight: 'semibold' })),
      multi && !answer ? h('text', { size: 'xs', color: 'secondary' }, 'Select all that apply') : null,
      h('col', { gap: 2 }, ...q.options.map((o, j) => h(QuizOption, { key: `${q.id}:${o.value}`, option: o, letter: LETTERS[j], state: stateOf(o), disabled: !!answer, onSelect: () => select(o.value) }))),
      st.hint && q.hint && !answer
        ? h('row', { gap: 2, padding: 3, radius: 'lg', background: 'callout-tip', align: 'start' }, h('icon', { name: 'lightbulb', size: 'sm', color: 'warning' }), md(q.hint, { size: 'sm' }))
        : null,
      answer
        ? h('col', { gap: 2, padding: 4, radius: 'xl', background: answer.correct ? 'success-subtle' : 'danger-subtle', key: `fb${q.id}` },
          h('row', { gap: 2, align: 'center' },
            h('icon', { name: answer.correct ? 'check' : 'info', size: 'md', color: answer.correct ? 'success' : 'danger' }),
            h('text', { weight: 'bold', color: answer.correct ? 'success' : 'danger' }, answer.correct ? 'Correct!' : `Not quite. The answer is ${correctLabels}.`)),
          q.explanation ? md(q.explanation, { size: 'sm' }) : null)
        : null,
      h('row', { gap: 2, justify: 'between', align: 'center', wrap: true },
        !answer && q.hint ? h('button', { variant: 'ghost', size: 'md', onClick: () => setSt({ ...st, hint: !st.hint }) }, st.hint ? 'Hide hint' : 'Hint') : h('spacer', null),
        h('row', { gap: 2, wrap: true, justify: 'end' },
          answer && !answer.correct
            ? h('button', { variant: 'outline', size: 'md', onClick: () => GenUI.issueNewTurn(`I answered "${pickedLabels}" to "${q.prompt}" but the answer is "${correctLabels}". Can you explain why?`, { source: 'Quiz' }) }, 'Explain this')
            : null,
          multi && !answer ? h('button', { size: 'md', disabled: !st.picked.length, onClick: () => submit(st.picked) }, 'Check') : null,
          answer ? h('button', { size: 'md', onClick: () => setSt({ ...st, i: st.i + 1, picked: [], hint: false }) }, st.i === n - 1 ? 'See results' : 'Next question') : null)));
  }

  // ------------------------------------------------------------------ Flashcards
  function Flashcards(props) {
    const cards = arr(props.cards);
    const n = cards.length;
    const [st, setSt] = useSaved(props, 'card', { i: 0, flipped: false, saved: false }, (v) => (v && typeof v === 'object' && isInt(v.i, n)
      ? { i: v.i, flipped: v.flipped === true, saved: v.saved === true }
      : undefined));
    if (!n) return null;
    const k = Math.min(st.i, n - 1);
    const c = cards[k];
    return h(Card, { name: 'Flashcards', gap: 3 },
      h(Header, { icon: 'book', title: str(props.title) || 'Flashcards', right: h('badge', { color: 'info' }, `${k + 1} / ${n}`) }),
      h('pressable', { minHeight: 150, padding: 5, radius: '2xl', variant: st.flipped ? 'flash-back' : 'flash-front', ariaPressed: st.flipped, ariaLabel: st.flipped ? 'Show front' : 'Flip card', onClick: () => setSt({ ...st, flipped: !st.flipped }) },
        h('col', { gap: 2, align: 'center', justify: 'center', width: '100%', key: `f${k}${st.flipped}` },
          h('text', { size: 'xs', weight: 'bold', color: 'secondary' }, st.flipped ? 'ANSWER' : 'PROMPT'),
          md(st.flipped ? c.back : c.front, { size: st.flipped ? 'md' : 'xl', weight: st.flipped ? 'regular' : 'semibold' }),
          st.flipped ? null : h('text', { size: 'xs', color: 'tertiary' }, 'Tap to flip'))),
      h('row', { gap: 2, justify: 'between', wrap: true },
        h('row', { gap: 2 },
          h('button', { variant: 'outline', size: 'sm', disabled: k === 0, onClick: () => setSt({ ...st, i: k - 1, flipped: false }) }, 'Previous'),
          h('button', { size: 'sm', disabled: k === n - 1, onClick: () => setSt({ ...st, i: k + 1, flipped: false }) }, 'Next')),
        h('button', { variant: 'ghost', size: 'sm', disabled: st.saved, onClick: () => { setSt({ ...st, saved: true }); GenUI.dispatchAction({ handler: 'client', type: 'save_flashcards', payload: { cards } }); } }, st.saved ? 'Saved to review' : 'Save to review deck')));
  }

  // ------------------------------------------------------------------ Celebration
  function Celebration(props) {
    return h('col', { __component: 'Celebration', gap: 2, align: 'center', padding: 5, radius: '2xl', background: 'brand-subtle' },
      h('celebration', { trigger: true }),
      h('icon', { name: 'sparkles', size: '2xl', color: 'brand-strong' }),
      h('title', { size: 'lg', textAlign: 'center' }, str(props.message) || 'Nice work!'));
  }


  // ------------------------------------------------------------------ TeacherCard (server-resolved)
  // Teacher tool results (wondering-findings §2.3 card types) as ChatGPT-style resolved
  // components: the props carry only kind + __resolutionId; the data is
  // appData.opGenui.componentResults[__resolutionId] = {status, state}. Buttons dispatch
  // widget actions (teacher_accept / teacher_dismiss / teacher_undo / teacher_open_item) and
  // the server answers with the card's new state.
  const ITEM_ICON = { lesson: 'book', review: 'clock', quiz: 'star' };
  const ITEM_VERB = { lesson: 'Start', review: 'Review', quiz: 'Quiz me' };
  function TeacherCard(props) {
    const rid = props.__resolutionId;
    const res = DIL.useAppData((ad) => (rid ? ad?.opGenui?.componentResults?.[rid] : null) || null);
    if (!res || res.status === 'pending') {
      return h('col', { __component: 'TeacherCard', gap: 2, padding: 4, radius: '2xl', border: { size: 1, color: 'default' }, background: 'surface' },
        h('box', { height: 12, width: '40%', radius: 'full', background: 'surface-tertiary' }),
        h('box', { height: 12, width: '75%', radius: 'full', background: 'surface-tertiary' }));
    }
    const s = res.state;
    if (res.status !== 'resolved' || !s || typeof s !== 'object') {
      return h('text', { __component: 'TeacherCard', size: 'sm', color: 'tertiary' }, 'This card is no longer available.');
    }
    const act = (type, extra) => GenUI.dispatchWidgetAction({ type, componentName: 'TeacherCard', nativeWidgetResolutionId: rid, payload: { state: s, ...(extra || {}) } });

    if (s.kind === 'approval') {
      const status = s.status || 'pending';
      return h('col', { __component: 'TeacherCard', gap: 3, padding: 4, radius: '2xl', border: { size: 1, color: status === 'pending' ? 'brand' : 'default' }, background: status === 'dismissed' ? 'surface-secondary' : 'surface' },
        h('row', { gap: 2, align: 'center', justify: 'between', wrap: true },
          h('row', { gap: 2, align: 'center' },
            h('icon', { name: 'sparkles', size: 'sm', color: 'brand-strong' }),
            h('text', { size: 'xs', weight: 'bold', color: 'brand-strong' }, 'SUGGESTED LESSON')),
          h('badge', { color: 'info' }, str(s.level || 'beginner'))),
        h('title', { size: 'md' }, str(s.topic)),
        s.reason ? md(s.reason, { size: 'sm', color: 'secondary' }) : null,
        status === 'pending'
          ? h('row', { gap: 2, wrap: true },
            h('button', { size: 'md', onClick: () => act('teacher_accept') }, 'Start lesson'),
            h('button', { size: 'md', variant: 'outline', onClick: () => act('teacher_dismiss') }, 'Not now'))
          : status === 'accepted'
            ? h('row', { gap: 2, align: 'center', wrap: true },
              h('badge', { color: 'success' }, 'Started'),
              h('button', { size: 'sm', variant: 'ghost', onClick: () => act('teacher_accept') }, 'Open lesson'))
            : h('row', { gap: 2, align: 'center', wrap: true },
              h('text', { size: 'sm', color: 'tertiary' }, 'Skipped for now'),
              h('button', { size: 'sm', variant: 'ghost', onClick: () => act('teacher_undo') }, 'Undo')));
    }

    if (s.kind === 'plan') {
      const days = arr(s.days);
      const items = days.flatMap((d) => arr(d.items));
      const opened = items.filter((i) => i.opened).length;
      return h('col', { __component: 'TeacherCard', gap: 3, padding: 4, radius: '2xl', border: { size: 1, color: 'default' }, background: 'surface' },
        h('row', { gap: 2, align: 'center', justify: 'between', wrap: true },
          h('row', { gap: 2, align: 'center' },
            h('icon', { name: 'calendar', size: 'sm', color: 'brand-strong' }),
            h('text', { size: 'xs', weight: 'bold', color: 'brand-strong' }, 'STUDY PLAN')),
          h('badge', { color: opened === items.length && items.length ? 'success' : 'info' }, `${days.length} days · ${opened}/${items.length} done`)),
        h('title', { size: 'md' }, str(s.goal)),
        h('col', { gap: 2 }, ...days.map((d, di) => h('col', { key: `d${di}`, gap: 1 },
          h('row', { gap: 2, align: 'center' },
            h('box', { size: 24, radius: 'full', align: 'center', justify: 'center', background: arr(d.items).every((i) => i.opened) ? 'success' : 'brand-subtle', flex: '0 0 auto' },
              h('text', { size: 'xs', weight: 'bold' }, String(d.day || di + 1))),
            h('text', { size: 'sm', weight: 'semibold' }, str(d.focus))),
          h('col', { gap: 1, padding: { left: 8 } }, ...arr(d.items).map((it) => h('pressable', {
            key: `i${it.id}`, padding: { x: 3, y: 2 }, radius: 'lg', variant: it.opened ? 'plan-item-done' : 'plan-item', ariaLabel: `${ITEM_VERB[it.kind] || 'Open'}: ${str(it.title)}`,
            onClick: () => act('teacher_open_item', { itemId: it.id }),
          }, h('row', { gap: 2, align: 'center', width: '100%' },
            h('icon', { name: it.opened ? 'check' : ITEM_ICON[it.kind] || 'book', size: 'sm', color: it.opened ? 'success' : 'secondary' }),
            h('text', { size: 'sm', flex: 1 }, str(it.title)),
            h('text', { size: 'xs', weight: 'semibold', color: 'brand-strong' }, it.opened ? 'Again' : ITEM_VERB[it.kind] || 'Open')))))))),
        s.saved
          ? h('row', { gap: 2, align: 'center', wrap: true },
            h('badge', { color: 'success' }, 'Saved to your home screen'),
            h('button', { size: 'sm', variant: 'ghost', onClick: () => act('teacher_undo') }, 'Unsave'))
          : h('row', { gap: 2, wrap: true }, h('button', { size: 'md', onClick: () => act('teacher_accept') }, 'Save plan')));
    }

    if (s.kind === 'memory') {
      const it = s.item || {};
      const label = s.status === 'off' ? 'Not saved (memory is off)' : s.status === 'undone' ? (s.op === 'forget' ? 'Kept' : 'Not remembered') : s.op === 'forget' ? 'Forgot' : 'Remembered';
      return h('row', { __component: 'TeacherCard', gap: 2, align: 'center', padding: { x: 3, y: 2 }, radius: 'xl', background: 'surface-secondary', border: { size: 1, color: 'subtle' }, wrap: true },
        h('icon', { name: s.op === 'forget' ? 'x' : 'lightbulb', size: 'sm', color: s.status === 'undone' || s.status === 'off' ? 'tertiary' : 'brand-strong' }),
        h('text', { size: 'sm', flex: 1, color: s.status === 'undone' ? 'tertiary' : 'default' }, h('bold', null, `${label}: `), str(it.fact)),
        s.status === 'off' ? null : h('button', { size: 'sm', variant: 'ghost', onClick: () => act('teacher_undo') }, s.status === 'undone' ? 'Redo' : 'Undo'));
    }

    return h('text', { __component: 'TeacherCard', size: 'sm', color: 'secondary' }, str(s.summary || s.kind));
  }

  return { LessonStepper, Reveal, CompareToggle, InputOutputSlider, Flowchart, Timeline, BarChart, ConceptMap, Cycle, Quiz, Flashcards, KeyTerm, Callout, Celebration, TeacherCard };
}

/** Program prelude that binds the learning components as free identifiers for compiled code. */
export const LEARNING_PRELUDE = `const __wonderUseSaved=(${createUseSaved.toString()})(DIL);\nconst {${LEARNING_COMPONENT_NAMES.join(',')}}=(${learningCatalog.toString()})(__dil,DIL,GenUI,__wonderUseSaved);\n`;
