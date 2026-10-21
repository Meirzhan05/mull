// Wonder compiler: chatgpt-dil's markup -> DIL compiler, extended for the learning catalog.
//
// chatgpt-dil/src/compiler.js reproduces ChatGPT's server compiler byte-for-byte, but it was
// built from a capture where every component prop was a string or a tiny literal. Lessons
// need real structured props (<Quiz questions={[...]}/>), so this module runs a source-level
// pass *before* the stock compiler:
//
//   1. scan the markdown for learning-catalog tags (fence- and inline-code-aware),
//   2. parse every {expression} attribute as lenient JSON (unquoted keys, single quotes,
//      trailing commas, comments; never evaluated),
//   3. validate/normalize the props against server/catalog-schema.js,
//   4. valid   -> rewrite the tag with placeholder props, compile, then hoist each value into
//                 __dilConstants (the way the server hoists every text run),
//      invalid -> replace the component with fallback markdown so the lesson still reads,
//   5. a half-streamed learning tag at the tail is cut so partial streams always compile,
//   6. <Followups items={[...]}/> is protocol, not UI: it is lifted out (followupPrompts).

import { compile, toDilPayload, defaultResolutionId } from '../../chatgpt-dil/src/compiler.js';
import { tryParseExpression } from './lenient-json.js';
import { LEARNING_COMPONENTS, META_COMPONENTS, validateComponentProps, fallbackMarkdownFor } from './catalog-schema.js';

const KNOWN = new Set([...Object.keys(LEARNING_COMPONENTS), ...Object.keys(META_COMPONENTS)]);
const PLACEHOLDER = (n) => `__wonder_h${n}__`;
const PLACEHOLDER_RE = /"__wonder_h(\d+)__"/g;

function decodeEntities(s) {
  return s.replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e) => ({ quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" })[e]);
}

/** Index of the "}" closing src[i] === "{" (string- and escape-aware), or -1 if unterminated. */
function scanBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      let k = j + 1;
      while (k < src.length && src[k] !== c) k += src[k] === '\\' ? 2 : 1;
      if (k >= src.length) return -1;
      j = k;
    } else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * Parse an opening tag of a known component at src[i] === '<'.
 * Returns {name, attrs, selfClosing, end} | {incomplete:true, name} | null.
 */
function scanOpenTag(src, i) {
  const m = /^[A-Z][\w.-]*/.exec(src.slice(i + 1, i + 65));
  if (!m || !KNOWN.has(m[0])) return null;
  const name = m[0];
  let j = i + 1 + name.length;
  if (j >= src.length) return { incomplete: true, name };
  if (!(src[j] === '>' || src[j] === '/' || /\s/.test(src[j]))) return null;
  const attrs = [];
  for (;;) {
    while (j < src.length && /\s/.test(src[j])) j++;
    if (j >= src.length) return { incomplete: true, name };
    if (src[j] === '>') return { name, attrs, selfClosing: false, end: j + 1 };
    if (src[j] === '/') {
      if (j + 1 >= src.length) return { incomplete: true, name };
      return src[j + 1] === '>' ? { name, attrs, selfClosing: true, end: j + 2 } : null;
    }
    const am = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(j, j + 128));
    if (!am) return null;
    const key = am[0];
    j += key.length;
    if (j >= src.length) return { incomplete: true, name };
    let k = j;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== '=') { attrs.push([key, { kind: 'bool' }]); continue; }
    k++;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (k >= src.length) return { incomplete: true, name };
    const q = src[k];
    if (q === '"' || q === "'") {
      const e = src.indexOf(q, k + 1); // same rule as the stock compiler (no escapes in quoted attrs)
      if (e < 0) return { incomplete: true, name };
      attrs.push([key, { kind: 'string', value: decodeEntities(src.slice(k + 1, e)) }]);
      j = e + 1;
    } else if (q === '{') {
      const e = scanBraces(src, k);
      if (e < 0) return { incomplete: true, name };
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

/** Tokenize known-component tags in document order, skipping code fences and code spans. */
export function scanComponentTags(src) {
  const out = [];
  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    const c = src[i];
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
        i = endIdx;
        atLineStart = false;
        continue;
      }
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0];
      const close = src.indexOf(run, i + run.length);
      const para = src.indexOf('\n\n', i);
      if (close >= 0 && (para < 0 || close < para)) { i = close + run.length; atLineStart = false; continue; }
    }
    if (c === '<') {
      if (src[i + 1] === '/') {
        const m = /^<\/([A-Z][\w.-]*)\s*>/.exec(src.slice(i, i + 80));
        if (m && KNOWN.has(m[1])) { out.push({ kind: 'close', name: m[1], start: i, end: i + m[0].length }); i += m[0].length; atLineStart = false; continue; }
      } else {
        const t = scanOpenTag(src, i);
        if (t && t.incomplete) { out.push({ kind: 'incomplete', name: t.name, start: i, end: src.length }); break; }
        if (t) { out.push({ kind: 'open', ...t, start: i }); i = t.end; atLineStart = false; continue; }
      }
    }
    atLineStart = c === '\n';
    i++;
  }
  return out;
}

