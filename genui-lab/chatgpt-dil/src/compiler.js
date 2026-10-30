// DIL compiler: model output (markdown + inline DIL markup) -> DIL program.
//
// Reconstructs the server-side step observed in the conversation-source stream
// (findings §3.1): the model writes markdown interleaved with JSX-like DIL tags,
// and the server re-compiles the whole accumulated message on every revision into
//
//   function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}
//
//   DIL.render(__dil.jsx(()=>{const __dilConstants=DIL.useConstants();
//     const __dilModelDataBindings=DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});
//     return __dil.jsx(__dil.Fragment,null, ...);},{"key":"body:0"}));
//
// Observed rules this file reproduces (verified byte-for-byte against
// fixtures/final-dil.json and every streamed revision in fixtures/stream.redacted.ndjson):
//   - markdown headings -> title (#: xl, ##: lg, ...); paragraphs/bare text -> text
//   - **bold** -> bold, *italic* -> italic (children of text)
//   - every text run is hoisted into constants ("0","1",... in document order)
//   - capitalized tags are catalog components: referenced as free globals, wrapped in
//     __dilSafe(()=>(...),null) so a missing component is a ReferenceError -> null,
//     and given a hoisted "__resolutionId" (key into appData.opGenui.componentResults)
//   - Entity.value / Cite.refs are hoisted; other props are inlined as JSON literals
//   - single top-level block -> no Fragment; zero -> null; __dilSafe prelude only
//     when a component is used
//   - partial input: an incomplete trailing tag is dropped, unclosed elements are
//     auto-closed, and auto-closed elements with no compiled children are pruned.

export const PRIMITIVE_TAGS = new Set([
  // dil_octane_utils ElementTypes (findings §3.3)
  'flashcard-flip', 'animate', 'animate-item', 'lottie', 'celebration', 'tooltip', 'chart', 'pie-chart',
  'carousel', 'carousel-item', 'button', 'badge', 'checkbox', 'radio-group', 'radio', 'form', 'list',
  'list-item', 'loading', 'pulse-indicator', 'icon', 'svg', 'image', 'popover', 'popover-trigger',
  'popover-content', 'search-image', 'favicon', 'pressable', 'link', 'date-picker', 'select', 'input',
  'slider', 'segmented-control', 'table', 'table-section', 'table-row', 'table-cell', 'textarea',
  'blockquote', 'math', 'markdown', 'text-only-markdown', 'title', 'row', 'card', 'flow-item',
  'loading-block', 'grid', 'divider', 'youtube',
  // renderer aliases
  'animate-group', 'transition', 'carousel-media-item', 'loading-indicator', 'text', 'caption', 'label',
  'bold', 'italic', 'underline', 'strikethrough', 'code', 'shimmer-text', 'col', 'box', 'grid-item',
  'flow', 'spacer',
  // svg children (reconstruction extension, see README)
  'path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'ellipse', 'g',
]);

// Elements whose content is inline text (markdown inline syntax applies).
const INLINE_CONTENT = new Set([
  'text', 'title', 'caption', 'label', 'bold', 'italic', 'underline', 'strikethrough', 'shimmer-text',
  'badge', 'link', 'button', 'blockquote', 'table-cell',
]);
// Elements whose content is kept verbatim as one string.
const RAW_CONTENT = new Set(['text-only-markdown', 'markdown', 'math', 'code']);
// Tags that never stand alone as a block even when alone on a line.
const INLINE_ONLY = new Set(['bold', 'italic', 'underline', 'strikethrough', 'code', 'link']);

// Component props that the server hoists into constants (observed: Entity.value, Cite.refs).
const HOISTED_PROPS = {
  Entity: new Set(['value']),
  Cite: new Set(['refs']),
  Citation: new Set(['refs']),
  CodeCite: new Set(['refs']),
  FileCite: new Set(['refs']),
};

const HEADING_SIZES = ['xl', 'lg', 'md', 'sm', 'xs', 'xs'];

const SAFE_PRELUDE = 'function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}\n\n';

// ---------------------------------------------------------------------------
// 1. Tokenizer / tree builder

const TAIL = { kind: 'el', name: '#tail', attrs: [], children: [], selfClosing: true, incomplete: false };
const isCap = (name) => /^[A-Z]/.test(name);
const isTagName = (name) => isCap(name) || PRIMITIVE_TAGS.has(name);

