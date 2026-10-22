// Media catalog components, evaluated INSIDE the DIL sandbox like learning-catalog.js:
//
//   Diagram  a model-drawn SVG figure (server/diagram.js validates it). Shapes are DIL svg
//            primitives plus the host's svg-text labels. "parts" make shapes tappable (on the
//            drawing or on the chips below it) and show that part's explanation; "steps" walk
//            through the figure with Back/Next, fading shapes in as a step first shows them and
//            dimming everything but the step's highlighted shapes. The step and the selected
//            part persist across reloads (useSaved).
//   Figure   a real image from Wikimedia Commons that the server looked up (server/figures.js):
//            a loading frame while pending, then the image (tap to enlarge), its caption, an
//            optional "Look closer" question with a revealable answer, and the author/license
//            credit with a link to the file page. Not found -> renders nothing.
//
// `catalogMedia` must stay self-contained: its source text is injected into the program.

/** Components bound as free identifiers (and validated by catalog-schema.js). */
export const MEDIA_COMPONENT_NAMES = Object.freeze(['Diagram', 'Figure']);

export function catalogMedia(__dil, DIL, GenUI, useSavedImpl, mdImpl) {
  const h = __dil.jsx;
  const useSaved = useSavedImpl || ((_props, _key, initial) => DIL.useState(initial));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const md = mdImpl || ((s, props) => h('text', props || null, str(s)));
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const f1 = (v) => Number(v.toFixed(1));

  // ------------------------------------------------------------------ Diagram
  const CLOSED = new Set(['rect', 'circle', 'ellipse', 'polygon']);
  const namesOf = (s) => [s.id, s.part, s.follows].filter(Boolean); // follows: a label's shape (server/diagram.js)

  /** Arrow geometry: the shaft (line or quadratic curve, stopped short of the tip) and heads. */
  function arrowParts(s, sw) {
    const [x1, y1] = s.from;
    const [x2, y2] = s.to;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const bend = fin(s.curve) ? s.curve : 0;
    const cx = (x1 + x2) / 2 + (-(y2 - y1) / len) * bend;
    const cy = (y1 + y2) / 2 + ((x2 - x1) / len) * bend;
    const head = Math.min(len / 3, Math.max(9, sw * 3.6));
    const tip = (tx, ty, fx, fy) => {
      const d = Math.hypot(tx - fx, ty - fy) || 1;
      const ux = (tx - fx) / d;
      const uy = (ty - fy) / d;
      const bx = tx - ux * head;
      const by = ty - uy * head;
      const w = head * 0.55;
      return { base: [bx, by], pts: `${f1(tx)},${f1(ty)} ${f1(bx - uy * w)},${f1(by + ux * w)} ${f1(bx + uy * w)},${f1(by - ux * w)}` };
    };
    const end = bend ? tip(x2, y2, cx, cy) : tip(x2, y2, x1, y1);
    const start = s.both ? (bend ? tip(x1, y1, cx, cy) : tip(x1, y1, x2, y2)) : null;
    const a = start ? start.base : [x1, y1];
    const b = end.base;
    const d = bend ? `M${f1(a[0])} ${f1(a[1])}Q${f1(cx)} ${f1(cy)} ${f1(b[0])} ${f1(b[1])}` : `M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}`;
    const full = bend ? `M${x1} ${y1}Q${f1(cx)} ${f1(cy)} ${x2} ${y2}` : `M${x1} ${y1}L${x2} ${y2}`;
    return { d, full, heads: [end.pts, start && start.pts].filter(Boolean) };
  }

  /** The DIL svg nodes for one shape (plus a wide invisible hit area for thin, tappable ones). */
  function drawShape(s, i, look) {
    const type = s.type;
    const closed = CLOSED.has(type);
    const base = fin(s.strokeWidth) ? s.strokeWidth : closed ? 1.5 : 2.5;
    const sw = look.emph ? base + 1.5 : base;
    const stroke = s.stroke || (type === 'text' ? null : 'secondary');
    const common = {
      // Shapes are pointer-only (aria-hidden, never in the tab order): the canvas is role=img and
      // the part chips below are the keyboard and screen-reader controls. Hidden shapes and free
      // labels let taps through to the shape underneath.
      key: `s${i}`, __component: 'DiagramShape', opacity: look.opacity, pointerEvents: look.hidden || (type === 'text' && !look.onClick) ? 'none' : null, ariaHidden: true,
      onClick: look.onClick || undefined,
    };
    const paint = {
      fill: closed ? s.fill || 'alpha-10' : 'none',
      fillOpacity: closed && fin(s.opacity) ? s.opacity : null,
      stroke, strokeWidth: sw, strokeDasharray: s.dashed ? `${f1(sw * 2.4)} ${f1(sw * 2)}` : null,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    };
    const lineOpacity = !closed && fin(s.opacity) ? s.opacity * look.opacity : look.opacity;
    const hit = (d) => (look.onClick && !look.hidden
      ? h('path', { key: `h${i}`, d, fill: 'none', stroke: 'transparent', strokeWidth: 16, strokeLinecap: 'round', onClick: look.onClick, ariaHidden: true, __component: 'DiagramHit' })
      : null);
    if (type === 'rect') return [h('rect', { ...common, ...paint, x: s.x, y: s.y, width: s.w, height: s.h, rx: s.r || 0 })];
    if (type === 'circle') return [h('circle', { ...common, ...paint, cx: s.x, cy: s.y, r: s.r })];
    if (type === 'ellipse') return [h('ellipse', { ...common, ...paint, cx: s.x, cy: s.y, rx: s.rx, ry: s.ry })];
    if (type === 'polygon') return [h('polygon', { ...common, ...paint, points: arr(s.points).map((q) => q.join(',')).join(' ') })];
    if (type === 'polyline' || type === 'line' || type === 'path') {
      const d = type === 'path' ? str(s.d)
        : type === 'line' && fin(s.curve) ? arrowParts(s, sw).full
          : type === 'line' ? `M${s.from[0]} ${s.from[1]}L${s.to[0]} ${s.to[1]}`
            : arr(s.points).map((q, j) => `${j ? 'L' : 'M'}${q[0]} ${q[1]}`).join('');
      return [h('path', { ...common, ...paint, fill: type === 'path' && s.fill ? s.fill : 'none', fillOpacity: type === 'path' && s.fill && fin(s.opacity) ? s.opacity : null, d, opacity: type === 'path' && s.fill ? look.opacity : lineOpacity }), hit(d)];
    }
    if (type === 'arrow') {
      const a = arrowParts(s, sw);
      return [
        h('g', { ...common, opacity: lineOpacity },
          h('path', { key: 'shaft', ...paint, fill: 'none', d: a.d }),
          ...a.heads.map((pts, j) => h('polygon', { key: `head${j}`, points: pts, fill: stroke, stroke, strokeWidth: 1, strokeLinejoin: 'round' }))),
        hit(a.full),
      ];
    }
    if (type === 'text') {
      return [h('svg-text', {
        ...common, x: s.x, y: s.y, text: str(s.text), fontSize: f1((s.size || 15) * (look.textScale || 1)), fontWeight: s.bold || look.emph ? 650 : 500,
        textAnchor: s.anchor || 'middle', dominantBaseline: 'middle', fill: s.fill || 'primary',
        ...(s.halo === false ? {} : { stroke: 'var(--d-surface-secondary)', strokeWidth: 4, strokeLinejoin: 'round', paintOrder: 'stroke' }),
      })];
    }
    return [];
  }

  function Diagram(props) {
    const shapes = arr(props.shapes).filter((s) => s && typeof s.type === 'string');
    const parts = arr(props.parts).filter((p) => p && p.id && p.label);
    const steps = arr(props.steps).filter((s) => s && (s.label || s.text));
    const n = steps.length;
    const partIds = parts.map((p) => p.id);
    const isMobile = DIL.useIsMobile();
    const [st, setSt] = useSaved(props, 'diagram', { step: 0, part: null }, (v) => (v && typeof v === 'object'
      && Number.isInteger(v.step) && v.step >= 0 && v.step < Math.max(1, n)
      && (v.part === null || partIds.includes(v.part)) ? { step: v.step, part: v.part } : undefined));
    if (!shapes.length) return null;
    const W = fin(props.width) ? props.width : 400;
    const H = fin(props.height) ? props.height : 250;
    const step = n ? Math.min(st.step, n - 1) : 0;
    const part = parts.find((p) => p.id === st.part) || null;

    // phones draw the canvas ~300px wide: enlarge labels so 12-15 unit text stays readable
    const textScale = isMobile ? Math.min(1.5, Math.max(1, W / 320)) : 1;
    // a staged name first appears at the first step whose `show` lists it
    const firstShown = {};
    steps.forEach((s, i) => { for (const id of arr(s.show)) if (!(id in firstShown)) firstShown[id] = i; });
    const focus = new Set(part ? [part.id] : n ? arr(steps[step].highlight) : []);
    const select = (id) => setSt({ step, part: st.part === id ? null : id });
    const partOf = (s) => parts.find((p) => namesOf(s).includes(p.id)) || null;

    const nodes = [];
    shapes.forEach((s, i) => {
      const names = namesOf(s);
      const staged = names.filter((id) => id in firstShown);
      const hidden = staged.length > 0 && !staged.some((id) => firstShown[id] <= step);
      const emph = !hidden && focus.size > 0 && names.some((id) => focus.has(id));
      const dim = !hidden && focus.size > 0 && !emph;
      const p = hidden ? null : partOf(s);
      nodes.push(...drawShape(s, i, {
        hidden, emph, opacity: hidden ? 0 : dim ? 0.22 : 1, textScale,
        onClick: p ? () => select(p.id) : null,
      }).filter(Boolean));
    });

    const title = str(props.title);
    const cur = n ? steps[step] : null;
    const go = (i) => setSt({ step: Math.max(0, Math.min(n - 1, i)), part: null });
    const ariaLabel = `${title || 'Diagram'}${parts.length ? `. Parts: ${parts.map((p) => p.label).join(', ')}` : ''}`;

    return h('col', { __component: 'Diagram', border: { size: 1, color: 'default' }, radius: '2xl', padding: 4, gap: 3, background: 'surface', clip: true },
      title ? h('row', { gap: 2, align: 'center' },
        h('icon', { name: 'image', size: 'md', color: 'brand-strong' }),
        h('text', { size: 'sm', weight: 'semibold', color: 'secondary', flex: 1 }, title)) : null,
      h('box', { radius: 'lg', background: 'surface-secondary', clip: true, padding: 2 },
        h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', ariaLabel, __component: 'DiagramCanvas' }, ...nodes)),
      parts.length ? h('col', { gap: 2 },
        h('text', { size: 'xs', color: 'tertiary' }, part ? 'Tap the part again to close' : 'Tap a part of the diagram, or a label below'),
        h('row', { gap: 2, wrap: true }, ...parts.map((p) => h('button', {
          key: `p${p.id}`, size: 'sm', variant: part && part.id === p.id ? 'solid' : 'secondary', ariaPressed: !!(part && part.id === p.id), onClick: () => select(p.id),
        }, p.label)))) : null,
      part ? h('col', { __component: 'DiagramPart', gap: 1, padding: 3, radius: 'xl', background: 'brand-subtle' },
        h('text', { size: 'sm', weight: 'semibold' }, str(part.label)),
        md(part.text, { size: 'sm' })) : null,
      cur ? h('col', { __component: 'DiagramStep', gap: 2 },
        h('row', { gap: 2, align: 'center' },
          h('badge', { color: 'info' }, `Step ${step + 1} of ${n}`),
          cur.label ? h('text', { size: 'sm', weight: 'semibold', flex: 1 }, str(cur.label)) : null),
        cur.text ? md(cur.text, { size: 'sm', color: 'secondary' }) : null,
        h('row', { gap: 2, align: 'center', justify: 'between' },
          h('button', { size: 'sm', variant: 'secondary', disabled: step === 0, ariaLabel: 'Previous step', onClick: () => go(step - 1) }, 'Back'),
          h('row', { gap: 1, align: 'center' }, ...steps.map((_, i) => h('pressable', {
            key: `d${i}`, size: i === step ? 10 : 8, radius: 'full', variant: i <= step ? 'track-on' : 'track', ariaPressed: i === step, ariaLabel: `Go to step ${i + 1}`, onClick: () => go(i),
          }))),
          step < n - 1
            ? h('button', { size: 'sm', ariaLabel: 'Next step', onClick: () => go(step + 1) }, 'Next')
            : h('button', { size: 'sm', variant: 'ghost', ariaLabel: 'Start over', onClick: () => go(0) }, 'Start over'))) : null,
      props.caption ? md(props.caption, { size: 'sm', color: 'secondary' }) : null);
  }

  // ------------------------------------------------------------------ Figure
  // State comes from the server (server/figures.js) as componentResults[__resolutionId]:
  // pending while the lookup runs, then {found:false} or {found, src, width, height, title,
  // license, licenseUrl?, author, pageUrl?}. Only Wikimedia hosts load (dil-surface.js).
  const useResult = (rid) => DIL.useAppData((ad) => ad?.opGenui?.componentResults?.[rid] || null);
  function Figure(props) {
    const res = useResult(props.__resolutionId);
    const [zoom, setZoom] = DIL.useState(false);
    const [revealed, setRevealed] = useSaved(props, 'revealed', false, (v) => (typeof v === 'boolean' ? v : undefined));
    const s = res && res.status === 'resolved' ? res.state : null;
    if (s && !s.found) return null;
    const caption = str(props.caption);
    if (!s || !s.src) {
      return h('col', { __component: 'Figure', gap: 2, ariaLabel: 'Finding an image', role: 'status' },
        h('box', { __component: 'FigureLoading', aspectRatio: '16/9', width: '100%', radius: 'xl', background: 'surface-secondary', align: 'center', justify: 'center', gap: 2 },
          h('icon', { name: 'image', size: 'lg', color: 'tertiary' }),
          h('text', { size: 'xs', color: 'tertiary' }, 'Finding an image…')),
        caption ? md(caption, { size: 'sm', color: 'secondary' }) : null);
    }
    const ratio = s.width / s.height;
    const shown = zoom ? ratio : Math.max(ratio, 1.25); // tall images are letterboxed until enlarged
    const credit = `${str(s.author)} · ${str(s.license)} · Wikimedia Commons`;
    const question = str(props.question);
    return h('col', { __component: 'Figure', gap: 2 },
      h('pressable', {
        __component: 'FigureImage', variant: 'plain', radius: 'xl', clip: true, width: '100%', background: 'surface-secondary',
        ariaLabel: zoom ? 'Show the image smaller' : 'Enlarge the image', ariaPressed: zoom, tooltip: str(s.title), onClick: () => setZoom(!zoom),
      }, h('image', { src: s.src, alt: str(props.alt) || caption || str(s.title), fit: 'contain', frame: false, width: '100%', aspectRatio: `${Number(shown.toFixed(4))}` })),
      caption ? md(caption, { size: 'sm', color: 'secondary' }) : null,
      question ? h('col', { __component: 'FigureQuestion', gap: 2, padding: 3, radius: 'xl', background: 'surface-secondary' },
        h('row', { gap: 2, align: 'center' },
          h('icon', { name: 'search', size: 'sm', color: 'brand-strong' }),
          h('text', { size: 'xs', weight: 'bold', color: 'brand-strong' }, 'LOOK CLOSER')),
        md(question, { size: 'sm', weight: 'medium' }),
        revealed
          ? md(props.answer, { size: 'sm', color: 'secondary' })
          : h('row', null, h('button', { size: 'sm', variant: 'secondary', onClick: () => setRevealed(true) }, 'Show answer'))) : null,
      h('row', { gap: 2, align: 'center', wrap: true },
        h('text', { size: 'xs', color: 'tertiary', flex: '1 1 auto', minWidth: 0, __component: 'FigureCredit' }, `Image: ${credit}`),
        s.pageUrl ? h('button', { size: 'sm', variant: 'ghost', ariaLabel: `Open the image page for ${str(s.title)} on Wikimedia Commons`, onClick: () => GenUI.openUrl(s.pageUrl) }, 'Source') : null));
  }

  return { Diagram, Figure };
}

/** Prelude appended after EXTRAS_PRELUDE (it reuses __wonderUseSaved and __wonderMd from LEARNING_PRELUDE). */
export const MEDIA_PRELUDE = `const {${MEDIA_COMPONENT_NAMES.join(',')}}=(${catalogMedia.toString()})(__dil,DIL,GenUI,typeof __wonderUseSaved==='function'?__wonderUseSaved:null,typeof __wonderMd==='function'?__wonderMd:null);\n`;