/**
 * Primitive tags (<box padding={4}>) go straight to the stock compiler, which turns any
 * non-literal {expression} into a string prop. Model output can contain real JS there
 * (onClick={() => ...}), so keep only expressions that parse as a JSON scalar and drop the rest.
 * Fence- and code-span-aware, like scanComponentTags.
 */
export function sanitizePrimitiveExpressions(src) {
  let out = '';
  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    const c = src[i];
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
        out += src.slice(i, endIdx);
        i = endIdx;
        atLineStart = false;
        continue;
      }
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0];
      const close = src.indexOf(run, i + run.length);
      const para = src.indexOf('\n\n', i);
      if (close >= 0 && (para < 0 || close < para)) { out += src.slice(i, close + run.length); i = close + run.length; atLineStart = false; continue; }
    }
    const tm = c === '<' ? /^<([a-z][\w-]*)(?=[\s/>])/.exec(src.slice(i, i + 64)) : null;
    if (tm) {
      let j = i + tm[0].length;
      let tag = tm[0];
      for (;;) {
        const ws = /^\s*/.exec(src.slice(j))[0];
        const am = /^([A-Za-z_:][\w:.-]*)(\s*=\s*)?/.exec(src.slice(j + ws.length, j + ws.length + 160));
        if (!am || !am[1]) break; // ">", "/>", or end of input
        const vStart = j + ws.length + am[0].length;
        if (!am[2]) { tag += ws + am[1]; j = vStart; continue; } // boolean attribute
        const q = src[vStart];
        if (q === '{') {
          const e = scanBraces(src, vStart);
          if (e < 0) break; // unterminated (streaming tail): leave it to the stock compiler's partial handling
          const r = tryParseExpression(src.slice(vStart + 1, e));
          const v = r.ok ? r.value : undefined;
          if (v === null || ['number', 'boolean', 'string'].includes(typeof v)) tag += `${ws}${am[1]}={${JSON.stringify(v)}}`;
          j = e + 1;
        } else if (q === '"' || q === "'") {
          const e = src.indexOf(q, vStart + 1);
          if (e < 0) break;
          tag += src.slice(j, e + 1);
          j = e + 1;
        } else {
          const vm = /^[^\s/>]*/.exec(src.slice(vStart))[0];
          tag += src.slice(j, vStart + vm.length);
          j = vStart + vm.length;
          if (!vm) break;
        }
      }
      out += tag;
      i = j;
      atLineStart = false;
      continue;
    }
    out += c;
    atLineStart = c === '\n';
    i++;
  }
  return out;
}

function isAloneOnLine(src, start, end) {
  const ls = src.lastIndexOf('\n', start - 1) + 1;
  let le = src.indexOf('\n', end);
  if (le < 0) le = src.length;
  return src.slice(ls, start).trim() === '' && src.slice(end, le).trim() === '';
}

function rawProps(attrs) {
  const props = {};
  const errors = [];
  for (const [k, v] of attrs) {
    if (v.kind === 'bool') props[k] = true;
    else if (v.kind === 'string') props[k] = v.value;
    else {
      const r = tryParseExpression(v.source);
      if (r.ok) props[k] = r.value;
      else errors.push(`${k}: ${r.error}`);
    }
  }
  return { props, errors };
}

/**
 * Rewrite the source for the stock compiler.
 * @returns {{source:string, fallbackSource:string, hoisted:any[], components:object[], followups:string[]}}
 */
