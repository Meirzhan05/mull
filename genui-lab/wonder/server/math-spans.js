// Math spans: protect LaTeX from markdown/markup parsing before the stock compiler runs.
//
// Claude writes math four ways: <math>…</math> (optionally `display`), $$…$$ / \[…\] (display),
// \(…\) and $…$ (inline). The stock chatgpt-dil compiler only knows <math> and line-leading $$,
// its inline "\(" rule is shadowed by its "\(" escape rule, and a streamed <math> shows its
// half-written LaTeX ("\text{me" -> "\textme" once prettified). This pass, fence- and
// code-span-aware like scanComponentTags, replaces every math span with
//   <math display>__wonder_m<N>__</math>   or   <math>__wonder_m<N>__</math>
// and returns the raw LaTeX; compileWonder swaps each placeholder constant for its LaTeX, so
// braces, backslashes and underscores reach the client byte for byte.
//
// Dollar rules (pandoc's tex_math_dollars, tightened for prices): the opening "$" is not
// followed by whitespace; the closer is the NEXT unescaped "$" on the same line, which must not
// be preceded by whitespace or followed by a digit; the content must look like math (a letter,
// "\", "^", "_", "=", "{" or "}"). "$40,000 … $3, $4", "$6." and "costs $5 and $10" never match.
//
// Partial streams: an unclosed span at the tail is held back (cut), like a half-written tag, so
// the learner never sees raw "\frac" flash before the formula is complete.

import { PRIMITIVE_TAGS } from '../../chatgpt-dil/src/compiler.js';

export const MATH_PLACEHOLDER_RE = /^__wonder_m(\d+)__$/;
const MATH_PLACEHOLDER_G = /__wonder_m(\d+)__/g;
const RAW_TAGS = new Set(['code', 'markdown', 'text-only-markdown']);
const MATHY = /[A-Za-z\\^_={}]/;
const HOLD_LIMIT = 400; // a would-be "$" span longer than this at the tail is released as text

const isTagName = (n) => /^[A-Z]/.test(n) || PRIMITIVE_TAGS.has(n);

function decodeEntities(s) {
  return s.replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e) => ({ quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" })[e]);
}

/** End index (exclusive) of the tag starting at src[i] === '<' (quote/brace aware), or -1. */
function tagEnd(src, i) {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || (depth > 0 && c === '`')) {
      const e = src.indexOf(c, j + 1);
      if (e < 0) return -1;
      j = e;
    } else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return j + 1;
  }
  return -1;
}

function aloneOnLine(src, start, end) {
  const ls = src.lastIndexOf('\n', start - 1) + 1;
  let le = src.indexOf('\n', end);
  if (le < 0) le = src.length;
  return src.slice(ls, start).trim() === '' && src.slice(end, le).trim() === '';
}

/**
 * Find the closing "$" of an inline span opened at src[i] === '$'.
 * Returns {end} (index of the closer), {fail:true}, or {open:true} when the line runs out.
 */
function inlineDollar(src, i) {
  const first = src[i + 1];
  if (first === undefined) return { open: true };
  if (/\s/.test(first) || first === '$') return { fail: true };
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return { fail: true };
    if (c === '<') {
      const t = /^<\/?([A-Za-z][\w.-]*)/.exec(src.slice(j, j + 40));
      if (t && isTagName(t[1])) return { fail: true }; // never span markup
    }
    if (c === '$') {
      if (/\s/.test(src[j - 1]) || /\d/.test(src[j + 1] || '')) return { fail: true };
      return MATHY.test(src.slice(i + 1, j)) ? { end: j } : { fail: true };
    }
  }
  return { open: true };
}

/** Index of `close` after `from`, only before the next blank line; -1 if absent, -2 if a blank line comes first. */
function closerBeforeBlank(src, from, close) {
  const e = src.indexOf(close, from);
  const blank = src.indexOf('\n\n', from);
  if (e >= 0 && (blank < 0 || e < blank)) return e;
  return blank >= 0 ? -2 : -1;
}

/**
 * @param {string} src markdown (after the catalog pre-pass)
 * @param {{partial?:boolean}} [opts]
 * @returns {{source:string, latex:string[]}}
 */
