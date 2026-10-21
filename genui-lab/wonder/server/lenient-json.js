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

// LaTeX written inside JSON string props ("\\frac{1}{n}" is right, but models often write
// "\frac{1}{n}"): a backslash followed by the letters of a known LaTeX command is kept literally
// instead of decoding \f \t \b \n \r \v \u \x (\frac -> form feed + "rac", \theta -> tab + "heta").
// Unknown letter escapes (\lambda-like, not valid JSON) keep their backslash too.
// Genuine escapes still decode: "\n" + a word that is not a command ("\nNext"), \", \\, \uXXXX.
export const LATEX_COMMANDS = new Set(`
  frac dfrac tfrac cfrac sqrt text textbf textit textrm texttt textsf mathrm mathbf mathit mathsf mathtt mathcal mathbb mathfrak
  boldsymbol operatorname mbox times div cdot cdots ldots dots vdots ddots pm mp ast star circ bullet
  alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho
  sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
  neq ne leq le geq ge ll gg approx sim simeq cong equiv propto parallel perp mid nmid
  in notin ni subset subseteq supset supseteq cup cap setminus emptyset varnothing forall exists nexists neg lnot land lor wedge vee
  to gets rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow longrightarrow longleftarrow mapsto implies iff
  uparrow downarrow updownarrow nearrow searrow
  sum prod coprod int iint iiint oint lim limsup liminf sup inf max min arg det deg dim exp ker gcd hom log ln lg
  sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth
  partial nabla infty hbar ell Re Im aleph prime angle triangle square degree
  left right big Big bigg Bigg bigl bigr Bigl Bigr middle langle rangle lfloor rfloor lceil rceil lvert rvert lVert rVert vert Vert
  hat widehat bar overline underline vec dot ddot tilde widetilde acute grave breve check overbrace underbrace overset underset stackrel
  binom tbinom dbinom choose pmod bmod mod
  quad qquad displaystyle textstyle scriptstyle hspace vspace phantom
  begin end cases matrix pmatrix bmatrix vmatrix aligned array
  top bot vdash models therefore because checkmark not boxed color textcolor
`.trim().split(/\s+/));

/** Length of the LaTeX command name at s[i] (the letters after a backslash), or 0. */
function latexCommandAt(s, i) {
  const m = /^[A-Za-z]+/.exec(s.slice(i, i + 24));
  return m && LATEX_COMMANDS.has(m[0]) ? m[0].length : 0;
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
      const cmd = latexCommandAt(s, i);
      if (cmd) { out += '\\' + s.slice(i, i + cmd); i += cmd; continue; } // \frac, \theta, \nabla … stay LaTeX
      const e = s[i++];
      if (/[A-Za-z]/.test(e || '') && !'ntrbfvux'.includes(e)) { out += '\\' + e; continue; } // not a JSON escape: keep
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
  // strict JSON would decode "\frac" as a form feed: anything with a backslash takes the lenient path
  if (!t.includes('\\')) try { return { ok: true, value: JSON.parse(t) }; } catch {}
  try { return { ok: true, value: parseLenientJSON(t) }; } catch (e) { return { ok: false, error: e.message }; }
}