export function preprocess(src) {
  const tags = scanComponentTags(src);
  const hoisted = [];
  const components = [];
  let followups = [];
  const drop = new Set(); // indices of close tags to remove
  let out = '';
  let fb = '';
  let pos = 0;
  for (let t = 0; t < tags.length; t++) {
    const tag = tags[t];
    if (tag.kind === 'close') {
      out += src.slice(pos, tag.start);
      fb += src.slice(pos, tag.start);
      if (!drop.has(t)) out += src.slice(tag.start, tag.end); // close tags never reach the fallback source
      pos = tag.end;
      continue;
    }
    if (tag.kind === 'incomplete') {
      // Streaming tail: cut the half-written tag. The bare "<Name" keeps the stock compiler's
      // tail placeholder (so the preceding whitespace survives exactly like a dropped tag).
      out += src.slice(pos, tag.start) + '<' + tag.name;
      fb += src.slice(pos, tag.start);
      pos = src.length;
      components.push({ name: tag.name, status: 'streaming' });
      break;
    }
    const before = src.slice(pos, tag.start);
    out += before;
    fb += before;
    pos = tag.end;
    // matching close tag (for components written with children)
    let closeIdx = -1;
    if (!tag.selfClosing) {
      let depth = 0;
      for (let k = t + 1; k < tags.length; k++) {
        if (tags[k].name !== tag.name) continue;
        if (tags[k].kind === 'open' && !tags[k].selfClosing) depth++;
        else if (tags[k].kind === 'close') { if (depth === 0) { closeIdx = k; break; } depth--; }
      }
    }
    const { props, errors } = rawProps(tag.attrs);
    if (META_COMPONENTS[tag.name]) {
      const r = errors.length ? { ok: false } : META_COMPONENTS[tag.name](props);
      if (r.ok && tag.name === 'Followups') followups = r.props.items;
      if (closeIdx >= 0) drop.add(closeIdx);
      continue;
    }
    const spec = LEARNING_COMPONENTS[tag.name];
    const block = isAloneOnLine(src, tag.start, tag.end);
    const r = errors.length ? { ok: false, error: `Unparseable props (${errors.join('; ')})` } : validateComponentProps(tag.name, props);
    const fallback = fallbackMarkdownFor(tag.name, r.ok ? r.props : props, { inline: !block || spec.inline });
    if (!r.ok) {
      components.push({ name: tag.name, status: 'invalid', error: r.error });
      const text = block ? `\n${fallback}\n` : fallback;
      out += text;
      fb += text;
      if (closeIdx >= 0) drop.add(closeIdx);
      continue;
    }
    // Server-resolved components (TeacherCard) carry their resolution id in the markup; it is
    // handed to the stock compiler's resolutionIdFor instead of becoming a prop.
    const { __resolutionId: explicitId, ...props2 } = r.props;
    components.push({ name: tag.name, status: 'valid', props: r.props, ...(spec.resolved ? { resolutionId: explicitId } : {}) });
    const attrs = Object.entries(props2).map(([k, v]) => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return `${k}={${JSON.stringify(v)}}`;
      hoisted.push(v);
      return `${k}={"${PLACEHOLDER(hoisted.length - 1)}"}`;
    });
    out += `<${tag.name}${attrs.length ? ' ' + attrs.join(' ') : ''}${tag.selfClosing ? '/>' : '>'}`;
    fb += spec.children ? (r.props.title ? `**${r.props.title}** ` : '') + (r.props.body || '') : block ? `\n${fallback}\n` : fallback;
  }
  out += src.slice(pos);
  fb += src.slice(pos);
  return { source: out, fallbackSource: fb, hoisted, components, followups };
}

/**
 * Compile Wonder lesson markup (markdown + inline DIL) to a DIL program.
 * @param {string} markdown accumulated (possibly partial) message
 * @param {{partial?:boolean, salt?:string, fallback?:boolean}} [opts]
 */
export function compileWonder(markdown, opts = {}) {
  const pre = preprocess(String(markdown ?? ''));
  pre.source = sanitizePrimitiveExpressions(pre.source);
  pre.fallbackSource = sanitizePrimitiveExpressions(pre.fallbackSource);
  const salt = opts.salt || '';
  // ids depend only on (name, ordinal, salt): stable across streamed revisions of one message
  const explicit = {};
  for (const c of pre.components) if (c.status === 'valid') (explicit[c.name] ||= []).push(c.resolutionId);
  const resolutionIdFor = (name, _props, ordinal) => explicit[name]?.[ordinal] || defaultResolutionId(name, { __salt: salt }, ordinal);
  const result = compile(pre.source, { partial: !!opts.partial, resolutionIdFor });
  let next = Object.keys(result.constants).reduce((m, k) => Math.max(m, Number(k) + 1), 0);
  const constants = result.constants;
  const code = result.code.replace(PLACEHOLDER_RE, (_, n) => {
    const key = String(next++);
    constants[key] = pre.hoisted[Number(n)];
    return `__dilConstants[${JSON.stringify(key)}]`;
  });
  const fallbackMarkdown = opts.fallback === false ? '' : compile(pre.fallbackSource, { partial: !!opts.partial }).fallbackMarkdown;
  return { code, constants, requiredComponents: result.requiredComponents, fallbackMarkdown, components: pre.components, followups: pre.followups };
}

/** Content-record `dil` payload (passes chatgpt-dil's stream validator). */
export function toWonderDil(result, appData) {
  return toDilPayload(result, appData ?? { opGenui: { componentResults: {}, modelDataBindings: {} } });
}