/**
 * Scan an opening/closing tag at src[i] === '<'.
 * Returns {close, name, attrs, selfClosing, end} | 'incomplete' | null (not a tag).
 */
function scanTag(src, i) {
  let j = i + 1;
  let close = false;
  if (src[j] === '/') { close = true; j++; }
  const m = /^[A-Za-z][\w.-]*/.exec(src.slice(j, j + 64));
  if (!m) {
    // "<" or "</" at the very end of a streamed chunk
    return j >= src.length ? 'incomplete' : null;
  }
  const name = m[0];
  j += name.length;
  if (j >= src.length) return isTagName(name) || couldBecomeTag(name) ? 'incomplete' : null;
  if (!isTagName(name)) return null;
  const c = src[j];
  if (!(c === '>' || c === '/' || /\s/.test(c))) return null;
  if (close) {
    while (j < src.length && /\s/.test(src[j])) j++;
    if (j >= src.length) return 'incomplete';
    if (src[j] !== '>') return null;
    return { close: true, name, attrs: [], selfClosing: false, end: j + 1 };
  }
  const attrs = [];
  for (;;) {
    while (j < src.length && /\s/.test(src[j])) j++;
    if (j >= src.length) return 'incomplete';
    if (src[j] === '>') return { close: false, name, attrs, selfClosing: false, end: j + 1 };
    if (src[j] === '/') {
      if (j + 1 >= src.length) return 'incomplete';
      if (src[j + 1] === '>') return { close: false, name, attrs, selfClosing: true, end: j + 2 };
      return null;
    }
    const am = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(j, j + 128));
    if (!am) return null;
    const key = am[0];
    j += key.length;
    if (j >= src.length) return 'incomplete';
    let k = j;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== '=') { attrs.push([key, { kind: 'bool' }]); continue; }
    k++;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (k >= src.length) return 'incomplete';
    const q = src[k];
    if (q === '"' || q === "'") {
      const e = src.indexOf(q, k + 1);
      if (e < 0) return 'incomplete';
      attrs.push([key, { kind: 'string', value: decodeEntities(src.slice(k + 1, e)) }]);
      j = e + 1;
    } else if (q === '{') {
      const e = scanBraces(src, k);
      if (e < 0) return 'incomplete';
      attrs.push([key, { kind: 'expr', source: src.slice(k + 1, e) }]);
      j = e + 1;
    } else {
      const vm = /^[^\s/>]+/.exec(src.slice(k));
      if (!vm) return null;
      attrs.push([key, { kind: 'string', value: vm[0] }]);
      j = k + vm[0].length;
    }
  }
}

function couldBecomeTag(prefix) {
  if (isCap(prefix)) return true;
  for (const t of PRIMITIVE_TAGS) if (t.startsWith(prefix)) return true;
  return false;
}