export function protectMath(src, opts = {}) {
  const partial = !!opts.partial;
  const latex = [];
  let out = '';
  let i = 0;
  let atLineStart = true;
  const emit = (body, display) => {
    latex.push(body);
    out += `<math${display ? ' display' : ''}>__wonder_m${latex.length - 1}__</math>`;
  };
  const hold = () => { i = src.length; };
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
    if (c === '<') {
      const nm = /^<(\/?)([A-Za-z][\w.-]*)/.exec(src.slice(i, i + 64));
      if (nm && isTagName(nm[2])) {
        const end = tagEnd(src, i);
        if (end < 0) { out += src.slice(i); i = src.length; break; } // half-written tag: the stock compiler drops it
        const name = nm[2];
        if (!nm[1] && name === 'math' && src[end - 2] !== '/') {
          const close = src.indexOf('</math>', end);
          if (close < 0) {
            if (partial) { hold(); break; }
            out += src.slice(i, end);
            i = end;
            atLineStart = false;
            continue;
          }
          const attrs = src.slice(i + 5, end - 1);
          const display = /(^|\s)display(\s*=\s*(\{\s*true\s*\}|"(true|display|block)?"|'(true|display|block)?'|true))?(\s|$)/.test(attrs)
            || aloneOnLine(src, i, close + 7);
          const body = decodeEntities(src.slice(end, close)).trim();
          if (body) emit(body, display);
          i = close + 7;
          atLineStart = false;
          continue;
        }
        if (!nm[1] && RAW_TAGS.has(name) && src[end - 2] !== '/') {
          const close = src.indexOf(`</${name}>`, end);
          const stop = close < 0 ? src.length : close + name.length + 3;
          out += src.slice(i, stop);
          i = stop;
          atLineStart = false;
          continue;
        }
        out += src.slice(i, end);
        i = end;
        atLineStart = false;
        continue;
      }
    }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) { if (partial) { hold(); break; } out += c; i++; continue; }
      if (n === '(' || n === '[') {
        const closeTok = n === '(' ? '\\)' : '\\]';
        const e = closerBeforeBlank(src, i + 2, closeTok);
        if (e >= 0) {
          const body = src.slice(i + 2, e).trim();
          if (body) emit(body, n === '[');
          i = e + 2;
          atLineStart = false;
          continue;
        }
        if (e === -1 && partial) { hold(); break; }
      }
      out += c + n; // "\\", "\$", or any other escape stays as written
      i += 2;
      atLineStart = n === '\n';
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === '$') {
        const e = closerBeforeBlank(src, i + 2, '$$');
        if (e >= 0 && src.slice(i + 2, e).trim()) {
          emit(src.slice(i + 2, e).trim(), true);
          i = e + 2;
          atLineStart = false;
          continue;
        }
        if (e === -1 && partial) { hold(); break; }
        out += '$$';
        i += 2;
        atLineStart = false;
        continue;
      }
      const r = inlineDollar(src, i);
      if (r.end != null) {
        emit(src.slice(i + 1, r.end), false);
        i = r.end + 1;
        atLineStart = false;
        continue;
      }
      if (r.open && partial) {
        // Tail of a stream: hold back what could still become a formula; a price ("$5 for…")
        // starts with a digit and stays visible unless it already looks like LaTeX.
        const rest = src.slice(i + 1);
        if (rest === '' || (rest.length <= HOLD_LIMIT && (!/^\d/.test(rest) || /[\\^_{}]/.test(rest)))) { hold(); break; }
      }
    }
    out += c;
    atLineStart = c === '\n';
    i++;
  }
  return { source: out, latex };
}

/** Swap math placeholders back to LaTeX in compiled constants (in place) and in a string. */
export function restoreMathConstants(constants, latex) {
  for (const k of Object.keys(constants)) {
    const v = constants[k];
    if (typeof v !== 'string') continue;
    const m = MATH_PLACEHOLDER_RE.exec(v);
    if (m && latex[Number(m[1])] != null) constants[k] = latex[Number(m[1])];
  }
  return constants;
}

export function restoreMathText(s, latex, wrap = (t) => t) {
  return String(s).replace(MATH_PLACEHOLDER_G, (all, n) => (latex[Number(n)] != null ? wrap(latex[Number(n)]) : all));
}
