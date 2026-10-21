// Lenient JSON ("JSON5-ish") parser for DIL attribute expressions written by the model.
//
// Accepts strict JSON plus the slips models make when writing JSX-like props:
//   - unquoted keys            {label: "x"}
//   - single-quoted / backtick strings ('x', `x` without ${})
//   - trailing commas          [1, 2,]
//   - comments                 // ... and /* ... */
//   - raw newlines in strings, \x / \u{...} escapes, +1 / .5 / 1. / 0x10 numbers, NaN/Infinity
//   - `undefined` (becomes null)
// It never evaluates code: identifiers other than true/false/null/undefined/NaN/Infinity throw.

export class LenientJSONError extends SyntaxError {
  constructor(message, index) {
    super(`${message} at position ${index}`);
    this.name = 'LenientJSONError';
    this.index = index;
  }
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;
const NUMBER_RE = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

export function parseLenientJSON(source) {
  const s = String(source);
  let i = 0;
  const fail = (m) => { throw new LenientJSONError(m, i); };

  function ws() {
    for (;;) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === '﻿') i++;
      else if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; }
      else if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        if (e < 0) fail('Unterminated comment');
        i = e + 2;
      } else return;
    }
  }

  function string() {
    const q = s[i++];
    let out = '';
    while (i < s.length) {
      const c = s[i++];
      if (c === q) return out;
      if (q === '`' && c === '$' && s[i] === '{') fail('Template expressions are not allowed');
      if (c !== '\\') { out += c; continue; }
      const e = s[i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case '\n': break; // line continuation
        case '\r': if (s[i] === '\n') i++; break;
        case 'x': {
          const h = s.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(h)) fail('Bad \\x escape');
          out += String.fromCharCode(parseInt(h, 16));
          i += 2;
          break;
        }
        case 'u': {
          if (s[i] === '{') {
            const end = s.indexOf('}', i);
            const h = s.slice(i + 1, end);
            if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(h)) fail('Bad \\u{} escape');
            out += String.fromCodePoint(parseInt(h, 16));
            i = end + 1;
          } else {
            const h = s.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Bad \\u escape');
            out += String.fromCharCode(parseInt(h, 16));
            i += 4;
          }
          break;
        }
        case undefined: fail('Unterminated string'); break;
        default: out += e;
      }
    }
    fail('Unterminated string');
  }

  function identifier() {
    const start = i;
    if (!ID_START.test(s[i] || '')) fail('Unexpected character');
    i++;
    while (i < s.length && ID_PART.test(s[i])) i++;
    return s.slice(start, i);
  }

  function number() {
    const m = NUMBER_RE.exec(s.slice(i, i + 64));
    if (!m) fail('Bad number');
    i += m[0].length;
    const t = m[0].replace(/^\+/, '');
    if (/^-?0[xX]/.test(t)) return (t.startsWith('-') ? -1 : 1) * parseInt(t.replace(/^-/, ''), 16);
    const v = Number(t);
    return Number.isFinite(v) ? v : null; // NaN / Infinity are not representable in JSON
  }

  function array() {
    i++;
    const out = [];
    ws();
    if (s[i] === ']') { i++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (s[i] === ',') {
        i++;
        ws();
        if (s[i] === ']') { i++; return out; }
        continue;
      }
      if (s[i] === ']') { i++; return out; }
      fail('Expected , or ]');
    }
  }

  function object() {
    i++;
    const out = {};
    ws();
    if (s[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      let key;
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') key = string();
      else if (/[0-9.+-]/.test(c || '')) key = String(number());
      else key = identifier();
      ws();
      if (s[i] !== ':') fail('Expected :');
      i++;
      const v = value();
      if (key === '__proto__') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      else out[key] = v;
      ws();
      if (s[i] === ',') {
        i++;
        ws();
        if (s[i] === '}') { i++; return out; }
        continue;
      }
      if (s[i] === '}') { i++; return out; }
      fail('Expected , or }');
    }
  }

  function value() {
    ws();
    const c = s[i];
    if (c === undefined) fail('Unexpected end of input');
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'" || c === '`') return string();
    if (/[0-9.+-]/.test(c)) return number();
    const id = identifier();
    switch (id) {
      case 'true': return true;
      case 'false': return false;
      case 'null': case 'undefined': return null;
      case 'NaN': case 'Infinity': return null;
      default: i -= id.length; return fail(`Unexpected identifier "${id}"`);
    }
  }

  const v = value();
  ws();
  if (i < s.length) fail('Unexpected trailing characters');
  return v;
}

/** Strict JSON first (fast path), then the lenient grammar. Returns {ok, value} | {ok:false, error}. */
export function tryParseExpression(source) {
  const t = String(source ?? '').trim();
  if (!t) return { ok: false, error: 'empty expression' };
  try { return { ok: true, value: JSON.parse(t) }; } catch {}
  try { return { ok: true, value: parseLenientJSON(t) }; } catch (e) { return { ok: false, error: e.message }; }
}