/** Returns index of the matching "}" for src[i] === "{", or -1 when unterminated. */
function scanBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const e = src.indexOf(c, j + 1);
      if (e < 0) return -1;
      j = e;
    } else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function decodeEntities(s) {
  return s.replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e) => ({ quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" })[e]);
}

/** Build a tree of {kind:'el', name, attrs, children, selfClosing, incomplete} and strings. */
export function parseMarkup(src) {
  const root = { kind: 'el', name: '#root', attrs: [], children: [], selfClosing: false, incomplete: false };
  const stack = [root];
  let text = '';
  const top = () => stack[stack.length - 1];
  const flushText = () => { if (text) { top().children.push(text); text = ''; } };
  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    const c = src[i];
    // fenced code: copy verbatim, never parse tags inside
    if (atLineStart) {
      const fm = /^[ \t]*(`{3,}|~{3,})/.exec(src.slice(i, i + 64));
      if (fm) {
        const fence = fm[1];
        const startBody = src.indexOf('\n', i);
        let endIdx = src.length;
        if (startBody >= 0) {
          const re = new RegExp('\\n[ \\t]*' + fence[0] + '{' + fence.length + ',}[ \\t]*(?=\\n|$)', 'g');
          re.lastIndex = startBody;
          const em = re.exec(src);
          if (em) endIdx = em.index + em[0].length;
        }
        text += src.slice(i, endIdx);
        i = endIdx;
        atLineStart = false;
        continue;
      }
    }
    if (c === '`') {
      // inline code span: skip to the matching backtick run within the paragraph
      const run = /^`+/.exec(src.slice(i))[0];
      const close = src.indexOf(run, i + run.length);
      const para = src.indexOf('\n\n', i);
      if (close >= 0 && (para < 0 || close < para)) {
        text += src.slice(i, close + run.length);
        i = close + run.length;
        atLineStart = false;
        continue;
      }
    }
    if (c === '<') {
      const t = scanTag(src, i);
      if (t === 'incomplete') {
        // streamed tail: drop the half-written tag, but leave a placeholder so the
        // text before it is not trimmed (matches server output for partial revisions)
        flushText();
        top().children.push(TAIL);
        i = src.length;
        break;
      }
      if (t) {
        flushText();
        if (t.close) {
          let k = stack.length - 1;
          while (k > 0 && stack[k].name !== t.name) k--;
          if (k > 0) stack.length = k; // pops matched element (and any unclosed inner ones)
        } else {
          const el = { kind: 'el', name: t.name, attrs: t.attrs, children: [], selfClosing: t.selfClosing, incomplete: false };
          top().children.push(el);
          if (!t.selfClosing) stack.push(el);
        }
        i = t.end;
        atLineStart = false;
        continue;
      }
    }
    text += c;
    atLineStart = c === '\n';
    i++;
  }
  flushText();
  for (let k = 1; k < stack.length; k++) stack[k].incomplete = true;
  return root;
}

// ---------------------------------------------------------------------------
// 2. Attribute values

function parseExpr(source) {
  const s = source.trim();
  if (s === '') return { ok: false };
  try { return { ok: true, value: JSON.parse(s) }; } catch {}
  // relaxed JS literal: single quotes, unquoted keys, trailing commas
  try {
    const relaxed = s
      .replace(/'((?:[^'\\]|\\.)*)'/g, (_, b) => JSON.stringify(b.replace(/\\'/g, "'")))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1');
    return { ok: true, value: JSON.parse(relaxed) };
  } catch {}
  if (s === 'undefined') return { ok: true, value: null };
  return { ok: false };
}

function attrValue(v) {
  if (v.kind === 'bool') return true;
  if (v.kind === 'string') return v.value;
  const r = parseExpr(v.source);
  return r.ok ? r.value : v.source; // non-literal expressions degrade to their source text
}

// ---------------------------------------------------------------------------
// 3. Code generation

const PH_OPEN = '';
const PH_CLOSE = '';

class Emitter {
  constructor(opts) {
    this.constants = {};
    this.n = 0;
    this.components = new Set();
    this.ordinals = new Map();
    this.partial = !!opts.partial;
    this.resolutionIdFor = opts.resolutionIdFor || defaultResolutionId;
    // the component names a program may use; a capitalized tag outside it is not compiled to a
    // component (its name would otherwise become a bare identifier, e.g. GenUI.dispatchAction)
    this.allowed = opts.components ? new Set(opts.components) : null;
  }
  hoist(value) {
    const key = String(this.n++);
    this.constants[key] = value;
    return `__dilConstants[${JSON.stringify(key)}]`;
  }
  // -- elements --------------------------------------------------------------
  element(node) {
    if (node === TAIL) return null;
    if (isCap(node.name)) return this.component(node);
    const name = node.name;
    const props = this.props(node.attrs, null);
    let kids;
    if (RAW_CONTENT.has(name)) {
      const raw = rawText(node);
      kids = raw === '' ? [] : [this.hoist(name === 'code' ? raw : raw.trim())];
    } else if (INLINE_CONTENT.has(name)) {
      kids = this.inline(node.children);
    } else {
      kids = this.blocks(node.children);
    }
    if (node.incomplete && kids.length === 0) return null; // streaming: prune empty auto-closed
    return `__dil.jsx(${JSON.stringify(name)},${props}${kids.map((k) => ',' + k).join('')})`;
  }
  component(node) {
    const name = node.name;
    if (this.allowed && !this.allowed.has(name)) {
      // keep what it wraps, drop the tag
      const kids = node.children.length ? this.blocks(node.children) : [];
      return kids.length ? `__dil.jsx(__dil.Fragment,null${kids.map((k) => ',' + k).join('')})` : 'null';
    }
    this.components.add(name);
    const ord = this.ordinals.get(name) || 0;
    this.ordinals.set(name, ord + 1);
    const plain = {};
    for (const [k, v] of node.attrs) plain[k] = attrValue(v);
    const hoisted = HOISTED_PROPS[name];
    const parts = node.attrs.map(([k, v]) => {
      const value = attrValue(v);
      const code = hoisted && hoisted.has(k) ? this.hoist(value) : literal(value);
      return `${JSON.stringify(k)}:${code}`;
    });
    parts.push(`"__resolutionId":${this.hoist(this.resolutionIdFor(name, plain, ord))}`);
    const kids = node.children.length ? this.blocks(node.children) : [];
    return `__dilSafe(()=>(__dil.jsx(${name},{${parts.join(',')}}${kids.map((k) => ',' + k).join('')})),null)`;
  }
  props(attrs) {
    if (!attrs.length) return 'null';
    return '{' + attrs.map(([k, v]) => `${JSON.stringify(k)}:${literal(attrValue(v))}`).join(',') + '}';
  }
  // -- block context ---------------------------------------------------------
  blocks(children) {
    const lines = [[]];
    for (const ch of children) {
      if (typeof ch === 'string') {
        const segs = ch.split('\n');
        lines[lines.length - 1].push(segs[0]);
        for (let s = 1; s < segs.length; s++) lines.push([segs[s]]);
      } else {
        lines[lines.length - 1].push(ch);
      }
    }
    const out = [];
    let para = [];
    const flushPara = () => {
      if (para.length) {
        const kids = this.inline(para);
        if (kids.length) out.push(`__dil.jsx("text",null${kids.map((k) => ',' + k).join('')})`);
      }
      para = [];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const strText = line.map((p) => (typeof p === 'string' ? p : PH_OPEN)).join('');
      const onlyStrings = line.every((p) => typeof p === 'string');
      if (strText.trim() === '') {
        // blank line, or a lone element line
        const els = line.filter((p) => typeof p !== 'string');
        if (els.length === 0) { flushPara(); i++; continue; }
      }
      const els = line.filter((p) => typeof p !== 'string');
      const nonWsStrings = line.some((p) => typeof p === 'string' && p.trim() !== '');
      if (els.length === 1 && !nonWsStrings && !INLINE_ONLY.has(els[0].name)) {
        flushPara();
        const code = this.element(els[0]);
        if (code) out.push(code);
        i++;
        continue;
      }
      if (onlyStrings) {
        const s = strText;
        const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(s);
        if (fence) {
          flushPara();
          const body = [s.trim()];
          let j = i + 1;
          let closed = false;
          while (j < lines.length) {
            const ls = lines[j].map((p) => (typeof p === 'string' ? p : '')).join('');
            body.push(ls.replace(/^\s{0,}/, (ws) => ws));
            j++;
            if (new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(ls)) { closed = true; break; }
          }
          const raw = dedent(body.join('\n'));
          out.push(`__dil.jsx("markdown",null,${this.hoist(closed || !this.partial ? raw : raw)})`);
          i = j;
          continue;
        }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s)) { flushPara(); out.push('__dil.jsx("divider",null)'); i++; continue; }
        if (/^\s*\$\$/.test(s)) {
          flushPara();
          let body = s.trim().slice(2);
          let j = i + 1;
          if (!/\$\$\s*$/.test(body) || body.trim() === '') {
            while (j < lines.length) {
              const ls = lines[j].map((p) => (typeof p === 'string' ? p : '')).join('');
              j++;
              body += '\n' + ls;
              if (/\$\$\s*$/.test(ls)) break;
            }
          }
          body = body.replace(/\$\$\s*$/, '').trim();
          if (body) out.push(`__dil.jsx("math",{"display":true},${this.hoist(body)})`);
          i = j;
          continue;
        }
        if (/^\s*\|/.test(s)) {
          flushPara();
          const rows = [];
          let j = i;
          while (j < lines.length && lines[j].every((p) => typeof p === 'string') && /^\s*\|/.test(lines[j].join(''))) {
            rows.push(lines[j].join('').trim());
            j++;
          }
          out.push(`__dil.jsx("markdown",null,${this.hoist(rows.join('\n'))})`);
          i = j;
          continue;
        }
      }
      const first = typeof line[0] === 'string' ? line[0] : '';
      const hm = /^\s{0,3}(#{1,6})(?:\s+|$)/.exec(first);
      if (hm) {
        flushPara();
        const rest = [first.slice(hm[0].length), ...line.slice(1)];
        const kids = this.inline(rest.map((p) => (typeof p === 'string' ? p.replace(/\s+#+\s*$/, '') : p)));
        // an empty heading is still emitted (observed while its content tag is streaming)
        out.push(`__dil.jsx("title",{"size":${JSON.stringify(HEADING_SIZES[hm[1].length - 1])}}${kids.map((k) => ',' + k).join('')})`);
        i++;
        continue;
      }
      if (/^\s{0,3}>\s?/.test(first)) {
        flushPara();
        const parts = [];
        let j = i;
        while (j < lines.length) {
          const l = lines[j];
          const f = typeof l[0] === 'string' ? l[0] : '';
          if (!/^\s{0,3}>\s?/.test(f)) break;
          if (parts.length) parts.push('\n');
          parts.push(f.replace(/^\s{0,3}>\s?/, ''), ...l.slice(1));
          j++;
        }
        const kids = this.inline(parts);
        if (kids.length) out.push(`__dil.jsx("blockquote",null${kids.map((k) => ',' + k).join('')})`);
        i = j;
        continue;
      }
      if (LIST_RE.test(first)) {
        flushPara();
        const { code, next } = this.list(lines, i);
        if (code) out.push(code);
        i = next;
        continue;
      }
      // paragraph text: join soft-wrapped lines
      if (para.length) para.push('\n');
      para.push(...line);
      i++;
    }
    flushPara();
    return out;
  }
  list(lines, start) {
    const items = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const first = typeof line[0] === 'string' ? line[0] : '';
      const m = LIST_RE.exec(first);
      if (m) {
        const indent = m[1].replace(/\t/g, '    ').length;
        const ordered = /\d/.test(m[2]);
        if (items.length && indent <= items[0].indent && ordered !== items[0].ordered) break; // a different list starts
        items.push({ indent, ordered, parts: [first.slice(m[0].length), ...line.slice(1)] });
        i++;
        continue;
      }
      const blank = line.every((p) => typeof p === 'string' && p.trim() === '');
      if (blank) {
        // a blank line continues the list only if another item follows
        let j = i + 1;
        while (j < lines.length && lines[j].every((p) => typeof p === 'string' && p.trim() === '')) j++;
        const nf = j < lines.length && typeof lines[j][0] === 'string' ? lines[j][0] : '';
        if (j < lines.length && LIST_RE.test(nf)) { i = j; continue; }
        break;
      }
      if (/^\s+\S/.test(first) && items.length) {
        // continuation line of the previous item
        items[items.length - 1].parts.push('\n', ...line);
        i++;
        continue;
      }
      break;
    }
    return { code: this.listTree(items, 0, items.length), next: i };
  }
  listTree(items, from, to) {
    if (from >= to) return null;
    const base = items[from].indent;
    const ordered = items[from].ordered;
    const out = [];
    let k = from;
    while (k < to) {
      const it = items[k];
      let end = k + 1;
      while (end < to && items[end].indent > base) end++;
      const kids = this.inline(it.parts);
      const nested = this.listTree(items, k + 1, end);
      if (nested) kids.push(nested);
      if (kids.length) out.push(`__dil.jsx("list-item",null${kids.map((c) => ',' + c).join('')})`);
      k = end;
    }
    if (!out.length) return null;
    return `__dil.jsx("list",{"marker":${ordered ? '"number"' : '"bullet"'}}${out.map((c) => ',' + c).join('')})`;
  }
  // -- inline context --------------------------------------------------------
  inline(parts) {
    const els = [];
    let s = '';
    for (const p of parts) {
      if (typeof p === 'string') s += p;
      else { s += PH_OPEN + els.length + PH_CLOSE; els.push(p); }
    }
    s = s.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/^\s+/, '').replace(/\s+$/, '');
    if (!s) return [];
    const tree = parseInline(s, this.partial);
    return this.emitInline(tree, els);
  }
  emitInline(nodes, els) {
    const out = [];
    for (const n of nodes) {
      if (n.t === 'text') {
        if (n.v !== '') out.push(this.hoist(n.v));
      } else if (n.t === 'ph') {
        const code = this.element(els[n.i]);
        if (code) out.push(code);
      } else if (n.t === 'code' || n.t === 'math') {
        out.push(`__dil.jsx(${JSON.stringify(n.t)},null,${this.hoist(n.v)})`);
      } else if (n.t === 'link') {
        const kids = this.emitInline(n.c, els);
        out.push(`__dil.jsx("link",{"href":${JSON.stringify(n.href)}}${kids.map((k) => ',' + k).join('')})`);
      } else {
        const kids = this.emitInline(n.c, els);
        if (kids.length) out.push(`__dil.jsx(${JSON.stringify(n.t)},null${kids.map((k) => ',' + k).join('')})`);
      }
    }
    return out;
  }
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;

function dedent(s) {
  const lines = s.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
  return Number.isFinite(ind) ? lines.map((l) => l.slice(ind)).join('\n') : s;
}

function rawText(node) {
  return node.children.map((c) => (typeof c === 'string' ? c : rawText(c))).join('');
}

function literal(v) {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

// Inline markdown -> [{t:'text',v} | {t:'ph',i} | {t:'bold'|'italic'|'strikethrough',c} | {t:'link',href,c} | {t:'code'|'math',v}]
function parseInline(s, partial) {
  const out = [];
  let buf = '';
  const push = (n) => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } out.push(n); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!~|<>$]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === PH_OPEN) {
      const e = s.indexOf(PH_CLOSE, i);
      push({ t: 'ph', i: Number(s.slice(i + 1, e)) });
      i = e + 1;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))[0];
      const e = s.indexOf(run, i + run.length);
      if (e >= 0) { push({ t: 'code', v: s.slice(i + run.length, e).trim() }); i = e + run.length; continue; }
    }
    if (c === '\\' && (s[i + 1] === '(')) {
      const e = s.indexOf('\\)', i + 2);
      if (e >= 0) { push({ t: 'math', v: s.slice(i + 2, e).trim() }); i = e + 2; continue; }
    }
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
      if (m) { push({ t: 'link', href: m[2], c: parseInline(m[1], partial) }); i += m[0].length; continue; }
    }
    const delim = s.startsWith('**', i) ? '**' : s.startsWith('__', i) ? '__' : s.startsWith('~~', i) ? '~~' : c === '*' || c === '_' ? c : null;
    if (delim) {
      const prev = i > 0 ? s[i - 1] : ' ';
      const next = s[i + delim.length];
      const leftFlanking = next !== undefined && !/\s/.test(next);
      const wordBound = delim[0] !== '_' || !/[A-Za-z0-9]/.test(prev);
      if (leftFlanking && wordBound) {
        const e = findCloser(s, i + delim.length, delim);
        const type = delim === '~~' ? 'strikethrough' : delim.length === 2 ? 'bold' : 'italic';
        if (e >= 0) {
          push({ t: type, c: parseInline(s.slice(i + delim.length, e), partial) });
          i = e + delim.length;
          continue;
        }
        if (partial && next !== undefined) {
          // streaming: an emphasis run that has not been closed yet
          push({ t: type, c: parseInline(s.slice(i + delim.length), partial) });
          i = s.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  if (buf) out.push({ t: 'text', v: buf });
  return out;
}

function findCloser(s, from, delim) {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))[0];
      const e = s.indexOf(run, i + run.length);
      if (e >= 0) { i = e + run.length; continue; }
    }
    if (c === PH_OPEN) { i = s.indexOf(PH_CLOSE, i) + 1; continue; }
    if (s.startsWith(delim, i) && i > from && !/\s/.test(s[i - 1])) {
      // for single "*", skip a "**" that opens nested bold
      if (delim.length === 1 && s[i + 1] === delim) {
        const inner = findCloser(s, i + 2, delim + delim);
        if (inner >= 0) { i = inner + 2; continue; }
      }
      if (delim[0] === '_' && /[A-Za-z0-9]/.test(s[i + delim.length] || '')) { i++; continue; }
      return i;
    }
    if (delim.length === 1 && s.startsWith(delim + delim, i)) {
      const inner = findCloser(s, i + 2, delim + delim);
      if (inner >= 0) { i = inner + 2; continue; }
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 4. Public API

/** Deterministic UUID-shaped id (the server uses v5-style UUIDs; this mimics the shape). */
export function defaultResolutionId(name, props, ordinal) {
  const input = `${name}\u0000${ordinal}\u0000${stableStringify(props)}`;
  let hex = '';
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b9)) >>> 0;
    for (let k = 0; k < input.length; k++) {
      h ^= input.charCodeAt(k);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    hex += h.toString(16).padStart(8, '0');
  }
  const v = hex.split('');
  v[12] = '5';
  v[16] = ((parseInt(v[16], 16) & 0x3) | 0x8).toString(16);
  const x = v.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/**
 * Compile model output to a DIL program.
 * @param {string} markdown accumulated message markdown (may be a streamed prefix)
 * @param {{partial?: boolean, resolutionIdFor?: (name:string, props:object, ordinal:number)=>string, components?: Iterable<string>}} [opts]
 *   components: the only component names allowed; any other capitalized tag keeps its children
 *   but is not compiled to a component (default: any name, as the stock compiler)
 * @returns {{code:string, constants:Record<string,any>, requiredComponents:string[], fallbackMarkdown:string}}
 */
export function compile(markdown, opts = {}) {
  const tree = parseMarkup(String(markdown ?? ''));
  const em = new Emitter(opts);
  const blocks = em.blocks(tree.children);
  const body = blocks.length === 0 ? 'null' : blocks.length === 1 ? blocks[0] : `__dil.jsx(__dil.Fragment,null,${blocks.join(',')})`;
  const prelude = em.components.size ? SAFE_PRELUDE : '';
  const code = `${prelude}DIL.render(__dil.jsx(()=>{const __dilConstants=DIL.useConstants();const __dilModelDataBindings=DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});return ${body};},{"key":"body:0"}));`;
  return {
    code,
    constants: em.constants,
    requiredComponents: [...em.components].sort(),
    fallbackMarkdown: fallbackMarkdown(tree),
  };
}

/** Wrap a compile result into a content-record `dil` payload (findings §1.2 validator shape). */
export function toDilPayload(result, appData = { opGenui: { componentResults: {}, modelDataBindings: {} } }) {
  const dil = { kind: 'dil', renderer: 'dil-v2', status: 'pending', code: result.code, constants: result.constants, appData };
  if (result.requiredComponents.length) dil.requiredComponents = result.requiredComponents;
  dil.fallbackMarkdown = result.fallbackMarkdown;
  dil.viewState = {};
  return dil;
}

/** Markdown with DIL tags stripped (simplified version of the server's fallbackMarkdown). */
function fallbackMarkdown(tree) {
  const walk = (n) => n.children.map((c) => {
    if (typeof c === 'string') return c;
    if (isCap(c.name)) {
      const v = c.attrs.find(([k]) => k === 'value');
      return v ? String(attrValue(v[1])) : '';
    }
    if (c.name === 'divider') return '\n\n---\n\n';
    const inner = walk(c);
    return INLINE_CONTENT.has(c.name) || RAW_CONTENT.has(c.name) ? inner.trim() + '\n\n' : inner;
  }).join('');
  return walk(tree).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^[ \t]+/gm, '').trim();
}

/**
 * Recover the resolution ids a compiled program assigned to each component, in document
 * order, and return a `resolutionIdFor` that hands the k-th <Name> the same id. Lets a
 * locally compiled program bind to server-resolved appData.opGenui.componentResults.
 */
export function resolutionIdsFromProgram(code, constants) {
  const byName = {};
  const re = /__dil\.jsx\(([A-Z][\w$]*),\{(?:[^{}]|\{[^{}]*\})*?"__resolutionId":__dilConstants\["(\d+)"\]/g;
  let m;
  while ((m = re.exec(code || ''))) (byName[m[1]] ||= []).push(constants?.[m[2]]);
  const fn = (name, props, ordinal) => byName[name]?.[ordinal] ?? defaultResolutionId(name, props, ordinal);
  fn.byName = byName;
  return fn;
}
