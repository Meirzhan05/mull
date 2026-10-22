// <Diagram/> prop validation: a model-drawn interactive SVG figure. Claude places simple shapes
// on a fixed canvas; "parts" make groups of shapes tappable with an explanation, and "steps"
// walk through the figure, revealing and highlighting shapes one step at a time. Rendered in
// the sandbox by public/catalog-media.js with DIL svg primitives (plus the svg-text and
// clickable-shape host extensions in chatgpt-dil/src/host.js).
//
//   <Diagram title="" width={400} height={250} caption=""
//     shapes={[{"id":"sun","type":"circle","x":60,"y":60,"r":24,"fill":"yellow","part":"sun"},
//              {"type":"arrow","from":[90,80],"to":[200,150],"stroke":"orange","part":"light"},
//              {"type":"text","x":60,"y":100,"text":"Sun"}]}
//     parts={[{"id":"sun","label":"The Sun","text":"..."}]}
//     steps={[{"label":"...","text":"...","show":["sun"],"highlight":["sun"]}]}/>

export const DIAGRAM_LIMITS = Object.freeze({ shapes: 40, parts: 8, steps: 8, points: 24, pathLength: 800, text: 60 });
export const DIAGRAM_SHAPE_TYPES = Object.freeze(['rect', 'circle', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'path', 'text']);

const TYPE_ALIASES = { box: 'rect', rectangle: 'rect', square: 'rect', dot: 'circle', point: 'circle', oval: 'ellipse', label: 'text', curve: 'path', segment: 'line', triangle: 'polygon' };
// Named colors resolve to theme-aware DIL tokens or mid-tone hexes readable on light and dark.
export const DIAGRAM_COLORS = Object.freeze({
  brand: 'brand-strong', accent: 'brand-strong', blue: '#2f7bf5', sky: '#4fb3f6', teal: '#14a3a3', green: '#22a559', red: '#e0452b', orange: '#f97316',
  yellow: '#f2c230', purple: '#8b5cf6', pink: '#e8579b', brown: '#9a6b43', gray: '#8a8f98', grey: '#8a8f98',
  // ink/text/muted/surface follow the theme; white and black are the literal colors (white blood
  // cells stay white in dark mode)
  ink: 'primary', text: 'primary', muted: 'secondary', subtle: 'tertiary', surface: 'surface', white: '#ffffff', black: '#111111', none: 'none', transparent: 'none',
});
const ID_RE = /^[A-Za-z][\w-]{0,23}$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE\s,.+-]+$/;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const fail = (error) => ({ ok: false, error });
const r1 = (v) => Math.round(v * 10) / 10;

/** A color name or hex -> a DIL color, or '' when unknown (the renderer then uses a default). */
export function diagramColor(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
  return DIAGRAM_COLORS[s] || '';
}

function pointOf(v) {
  const p = Array.isArray(v) ? [num(v[0]), num(v[1])] : isObj(v) ? [num(v.x), num(v.y)] : null;
  return p && p[0] != null && p[1] != null ? p.map(r1) : null;
}

