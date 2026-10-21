// Safe math expressions for <FunctionGraph fn="a*sin(b*x)"/>: a tiny recursive-descent parser
// that compiles to closures. No eval/Function, no property access, no strings: only numbers,
// whitelisted identifiers and whitelisted functions.
//
// `createExprCompiler` is fully self-contained (no outer references) so its source text can be
// injected into the DIL sandbox prelude, and the same function validates props on the server.

export function createExprCompiler() {
  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2,
  };
  const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
  const MAX_LEN = 200;
  const MAX_NODES = 200;

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
      if (c === '*' && src[i + 1] === '*') { out.push({ t: 'op', v: '^' }); i += 2; continue; }
      if ('+-*/^(),'.includes(c)) { out.push({ t: 'op', v: c === '×' ? '*' : c }); i++; continue; }
      if (c === '×' || c === '·') { out.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '−') { out.push({ t: 'op', v: '-' }); i++; continue; }
      if (c === '÷') { out.push({ t: 'op', v: '/' }); i++; continue; }
      throw new Error(`Unexpected character "${c}"`);
    }
    return out;
  }

  /**
   * Compile `src` with the allowed variable names (e.g. ["x","a","b"]).
   * Returns {ok:true, fn(scope)->number, vars:Set} or {ok:false, error}.
   */
  function compile(src, allowedVars) {
    try {
      if (typeof src !== 'string' || !src.trim()) throw new Error('Empty expression');
      if (src.length > MAX_LEN) throw new Error('Expression too long');
      const allowed = new Set(allowedVars || ['x']);
      const toks = tokenize(src);
      let p = 0;
      let nodes = 0;
      const used = new Set();
      const peek = () => toks[p];
      const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
      const take = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };
      const count = () => { if (++nodes > MAX_NODES) throw new Error('Expression too complex'); };
      // implicit multiplication: 2x, 2(x+1), (a)(b), 3sin(x)
      const startsPrimary = () => {
        const t = peek();
        return t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('));
      };

      function expr() {
        let left = term();
        while (isOp('+') || isOp('-')) {
          const op = toks[p++].v; const a = left; const b = term(); count();
          left = op === '+' ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
        }
        return left;
      }
      function term() {
        let left = unary();
        for (;;) {
          if (isOp('*') || isOp('/')) {
            const op = toks[p++].v; const a = left; const b = unary(); count();
            left = op === '*' ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
          } else if (startsPrimary()) {
            const a = left; const b = power(); count();
            left = (s) => a(s) * b(s);
          } else return left;
        }
      }
      function unary() {
        if (isOp('-')) { p++; const a = unary(); count(); return (s) => -a(s); }
        if (isOp('+')) { p++; return unary(); }
        return power();
      }
      function power() {
        const base = primary();
        if (isOp('^')) { p++; const ex = unary(); count(); return (s) => Math.pow(base(s), ex(s)); } // right-assoc via unary->power
        return base;
      }
      function primary() {
        const t = peek();
        if (!t) throw new Error('Unexpected end of expression');
        count();
        if (t.t === 'num') { p++; const v = t.v; return () => v; }
        if (t.t === 'op' && t.v === '(') { p++; const e = expr(); take(')'); return e; }
        if (t.t === 'id') {
          p++;
          const name = t.v;
          if (isOp('(')) {
            const f = Object.prototype.hasOwnProperty.call(FUNCS, name) ? FUNCS[name] : null;
            if (!f) throw new Error(`Unknown function "${name}"`);
            p++;
            const args = [];
            if (!isOp(')')) { args.push(expr()); while (isOp(',')) { p++; args.push(expr()); } }
            take(')');
            return (s) => f(...args.map((a) => a(s)));
          }
          if (Object.prototype.hasOwnProperty.call(CONSTS, name) && !allowed.has(name)) { const v = CONSTS[name]; return () => v; }
          if (!allowed.has(name)) throw new Error(`Unknown variable "${name}"`);
          used.add(name);
          return (s) => { const v = s[name]; return typeof v === 'number' ? v : NaN; };
        }
        throw new Error(`Unexpected "${t.v}"`);
      }

      const fn = expr();
      if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
      return { ok: true, fn: (scope) => { const v = fn(scope || {}); return Number.isFinite(v) ? v : NaN; }, vars: used };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** Sample y = f(x) over [x0, x1] into polyline segments (breaks at NaN/asymptotes). */
  function sample(fn, scope, x0, x1, n, yClamp) {
    const segs = [];
    let cur = [];
    const lim = yClamp || 1e6;
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = fn(Object.assign({}, scope, { x }));
      if (!Number.isFinite(y) || Math.abs(y) > lim) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
      if (cur.length && Math.abs(y - cur[cur.length - 1][1]) > lim / 4) { if (cur.length > 1) segs.push(cur); cur = []; }
      cur.push([x, y]);
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  return { compile, sample, FUNCS: Object.keys(FUNCS), CONSTS: Object.keys(CONSTS) };
}
