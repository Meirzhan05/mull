// Main-thread DIL host: applies render ops to the DOM (findings §3.2/§3.3/§5).
//
// - Each DIL element becomes a DOM node carrying data-d-component="<dil name>" (the name is
//   written verbatim, while the renderer behind it follows the alias table: box/col/grid-item
//   -> row renderer, text/caption/bold/... -> title renderer, spacer -> divider, ...).
// - data-d-direction / data-d-inline / data-d-marker / data-d-frame / data-d-auto-spacing
//   follow the attribute names seen in the captured DOM.
// - Props are mapped through design tokens (spacing scale, radii, colors, type scale).
// - Newly appended text is wrapped per word in <span data-d-streaming-word> with a staggered fade.
// - Op batches are coalesced to one DOM pass per animation frame.

import { decodeOps } from './runtime.js';
import { ICONS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// rendererAliases (findings §3.3)
export const RENDERER_ALIASES = {
  'animate-group': 'animate', transition: 'animate', 'carousel-media-item': 'carousel-item', 'loading-indicator': 'icon',
  text: 'title', caption: 'title', label: 'title', bold: 'title', italic: 'title', underline: 'title', strikethrough: 'title',
  code: 'title', 'shimmer-text': 'title', col: 'row', box: 'row', 'grid-item': 'row', flow: 'grid', spacer: 'divider',
};
export const rendererFor = (type) => RENDERER_ALIASES[type] || type;

const TEXTISH = new Set(['text', 'title', 'caption', 'label', 'bold', 'italic', 'underline', 'strikethrough', 'code', 'shimmer-text', 'badge', 'link', 'blockquote', 'math']);
const MARKDOWNISH = new Set(['text-only-markdown', 'markdown']);
const SVG_CHILDREN = new Set(['path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'ellipse', 'g']);
const FLEX_TYPES = new Set(['box', 'row', 'col', 'grid-item', 'card', 'flow-item', 'carousel-item', 'carousel-media-item', 'pressable', 'animate', 'animate-item', 'animate-group', 'transition', 'form', 'popover', 'popover-content', 'tooltip', 'loading-block']);

// ---------------------------------------------------------------- tokens
const RADII = { none: '0', xs: '0.125rem', sm: '0.25rem', md: '0.5rem', lg: '0.625rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', full: '9999px' };
const TEXT_SIZES = { xs: ['0.75rem', '1rem'], sm: ['0.875rem', '1.25rem'], md: ['1rem', '1.5rem'], lg: ['1.125rem', '1.625rem'], xl: ['1.25rem', '1.75rem'], '2xl': ['1.5rem', '2rem'], '3xl': ['1.875rem', '2.25rem'] };
const TITLE_SIZES = { xs: ['0.875rem', '1.25rem'], sm: ['1rem', '1.5rem'], md: ['1.125rem', '1.625rem'], lg: ['1.25rem', '1.75rem'], xl: ['1.5rem', '2rem'], '2xl': ['1.875rem', '2.25rem'], '3xl': ['2.25rem', '2.5rem'] };
const ICON_SIZES = { xs: 12, sm: 16, md: 18, lg: 20, xl: 24, '2xl': 32 };
const WEIGHTS = { light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, bold: 700 };
const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly', stretch: 'stretch' };
const PALETTE = {
  'green-400': '#34c38f', 'green-500': '#10a37f', 'green-600': '#0e8c6d', 'red-400': '#f2555a', 'red-500': '#e02e2a', 'red-600': '#c32323',
  'blue-400': '#4f9cf9', 'blue-500': '#2f7bf5', 'blue-600': '#1d63d6', 'orange-400': '#ff9a4d', 'orange-500': '#f97316', 'yellow-400': '#f5c542',
  'yellow-500': '#e9a23b', 'purple-400': '#a78bfa', 'purple-500': '#8b5cf6', 'gray-100': '#f4f4f4', 'gray-200': '#e8e8e8', 'gray-300': '#d4d4d4',
  'gray-400': '#a3a3a3', 'gray-500': '#737373', 'gray-600': '#525252',
};
const COLOR_TOKENS = {
  text: { default: 'var(--d-text-primary)', primary: 'var(--d-text-primary)', secondary: 'var(--d-text-secondary)', tertiary: 'var(--d-text-tertiary)', subtle: 'var(--d-text-tertiary)', inverse: 'var(--d-text-inverse)' },
  bg: { default: 'var(--d-surface)', surface: 'var(--d-surface)', 'surface-primary': 'var(--d-surface)', 'surface-secondary': 'var(--d-surface-secondary)', 'surface-tertiary': 'var(--d-surface-tertiary)', subtle: 'var(--d-surface-secondary)', primary: 'var(--d-text-primary)', secondary: 'var(--d-surface-secondary)' },
  border: { default: 'var(--d-border-default)', subtle: 'var(--d-border-subtle)', strong: 'var(--d-border-strong)', heavy: 'var(--d-border-strong)', primary: 'var(--d-text-primary)', secondary: 'var(--d-border-default)', tertiary: 'var(--d-border-subtle)' },
  any: {
    danger: 'var(--d-danger)', error: 'var(--d-danger)', success: 'var(--d-success)', positive: 'var(--d-success)', warning: 'var(--d-warning)',
    info: 'var(--d-accent)', accent: 'var(--d-accent)', link: 'var(--d-accent)', white: '#fff', black: '#0d0d0d', transparent: 'transparent',
    'danger-subtle': 'var(--d-danger-subtle)', 'success-subtle': 'var(--d-success-subtle)', 'warning-subtle': 'var(--d-warning-subtle)',
    primary: 'var(--d-text-primary)', secondary: 'var(--d-text-secondary)', tertiary: 'var(--d-text-tertiary)', red: 'var(--d-danger)', green: 'var(--d-success)',
  },
};

export function resolveColor(v, ctx = 'text') {
  if (v == null || v === false) return null;
  const s = String(v);
  if (/^(#|rgb|hsl|var\(|oklch|color\()/i.test(s) || s === 'currentColor' || s === 'none' || s === 'inherit') return s;
  const m = /^alpha-(\d+)$/.exec(s);
  if (m) return `var(--d-alpha-${m[1]}, rgba(13,13,13,${Number(m[1]) / 100}))`;
  return COLOR_TOKENS[ctx]?.[s] ?? COLOR_TOKENS.any[s] ?? PALETTE[s] ?? `var(--d-color-${s.replace(/[^\w-]/g, '')}, currentColor)`;
}

export const space = (v) => (typeof v === 'number' ? (v === 0 ? '0px' : `calc(var(--d-spacing) * ${v})`) : String(v));
export const dim = (v) => (typeof v === 'number' ? `${v}px` : String(v));

function boxSides(style, prefix, v) {
  if (v == null || v === false) return;
  if (typeof v !== 'object') { style[prefix] = space(v); return; }
  const set = (side, val) => { if (val != null) style[prefix + side] = space(val); };
  set('Top', v.top ?? v.y ?? v.vertical);
  set('Bottom', v.bottom ?? v.y ?? v.vertical);
  set('Left', v.left ?? v.start ?? v.x ?? v.horizontal);
  set('Right', v.right ?? v.end ?? v.x ?? v.horizontal);
}

function borderStyle(style, v) {
  if (v == null) return;
  if (v === false || v === 'none') { style.border = 'none'; return; }
  if (v === true) { style.border = '1px solid var(--d-border-default)'; return; }
  if (typeof v === 'number') { style.border = `${v}px solid var(--d-border-default)`; return; }
  if (typeof v === 'string') { style.border = `1px solid ${resolveColor(v, 'border')}`; return; }
  const size = v.size ?? v.width ?? 1;
  const color = resolveColor(v.color ?? 'default', 'border');
  const sides = v.side ? [v.side] : null;
  if (sides) for (const s of sides) style[`border${s[0].toUpperCase()}${s.slice(1)}`] = `${size}px solid ${color}`;
  else style.border = `${size}px solid ${color}`;
}

/** Compute inline style + attributes for a DIL element (pure function; exported for tests/debugging). */
export function computePresentation(type, props, ctx = {}) {
  const style = {};
  const attrs = {};
  const p = props || {};
  const r = rendererFor(type);

  // ---- layout containers
  if (FLEX_TYPES.has(type) || r === 'row') {
    const dir = p.direction ?? (type === 'row' ? 'row' : 'col');
    style.display = p.inline ? 'inline-flex' : 'flex';
    style.flexDirection = dir === 'row' ? 'row' : 'column';
    attrs['data-d-direction'] = dir === 'row' ? 'row' : 'col';
    if (p.wrap) style.flexWrap = 'wrap';
    if (p.align) style.alignItems = ALIGN[p.align] || p.align;
    else if (dir === 'row') style.alignItems = 'center';
    if (p.justify) style.justifyContent = JUSTIFY[p.justify] || p.justify;
    if (p.gap == null && type !== 'pressable') attrs['data-d-auto-spacing'] = '';
  }
  if (type === 'grid' || type === 'flow') {
    style.display = 'grid';
    const c = p.columns;
    style.gridTemplateColumns = typeof c === 'number' ? `repeat(${c}, minmax(0, 1fr))` : Array.isArray(c) ? c.map((x) => (typeof x === 'number' ? `${x}fr` : x)).join(' ') : c || 'repeat(auto-fill, minmax(140px, 1fr))';
    if (p.align) style.alignItems = ALIGN[p.align] || p.align;
  }
  if (p.gap != null) style.gap = space(p.gap);
  if (p.rowGap != null) style.rowGap = space(p.rowGap);
  if (p.columnGap != null) style.columnGap = space(p.columnGap);
  boxSides(style, 'padding', p.padding);
  boxSides(style, 'margin', p.margin);
  if (p.size != null && type !== 'icon' && !TEXTISH.has(type) && type !== 'button') { style.width = dim(p.size); style.height = dim(p.size); style.flex = '0 0 auto'; }
  for (const k of ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight']) if (p[k] != null && type !== 'svg' && !SVG_CHILDREN.has(type)) style[k] = dim(p[k]);
  if (p.flex != null) style.flex = typeof p.flex === 'number' ? `${p.flex} 1 0%` : /^\d+$/.test(p.flex) ? `${p.flex} 1 0%` : p.flex;
  if (p.aspectRatio) style.aspectRatio = String(p.aspectRatio).replace(':', ' / ');
  if (p.background != null && type !== 'pressable') style.background = resolveColor(p.background, 'bg');
  if (type !== 'divider' && type !== 'image') borderStyle(style, p.border);
  if (p.radius != null) style.borderRadius = RADII[p.radius] ?? dim(p.radius);
  if (p.clip) style.overflow = 'hidden';
  if (p.scrollable) style.overflow = 'auto';
  if (p.opacity != null) style.opacity = String(p.opacity);
  if (p.role) attrs.role = p.role;
  if (p.ariaLabel) attrs['aria-label'] = p.ariaLabel;
  if (p.ariaHidden) attrs['aria-hidden'] = 'true';
  if (p.ariaLive) attrs['aria-live'] = p.ariaLive;
  if (p.ariaPressed != null) attrs['aria-pressed'] = String(!!p.ariaPressed);
  if (p.tooltip) attrs.title = String(p.tooltip);
  if (p.__component) attrs['data-dil-catalog'] = p.__component;

  // ---- text
  if (TEXTISH.has(type)) {
    const isTitle = type === 'title';
    const scale = isTitle ? TITLE_SIZES : TEXT_SIZES;
    const sz = p.size ?? (isTitle ? 'md' : null);
    if (sz && scale[sz]) { style.fontSize = scale[sz][0]; style.lineHeight = scale[sz][1]; }
    else if (typeof sz === 'number') style.fontSize = `${sz}px`;
    if (p.fontSize) style.fontSize = dim(p.fontSize);
    if (p.lineHeight) style.lineHeight = typeof p.lineHeight === 'number' && p.lineHeight < 4 ? String(p.lineHeight) : dim(p.lineHeight);
    if (p.weight) style.fontWeight = String(WEIGHTS[p.weight] ?? p.weight);
    else if (isTitle) style.fontWeight = '600';
    if (p.strong || type === 'bold') style.fontWeight = style.fontWeight && type !== 'bold' ? style.fontWeight : '600';
    if (p.color && type !== 'badge') style.color = resolveColor(p.color, 'text');
    if (p.underline) style.textDecoration = 'underline';
    if (p.lineThrough) style.textDecoration = 'line-through';
    if (p.italic) style.fontStyle = 'italic';
    if (p.textAlign) style.textAlign = p.textAlign;
    if (p.tabularNums) style.fontVariantNumeric = 'tabular-nums';
    if (p.preserveWhitespace) style.whiteSpace = 'pre-wrap';
    if (p.maxLines) { style.display = '-webkit-box'; style.webkitLineClamp = String(p.maxLines); style.webkitBoxOrient = 'vertical'; style.overflow = 'hidden'; }
    if (p.truncate) { style.overflow = 'hidden'; style.textOverflow = 'ellipsis'; style.whiteSpace = 'nowrap'; }
  }
  if (MARKDOWNISH.has(type)) {
    if (p.size && TEXT_SIZES[p.size]) { style.fontSize = TEXT_SIZES[p.size][0]; style.lineHeight = TEXT_SIZES[p.size][1]; }
    if (p.weight) style.fontWeight = String(WEIGHTS[p.weight] ?? p.weight);
    if (p.color) style.color = resolveColor(p.color, 'text');
  }

  // ---- specific primitives
  switch (type) {
    case 'badge': {
      const c = p.color || 'default';
      const map = { danger: ['var(--d-danger-subtle)', 'var(--d-danger)'], success: ['var(--d-success-subtle)', 'var(--d-success)'], warning: ['var(--d-warning-subtle)', 'var(--d-warning)'], info: ['var(--d-accent-subtle)', 'var(--d-accent)'] };
      const [bg, fg] = map[c] || ['var(--d-surface-tertiary)', c === 'subtle' || c === 'secondary' ? 'var(--d-text-secondary)' : 'var(--d-text-primary)'];
      style.background = p.background ? resolveColor(p.background, 'bg') : bg;
      style.color = fg;
      attrs['data-color'] = c;
      break;
    }
    case 'divider': {
      const c = resolveColor(p.color ?? 'default', 'border');
      style.background = c;
      if (ctx.parentDirection === 'row') { style.width = '1px'; style.alignSelf = 'stretch'; }
      else style.height = '1px';
      if (p.spacing != null) style.margin = ctx.parentDirection === 'row' ? `0 ${space(p.spacing)}` : `${space(p.spacing)} 0`;
      if (p.flush) attrs['data-d-flush'] = '';
      attrs['aria-hidden'] = 'true';
      break;
    }
    case 'spacer':
      style.flex = p.size != null ? `0 0 ${dim(p.size)}` : '1 1 auto';
      style.minWidth = 'auto';
      attrs['aria-hidden'] = 'true';
      break;
    case 'pressable': {
      if (p.inline) attrs['data-d-inline'] = '';
      attrs['data-variant'] = p.variant || 'plain';
      if (p.hoverBackground) attrs.style_hover = resolveColor(p.hoverBackground, 'bg');
      if (p.background) style.background = resolveColor(p.background, 'bg');
      if (p.disabled) { attrs.disabled = ''; attrs['aria-disabled'] = 'true'; if (p.dimWhenDisabled) style.opacity = '0.45'; }
      break;
    }
    case 'button':
      attrs['data-variant'] = p.variant || 'solid';
      attrs['data-size'] = p.size || 'md';
      if (p.pill !== false) attrs['data-pill'] = '';
      if (p.block) style.width = '100%';
      if (p.color) attrs['data-color'] = p.color;
      if (p.disabled) { attrs.disabled = ''; attrs['aria-disabled'] = 'true'; }
      break;
    case 'list':
      attrs['data-d-marker'] = p.marker === 'number' ? 'number' : 'bullet';
      attrs['data-d-marker-layout'] = 'native';
      attrs.role = 'list';
      break;
    case 'list-item':
      attrs['data-d-marker-layout'] = 'native';
      break;
    case 'image':
    case 'search-image':
      if (p.frame !== false) attrs['data-d-frame'] = '';
      if (p.radius == null && p.frame !== false) style.borderRadius = RADII.xl;
      break;
    case 'carousel':
      style.display = 'flex';
      style.overflowX = 'auto';
      style.gap = space(p.gap ?? 3);
      if (p.snap !== false) { attrs['data-d-snap'] = ''; style.scrollSnapType = 'x mandatory'; }
      break;
    case 'carousel-item':
      style.flex = p.width ? `0 0 ${dim(p.width)}` : '0 0 80%';
      style.scrollSnapAlign = 'start';
      break;
    case 'card':
      if (p.border == null) style.border = '1px solid var(--d-border-default)';
      if (p.radius == null) style.borderRadius = RADII['2xl'];
      if (p.padding == null) style.padding = space(4);
      break;
    case 'math':
      if (p.display) attrs['data-display'] = '';
      break;
    case 'loading-block':
      if (p.label) attrs['aria-label'] = p.label;
      attrs.role = 'status';
      if (p.height == null && p.aspectRatio == null) style.height = '48px';
      break;
    case 'link':
      style.color = p.color ? resolveColor(p.color) : 'var(--d-accent)';
      break;
    default:
  }
  if (p.inline && TEXTISH.has(type)) attrs['data-d-inline'] = '';
  if (ctx.inlineText) attrs['data-d-inline'] = '';
  return { style, attrs };
}

function tagFor(type, props, parentType) {
  const inText = TEXTISH.has(parentType) || MARKDOWNISH.has(parentType) || props?.inline;
  switch (type) {
    case 'title': {
      if (inText) return 'span';
      const s = props?.size;
      return s === '3xl' || s === '2xl' || s === 'xl' ? 'h1' : s === 'lg' ? 'h2' : s === 'md' || s == null ? 'h3' : 'h4';
    }
    case 'text': return inText ? 'span' : 'p';
    case 'caption': case 'label': case 'shimmer-text': case 'badge': case 'math': return props?.display ? 'div' : 'span';
    case 'bold': return 'strong';
    case 'italic': return 'em';
    case 'underline': return 'u';
    case 'strikethrough': return 's';
    case 'code': return 'code';
    case 'list': return props?.marker === 'number' ? 'ol' : 'ul';
    case 'list-item': return 'li';
    case 'pressable': return 'button';
    case 'button': return 'button';
    case 'link': return 'a';
    case 'blockquote': return 'blockquote';
    case 'table': return 'table';
    case 'table-section': return 'tbody';
    case 'table-row': return 'tr';
    case 'table-cell': return 'td';
    case 'icon': case 'loading-indicator': case 'svg': return 'svg';
    default:
      if (SVG_CHILDREN.has(type)) return type;
      return 'div';
  }
}

const SVG_ATTR = {
  strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap', strokeLinejoin: 'stroke-linejoin', strokeDasharray: 'stroke-dasharray',
  strokeOpacity: 'stroke-opacity', fillOpacity: 'fill-opacity', vectorEffect: 'vector-effect', fillRule: 'fill-rule', clipRule: 'clip-rule',
  textAnchor: 'text-anchor', preserveAspectRatio: 'preserveAspectRatio', viewBox: 'viewBox',
};
const SVG_PASS = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'transform', 'opacity']);

// ---------------------------------------------------------------- host

/**
 * @param {HTMLElement} mount
 * @param {{invoke:(fnId:number,args:any[])=>void, onAction?:(a:object)=>void, allowRemoteImages?:boolean, raf?:(cb:Function)=>void}} opts
 */
export function createHost(mount, opts) {
  const doc = mount.ownerDocument;
  const raf = opts.raf || ((cb) => requestAnimationFrame(cb));
  let allowRemoteImages = !!opts.allowRemoteImages;
  const recs = new Map();
  const root = { id: 0, type: '#root', props: {}, el: mount, childHost: mount, kids: [], parent: null };
  recs.set(0, root);
  mount.classList.add('dil-root');
  mount.setAttribute('data-dil-root', '');
  let queue = [];
  let frameRequested = false;
  let frameToken = 0;
  let wordCounter = 0;
  const stats = { batches: 0, frames: 0, ops: 0 };

  const isRemote = (src) => /^https?:/i.test(src) && !src.startsWith(doc.location?.origin || '\u0000');

  function ensureEl(rec) {
    if (rec.el) return rec.el;
    materialize(rec);
    return rec.el;
  }

  function desiredTag(rec) {
    if (rec.type === '#text') return 'span';
    const parentType = rec.parent ? recs.get(rec.parent)?.type : null;
    return tagFor(rec.type, rec.props, parentType);
  }

  function materialize(rec) {
    const tag = desiredTag(rec);
    const isSvg = tag === 'svg' || SVG_CHILDREN.has(rec.type);
    const el = isSvg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    if (rec.type === '#text') {
      el.setAttribute('data-d-text', '');
    } else {
      el.setAttribute('data-d-component', rec.type);
      if (tag === 'button') el.type = 'button';
    }
    const old = rec.el;
    rec.el = el;
    rec.tag = tag;
    rec.childHost = el;
    if (old) {
      // move children over and swap in place
      const kidsHost = old;
      while (kidsHost.firstChild) el.appendChild(kidsHost.firstChild);
      old.replaceWith(el);
    }
    if (rec.type !== '#text') applyProps(rec);
  }

  function checkTag(rec) {
    if (rec.el && desiredTag(rec) !== rec.tag) materialize(rec);
  }

  function parentDirection(rec) {
    const p = rec.parent != null ? recs.get(rec.parent) : null;
    if (!p || !p.props) return null;
    if (p.type === 'row') return p.props.direction ?? 'row';
    return p.props.direction ?? (FLEX_TYPES.has(p.type) ? 'col' : null);
  }

  function applyProps(rec) {
    const el = rec.el;
    if (!el) return;
    const p = rec.props;
    const type = rec.type;
    const isSvgEl = el.namespaceURI === SVG_NS;
    if (type === 'svg' || SVG_CHILDREN.has(type)) return applySvgProps(rec);
    if (type === 'icon' || type === 'loading-indicator') return applyIconProps(rec);
    const { style, attrs } = computePresentation(type, p, { parentDirection: parentDirection(rec) });
    // reset previous attributes
    for (const k of rec.attrKeys || []) if (!(k in attrs)) el.removeAttribute(k);
    rec.attrKeys = Object.keys(attrs).filter((k) => k !== 'style_hover');
    for (const k of rec.attrKeys) el.setAttribute(k, attrs[k]);
    el.style.cssText = '';
    for (const [k, v] of Object.entries(style)) if (v != null && typeof v !== 'function') el.style[k] = v;
    if (attrs.style_hover) el.style.setProperty('--d-hover-bg', attrs.style_hover);
    if (!isSvgEl) bindEvents(rec);
    if (type === 'link') el.setAttribute('href', p.href || '#');
    if (type === 'image' || type === 'search-image') renderImage(rec);
    if (type === 'button') renderButtonLabel(rec);
    if (type === 'celebration') maybeCelebrate(rec);
  }

  function bindEvents(rec) {
    const el = rec.el;
    const p = rec.props;
    const fn = p.onClick && p.onClick.__fn;
    if (fn || rec.type === 'link') {
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (p.disabled) return;
        if (fn) opts.invoke(fn, []);
        else if (rec.type === 'link' && p.href) opts.onAction?.({ handler: 'client', type: 'open_url', payload: { url: p.href } });
      };
    } else {
      el.onclick = null;
    }
    const hover = p.onHover && p.onHover.__fn;
    el.onpointerenter = hover ? () => opts.invoke(hover, [true]) : null;
    el.onpointerleave = hover ? () => opts.invoke(hover, [false]) : null;
    const change = p.onChange && p.onChange.__fn;
    el.oninput = change ? (e) => opts.invoke(change, [e.target.value]) : null;
  }

  function renderButtonLabel(rec) {
    const el = rec.el;
    let lab = el.querySelector(':scope > [data-d-button-label]');
    const text = rec.props.label;
    if (text == null) { if (lab) lab.remove(); return; }
    if (!lab) { lab = doc.createElement('span'); lab.setAttribute('data-d-button-label', ''); el.prepend(lab); }
    lab.textContent = String(text);
  }

  function renderImage(rec) {
    const el = rec.el;
    const p = rec.props;
    el.textContent = '';
    const src = p.src || '';
    if (!src) return;
    if (isRemote(src) && !allowRemoteImages) {
      el.setAttribute('data-d-image-fallback', '');
      const ph = doc.createElement('div');
      ph.className = 'd-image-placeholder';
      ph.title = `${p.alt || 'Remote image'}\n${src}`;
      const icon = doc.createElementNS(SVG_NS, 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      for (const d of ICONS.image) { const path = doc.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); icon.appendChild(path); }
      ph.appendChild(icon);
      const cap = doc.createElement('span');
      cap.textContent = p.alt ? p.alt : 'Remote image';
      ph.appendChild(cap);
      el.appendChild(ph);
      return;
    }
    el.removeAttribute('data-d-image-fallback');
    const img = doc.createElement('img');
    img.alt = p.alt || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.style.objectFit = p.fit || 'cover';
    if (p.crop) img.style.objectPosition = `${(p.crop.x * 100).toFixed(1)}% ${(p.crop.y * 100).toFixed(1)}%`;
    el.setAttribute('data-d-image-loading', '');
    img.onload = () => el.removeAttribute('data-d-image-loading');
    img.onerror = () => { el.removeAttribute('data-d-image-loading'); el.setAttribute('data-d-image-fallback', ''); if (p.hideOnFailure) el.style.display = 'none'; };
    img.src = src;
    el.appendChild(img);
  }

  function applyIconProps(rec) {
    const el = rec.el;
    const p = rec.props;
    const spinner = rec.type === 'loading-indicator';
    const name = spinner ? 'loader' : p.name;
    if (rec.iconName !== name) {
      while (el.firstChild) el.firstChild.remove();
      const paths = ICONS[name] || ICONS.circle;
      for (const d of paths) { const path = doc.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); el.appendChild(path); }
      rec.iconName = name;
    }
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('data-icon-name', String(name));
    el.setAttribute('aria-hidden', p.ariaLabel ? 'false' : 'true');
    if (p.ariaLabel) el.setAttribute('aria-label', p.ariaLabel);
    el.setAttribute('focusable', 'false');
    const size = typeof p.size === 'number' ? p.size : ICON_SIZES[p.size] ?? 18;
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    el.style.cssText = '';
    el.style.color = resolveColor(p.color, 'text') || 'currentColor';
    if (p.weight === 'bold') el.style.strokeWidth = '2.4';
    if (spinner) el.classList.add('d-spin');
  }

  function applySvgProps(rec) {
    const el = rec.el;
    const p = rec.props;
    for (const k of rec.attrKeys || []) el.removeAttribute(k);
    const keys = [];
    const set = (k, v) => { el.setAttribute(k, String(v)); keys.push(k); };
    el.style.cssText = '';
    if (rec.type === 'svg') {
      set('viewBox', p.viewBox || '0 0 100 100');
      if (p.preserveAspectRatio) set('preserveAspectRatio', p.preserveAspectRatio);
      el.style.width = p.width != null ? dim(p.width) : '100%';
      if (p.height != null) el.style.height = dim(p.height);
      el.style.display = 'block';
      el.style.overflow = 'visible';
      if (p.role) set('role', p.role);
      if (p.ariaLabel) set('aria-label', p.ariaLabel);
    }
    for (const [k, v] of Object.entries(p)) {
      if (v == null || typeof v === 'object') continue;
      if (k === 'fill' || k === 'stroke') { el.style[k] = resolveColor(v, 'text'); continue; }
      if (SVG_ATTR[k] && rec.type !== 'svg') set(SVG_ATTR[k], v);
      else if (SVG_PASS.has(k)) set(k, v);
    }
    rec.attrKeys = keys;
  }

  function maybeCelebrate(rec) {
    const on = !!rec.props.trigger;
    if (on && !rec.celebrated) {
      rec.celebrated = true;
      const el = rec.el;
      const colors = ['#10a37f', '#f5c542', '#2f7bf5', '#f2555a', '#a78bfa', '#ff9a4d'];
      for (let i = 0; i < 36; i++) {
        const s = doc.createElement('i');
        s.className = 'd-confetti';
        s.style.setProperty('--x', `${(Math.random() * 2 - 1) * 180}px`);
        s.style.setProperty('--y', `${-60 - Math.random() * 120}px`);
        s.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
        s.style.left = `${10 + Math.random() * 80}%`;
        s.style.background = colors[i % colors.length];
        s.style.animationDelay = `${Math.random() * 120}ms`;
        el.appendChild(s);
      }
      setTimeout(() => { for (const c of [...el.querySelectorAll('.d-confetti')]) c.remove(); }, 1800);
    }
    if (!on) rec.celebrated = false;
  }

  // ---- text
  function renderText(rec, prevText, animated) {
    const el = ensureEl(rec);
    const parent = rec.parent != null ? recs.get(rec.parent) : null;
    const text = rec.text;
    if (parent && MARKDOWNISH.has(parent.type)) {
      el.textContent = '';
      renderMiniMarkdown(el, text, parent.type === 'markdown');
      return;
    }
    if (animated && prevText != null && text.startsWith(prevText) && rec.renderedText === prevText) {
      appendWords(el, text.slice(prevText.length));
    } else if (animated) {
      el.textContent = '';
      appendWords(el, text);
    } else {
      el.textContent = text;
    }
    rec.renderedText = text;
  }

  function appendWords(el, chunk) {
    if (!chunk) return;
    for (const tok of chunk.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) { el.appendChild(doc.createTextNode(tok)); continue; }
      const s = doc.createElement('span');
      s.setAttribute('data-d-streaming-word', '');
      s.style.setProperty('--stream-word-delay', `${Math.min(wordCounter++, 24) * 18}ms`);
      s.textContent = tok;
      el.appendChild(s);
    }
  }

  // Minimal TextOnly markdown (bold/italic/code/links, paragraphs, fenced code). Builds DOM
  // nodes only (no innerHTML), so model text can never inject markup.
  function renderMiniMarkdown(el, src, block) {
    if (block && /^\s*(```|~~~)/.test(src)) {
      const lines = src.replace(/\n?\s*(```|~~~)\s*$/, '').split('\n');
      const lang = lines.shift().replace(/^\s*(```|~~~)/, '').trim();
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      if (lang) code.setAttribute('data-language', lang);
      code.textContent = lines.join('\n');
      pre.appendChild(code);
      el.appendChild(pre);
      return;
    }
    const paras = block ? src.split(/\n{2,}/) : [src];
    paras.forEach((para, pi) => {
      const target = block ? doc.createElement('p') : el;
      inlineMd(target, block ? para : para.replace(/\n/g, ' '));
      if (block) el.appendChild(target);
      else if (pi) el.appendChild(doc.createTextNode(' '));
    });
  }
  function inlineMd(target, s) {
    const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\\\([^)]*\\\)|\$[^$\n]+\$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) target.appendChild(doc.createTextNode(s.slice(last, m.index)));
      const t = m[0];
      let node;
      if (t.startsWith('**') || t.startsWith('__')) { node = doc.createElement('strong'); inlineMd(node, t.slice(2, -2)); }
      else if (t.startsWith('`')) { node = doc.createElement('code'); node.textContent = t.slice(1, -1); }
      else if (t.startsWith('[')) {
        const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
        node = doc.createElement('a');
        node.href = lm[2];
        node.textContent = lm[1];
        node.onclick = (e) => { e.preventDefault(); opts.onAction?.({ handler: 'client', type: 'open_url', payload: { url: lm[2] } }); };
      } else if (t.startsWith('\\(') || (t.startsWith('$') && !/^\$\d/.test(t))) {
        node = doc.createElement('span');
        node.className = 'd-math-inline';
        node.textContent = t.startsWith('$') ? t.slice(1, -1) : t.slice(2, -2);
      } else if (t.startsWith('$')) { node = doc.createTextNode(t); }
      else { node = doc.createElement('em'); inlineMd(node, t.slice(1, -1)); }
      target.appendChild(node);
      last = m.index + t.length;
    }
    if (last < s.length) target.appendChild(doc.createTextNode(s.slice(last)));
  }

  // ---- op application
  function drop(rec) {
    recs.delete(rec.id);
    for (const k of rec.kids || []) { const c = recs.get(k); if (c) drop(c); }
  }

  function applyOp(o, animated, dirty) {
    switch (o.op) {
      case 'createElement':
        recs.set(o.id, { id: o.id, type: o.type, props: {}, el: null, childHost: null, kids: [], parent: null });
        break;
      case 'createText':
        recs.set(o.id, { id: o.id, type: '#text', text: o.text, el: null, kids: [], parent: null, pendingAnimated: animated });
        break;
      case 'destroy': {
        const rec = recs.get(o.id);
        if (!rec) break;
        if (rec.el) rec.el.remove();
        const p = rec.parent != null ? recs.get(rec.parent) : null;
        if (p) { const i = p.kids.indexOf(o.id); if (i >= 0) p.kids.splice(i, 1); }
        drop(rec);
        break;
      }
      case 'move': {
        const rec = recs.get(o.id);
        const parent = recs.get(o.parent);
        if (!rec || !parent) break;
        const prevParent = rec.parent != null ? recs.get(rec.parent) : null;
        if (prevParent) { const i = prevParent.kids.indexOf(o.id); if (i >= 0) prevParent.kids.splice(i, 1); }
        rec.parent = o.parent;
        ensureEl(parent);
        const firstPlacement = !rec.el;
        ensureEl(rec);
        checkTag(rec);
        parent.kids.splice(Math.min(o.index, parent.kids.length), 0, o.id);
        const nextId = parent.kids[o.index + 1];
        const nextEl = nextId != null ? recs.get(nextId)?.el : null;
        parent.childHost.insertBefore(rec.el, nextEl && nextEl.parentNode === parent.childHost ? nextEl : null);
        if (rec.type === '#text' && (firstPlacement || MARKDOWNISH.has(parent.type))) renderText(rec, null, rec.pendingAnimated && firstPlacement);
        if (rec.type !== '#text') dirty.add(rec);
        break;
      }
      case 'propChanged': {
        const rec = recs.get(o.id);
        if (!rec) break;
        if (o.value === undefined) delete rec.props[o.name];
        else rec.props[o.name] = o.value;
        if (rec.el) {
          dirty.add(rec);
          if (o.name === 'size' || o.name === 'marker' || o.name === 'inline' || o.name === 'display') checkTag(rec);
        }
        break;
      }
      case 'textChanged': {
        const rec = recs.get(o.id);
        if (!rec) break;
        const prev = rec.text;
        rec.text = o.text;
        if (rec.el) renderText(rec, prev, animated);
        break;
      }
      default:
    }
  }

  function flush() {
    frameRequested = false;
    stats.frames++;
    const batches = queue;
    queue = [];
    wordCounter = 0;
    const dirty = new Set();
    for (const b of batches) for (const o of b.ops) applyOp(o, b.animated, dirty);
    for (const rec of dirty) if (recs.has(rec.id) && rec.el) applyProps(rec);
    // keep children of dirty parents in sync with direction-dependent styles (dividers)
    for (const rec of dirty) for (const k of rec.kids || []) { const c = recs.get(k); if (c && c.type === 'divider') applyProps(c); }
    opts.onFlush?.(stats);
  }

  return {
    /** Queue an op batch; applied on the next animation frame (rAF coalescing, findings §1.2). */
    apply(message) {
      const ops = message.ops || decodeOps(message.buffer, message.strings);
      stats.batches++;
      stats.ops += ops.length;
      queue.push({ ops, animated: !!message.meta?.animated });
      if (!frameRequested) {
        frameRequested = true;
        // rAF coalescing; the timeout fallback keeps hidden/background tabs (where rAF is
        // paused) from accumulating an unbounded op queue.
        const token = ++frameToken;
        const run = () => { if (token === frameToken && frameRequested) flush(); };
        raf(run);
        setTimeout(run, 200);
      }
      return ops.length;
    },
    flushNow() { if (queue.length) flush(); },
    clear() {
      queue = [];
      for (const k of [...root.kids]) { const r = recs.get(k); if (r?.el) r.el.remove(); if (r) drop(r); }
      root.kids = [];
      mount.textContent = '';
    },
    setAllowRemoteImages(v) {
      allowRemoteImages = !!v;
      for (const rec of recs.values()) if ((rec.type === 'image' || rec.type === 'search-image') && rec.el) renderImage(rec);
    },
    stats,
    nodeCount: () => recs.size - 1,
  };
}