/** Normalize + validate Diagram props. Returns {ok, props} | {ok:false, error}. */
export function validateDiagram(p) {
  const W = num(p.width) ?? 400;
  const H = num(p.height) ?? 250;
  if (W < 100 || W > 1000 || H < 60 || H > 1000) return fail('Diagram width must be 100-1000 and height 60-1000');
  if (W / H > 4 || H / W > 2) return fail('Diagram is too narrow or too tall (keep width:height between 1:2 and 4:1)');
  const inX = (x) => x >= -0.1 * W && x <= 1.1 * W;
  const inY = (y) => y >= -0.1 * H && y <= 1.1 * H;
  const within = (pts) => pts.every(([x, y]) => inX(x) && inY(y));

  const rawShapes = Array.isArray(p.shapes) ? p.shapes : Array.isArray(p.elements) ? p.elements : [];
  if (!rawShapes.length) return fail('Diagram needs shapes');
  if (rawShapes.length > DIAGRAM_LIMITS.shapes) return fail(`Diagram allows at most ${DIAGRAM_LIMITS.shapes} shapes`);

  const shapes = [];
  const ids = new Set();
  for (const [i, s] of rawShapes.entries()) {
    const n = i + 1;
    if (!isObj(s)) return fail(`Shape ${n} is not an object`);
    const rawType = str(s.type ?? s.kind ?? s.shape, 16).toLowerCase();
    const type = TYPE_ALIASES[rawType] || rawType;
    if (!DIAGRAM_SHAPE_TYPES.includes(type)) return fail(`Shape ${n} has unknown type "${rawType}" (use ${DIAGRAM_SHAPE_TYPES.join(', ')})`);
    const out = { type };
    if (type === 'rect') {
      const x = num(s.x); const y = num(s.y); const w = num(s.w ?? s.width); const h = num(s.h ?? s.height);
      if ([x, y, w, h].some((v) => v == null) || w <= 0 || h <= 0) return fail(`Shape ${n} (rect) needs x, y and positive w, h`);
      if (!within([[x, y], [x + w, y + h]])) return fail(`Shape ${n} is outside the ${W}x${H} canvas`);
      Object.assign(out, { x: r1(x), y: r1(y), w: r1(w), h: r1(h) });
      const rr = num(s.r ?? s.radius ?? s.rx);
      if (rr != null && rr > 0) out.r = r1(Math.min(rr, w / 2, h / 2));
    } else if (type === 'circle') {
      const x = num(s.x ?? s.cx); const y = num(s.y ?? s.cy); const r = num(s.r ?? s.radius);
      if ([x, y, r].some((v) => v == null) || r <= 0) return fail(`Shape ${n} (circle) needs x, y and a positive r`);
      if (!within([[x, y]]) || r > Math.max(W, H)) return fail(`Shape ${n} is outside the ${W}x${H} canvas`);
      Object.assign(out, { x: r1(x), y: r1(y), r: r1(r) });
    } else if (type === 'ellipse') {
      const x = num(s.x ?? s.cx); const y = num(s.y ?? s.cy); const rx = num(s.rx); const ry = num(s.ry);
      if ([x, y, rx, ry].some((v) => v == null) || rx <= 0 || ry <= 0) return fail(`Shape ${n} (ellipse) needs x, y and positive rx, ry`);
      if (!within([[x, y]]) || rx > W || ry > H) return fail(`Shape ${n} is outside the ${W}x${H} canvas`);
      Object.assign(out, { x: r1(x), y: r1(y), rx: r1(rx), ry: r1(ry) });
    } else if (type === 'line' || type === 'arrow') {
      const from = pointOf(s.from ?? (s.x1 != null ? [s.x1, s.y1] : null));
      const to = pointOf(s.to ?? (s.x2 != null ? [s.x2, s.y2] : null));
      if (!from || !to) return fail(`Shape ${n} (${type}) needs from [x,y] and to [x,y]`);
      if (from[0] === to[0] && from[1] === to[1]) return fail(`Shape ${n} (${type}) has zero length`);
      if (!within([from, to])) return fail(`Shape ${n} is outside the ${W}x${H} canvas`);
      Object.assign(out, { from, to });
      const curve = num(s.curve ?? s.bend);
      if (curve) out.curve = r1(Math.max(-W, Math.min(W, curve)));
      if (type === 'arrow' && (s.both === true || s.double === true)) out.both = true;
    } else if (type === 'polyline' || type === 'polygon') {
      const raw = Array.isArray(s.points) ? s.points : [];
      const pts = raw.map(pointOf);
      const min = type === 'polygon' ? 3 : 2;
      if (pts.length < min || pts.some((q) => !q)) return fail(`Shape ${n} (${type}) needs ${min}+ points as [x,y]`);
      if (pts.length > DIAGRAM_LIMITS.points) return fail(`Shape ${n} has more than ${DIAGRAM_LIMITS.points} points`);
      if (!within(pts)) return fail(`Shape ${n} is outside the ${W}x${H} canvas`);
      out.points = pts;
    } else if (type === 'path') {
      const d = typeof s.d === 'string' ? s.d.trim() : '';
      if (!d || !/^[Mm]/.test(d) || !PATH_RE.test(d)) return fail(`Shape ${n} (path) needs d with SVG path commands only`);
      if (d.length > DIAGRAM_LIMITS.pathLength) return fail(`Shape ${n} path is too long`);
      const nums = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
      if (nums.some((v) => !Number.isFinite(v) || Math.abs(v) > 4 * Math.max(W, H))) return fail(`Shape ${n} path is outside the canvas`);
      out.d = d.replace(/\s+/g, ' ');
    } else if (type === 'text') {
      const x = num(s.x); const y = num(s.y);
      const t = str(s.text ?? s.label ?? s.content, DIAGRAM_LIMITS.text);
      if (x == null || y == null || !t) return fail(`Shape ${n} (text) needs x, y and text`);
      if (!within([[x, y]])) return fail(`Shape ${n} is outside the ${W}x${H} canvas`);
      Object.assign(out, { x: r1(x), y: r1(y), text: t });
      const size = num(s.size ?? s.fontSize);
      out.size = size == null ? ({ sm: 12, md: 15, lg: 19 }[str(s.size, 4)] ?? 15) : Math.max(9, Math.min(32, Math.round(size)));
      const anchor = str(s.anchor ?? s.align, 8).toLowerCase();
      out.anchor = anchor === 'start' || anchor === 'left' ? 'start' : anchor === 'end' || anchor === 'right' ? 'end' : 'middle';
      if (s.bold === true || /^(bold|semibold|600|700)$/.test(str(s.weight, 10))) out.bold = true;
      if (s.halo === false) out.halo = false;
    }
    // style
    const fill = diagramColor(s.fill ?? (type === 'text' ? s.color : undefined));
    const stroke = diagramColor(s.stroke ?? (type !== 'text' ? s.color : undefined));
    if (fill) out.fill = fill;
    if (stroke) out.stroke = stroke;
    const sw = num(s.strokeWidth ?? s.thickness);
    if (sw != null) out.strokeWidth = Math.max(0.5, Math.min(10, sw));
    const op = num(s.opacity ?? s.fillOpacity);
    if (op != null) out.opacity = Math.max(0.05, Math.min(1, op));
    if (s.dashed === true || s.dash === true) out.dashed = true;
    // identity
    const id = str(s.id, 24);
    if (id) {
      if (!ID_RE.test(id)) return fail(`Shape ${n} id "${id}" must be a short identifier`);
      if (ids.has(id)) return fail(`Duplicate shape id "${id}"`);
      ids.add(id);
      out.id = id;
    }
    const part = str(s.part ?? s.group, 24);
    if (part && ID_RE.test(part)) out.part = part;
    const follows = str(s.follows, 24); // set below for labels inside a shape; kept on re-validation
    if (type === 'text' && follows && ID_RE.test(follows)) out.follows = follows;
    shapes.push(out);
  }

  // A free label drawn inside a shape belongs with it (it appears, dims and taps with that shape):
  // the smallest rect/circle/ellipse with an id or part that contains the label's anchor point.
  // The label takes the shape's part and `follows` its id, so steps that show or highlight the
  // shape by id move the label with it.
  const area = (c) => (c.type === 'rect' ? c.w * c.h : c.type === 'circle' ? Math.PI * c.r * c.r : Math.PI * c.rx * c.ry);
  const contains = (c, x, y) => (c.type === 'rect' ? x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h
    : c.type === 'circle' ? (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r ** 2
      : ((x - c.x) / c.rx) ** 2 + ((y - c.y) / c.ry) ** 2 <= 1);
  const holders = shapes.filter((c) => (c.part || c.id) && (c.type === 'rect' || c.type === 'circle' || c.type === 'ellipse'));
  for (const t of shapes) {
    if (t.type !== 'text' || t.part || t.id || t.follows) continue;
    const box = holders.filter((c) => contains(c, t.x, t.y)).sort((a, b) => area(a) - area(b))[0];
    if (box?.part) t.part = box.part;
    if (box?.id) t.follows = box.id;
  }

  for (const t of shapes) if (t.follows && !ids.has(t.follows)) delete t.follows;

  // a name (shape id or part) -> does any shape answer to it?
  const known = new Set([...ids, ...shapes.map((s) => s.part).filter(Boolean)]);

  const rawParts = Array.isArray(p.parts) ? p.parts : Array.isArray(p.hotspots) ? p.hotspots : [];
  if (rawParts.length > DIAGRAM_LIMITS.parts) return fail(`Diagram allows at most ${DIAGRAM_LIMITS.parts} parts`);
  const parts = [];
  for (const [i, rp] of rawParts.entries()) {
    if (!isObj(rp)) return fail(`Part ${i + 1} is not an object`);
    const id = str(rp.id, 24);
    const label = str(rp.label ?? rp.title ?? rp.name, 40);
    const body = str(rp.text ?? rp.description ?? rp.content, 320);
    if (!id || !label || !body) return fail(`Part ${i + 1} needs id, label and text`);
    if (!known.has(id)) return fail(`Part "${id}" matches no shape (give shapes "id":"${id}" or "part":"${id}")`);
    if (parts.some((q) => q.id === id)) return fail(`Duplicate part "${id}"`);
    parts.push({ id, label, text: body });
  }

  const rawSteps = Array.isArray(p.steps) ? p.steps : [];
  if (rawSteps.length > DIAGRAM_LIMITS.steps) return fail(`Diagram allows at most ${DIAGRAM_LIMITS.steps} steps`);
  if (rawSteps.length === 1) return fail('Diagram steps need at least 2 steps');
  const steps = [];
  const names = (v, k, i) => {
    const list = (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).map((x) => str(x, 24)).filter(Boolean);
    const bad = list.find((x) => !known.has(x));
    if (bad) return { error: `Step ${i + 1} ${k} "${bad}" matches no shape id or part` };
    return { value: [...new Set(list)] };
  };
  for (const [i, rs] of rawSteps.entries()) {
    if (!isObj(rs)) return fail(`Step ${i + 1} is not an object`);
    const label = str(rs.label ?? rs.title, 60);
    const body = str(rs.text ?? rs.description ?? rs.content, 420);
    if (!label && !body) return fail(`Step ${i + 1} needs a label or text`);
    const show = names(rs.show ?? rs.reveal, 'show', i);
    if (show.error) return fail(show.error);
    const hi = names(rs.highlight ?? rs.focus, 'highlight', i);
    if (hi.error) return fail(hi.error);
    const out = {};
    if (label) out.label = label;
    if (body) out.text = body;
    if (show.value.length) out.show = show.value;
    if (hi.value.length) out.highlight = hi.value;
    steps.push(out);
  }

  const props = { width: r1(W), height: r1(H), shapes };
  if (parts.length) props.parts = parts;
  if (steps.length) props.steps = steps;
  for (const k of ['title', 'caption']) { const v = str(p[k], k === 'caption' ? 300 : 80); if (v) props[k] = v; }
  return { ok: true, props };
}

const md = (s) => String(s).replace(/</g, '‹').replace(/\s*\n\s*/g, ' ').trim();

/** Fallback markdown: the title, the parts as a labeled list, the steps in order, the caption. */
export function diagramFallback(p) {
  const o = isObj(p) ? p : {};
  const lines = [];
  if (str(o.title, 80)) lines.push(`**${md(str(o.title, 80))}**`, '');
  const parts = (Array.isArray(o.parts) ? o.parts : []).filter(isObj).slice(0, DIAGRAM_LIMITS.parts);
  for (const q of parts) { const l = str(q.label ?? q.title, 40); const t = str(q.text ?? q.description, 320); if (l || t) lines.push(`- ${l ? `**${md(l)}**` : ''}${l && t ? ': ' : ''}${t ? md(t) : ''}`); }
  const steps = (Array.isArray(o.steps) ? o.steps : []).filter(isObj).slice(0, DIAGRAM_LIMITS.steps);
  if (parts.length && steps.length) lines.push('');
  steps.forEach((s, i) => { const l = str(s.label ?? s.title, 60); const t = str(s.text ?? s.description, 420); if (l || t) lines.push(`${i + 1}. ${l ? `**${md(l)}**` : ''}${l && t ? ': ' : ''}${t ? md(t) : ''}`); });
  if (str(o.caption, 300)) lines.push('', md(str(o.caption, 300)));
  return lines.join('\n').trim();
}
