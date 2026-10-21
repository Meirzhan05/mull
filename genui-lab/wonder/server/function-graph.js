// Phase 5: <FunctionGraph/> prop validation (ChatGPT's Skybridge "graphable function" math
// block, chatgpt-findings §3.7, rebuilt as a DIL catalog component). The same safe expression
// compiler (public/expr.js) validates here and evaluates inside the sandbox.
//
//   <FunctionGraph fn="a*sin(b*x)" params={[{"name":"a","min":0,"max":3,"step":0.1,"value":1,"label":"amplitude"}]}
//     xRange={[-6.28,6.28]} yRange={[-3,3]} title="" caption="" points={[{"x":0,"y":0,"label":"origin"}]}/>

import { createExprCompiler } from '../public/expr.js';

const expr = createExprCompiler();
const RESERVED = new Set(['x', ...expr.FUNCS, ...expr.CONSTS]);
export const FUNCTION_GRAPH_LIMITS = Object.freeze({ params: 4, points: 6, fns: 3, maxSteps: 400, maxSpan: 1e6 });

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, n = 160) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const fail = (error) => ({ ok: false, error });
const round = (v) => Math.round(v * 1e6) / 1e6;

function range(v, name) {
  const r = Array.isArray(v) ? v.map(num) : isObj(v) ? [num(v.min ?? v.from), num(v.max ?? v.to)] : null;
  if (!r || r.length !== 2 || r.some((x) => x == null)) return { error: `${name} must be [min, max]` };
  const [a, b] = r;
  if (!(a < b)) return { error: `${name} min must be below max` };
  if (b - a > FUNCTION_GRAPH_LIMITS.maxSpan || Math.abs(a) > FUNCTION_GRAPH_LIMITS.maxSpan || Math.abs(b) > FUNCTION_GRAPH_LIMITS.maxSpan) return { error: `${name} is too wide` };
  return { value: [a, b] };
}

/** Normalize + validate FunctionGraph props. Returns {ok, props} | {ok:false, error}. */
export function validateFunctionGraph(p) {
  // curves: fn="..." or fns=[...] (strings or {fn,label})
  const rawFns = Array.isArray(p.fns) ? p.fns : Array.isArray(p.functions) ? p.functions : [p.fn ?? p.function ?? p.expression ?? p.formula].filter((v) => v != null);
  if (!rawFns.length) return fail('FunctionGraph needs fn');
  if (rawFns.length > FUNCTION_GRAPH_LIMITS.fns) return fail(`FunctionGraph allows at most ${FUNCTION_GRAPH_LIMITS.fns} curves`);

  const rawParams = Array.isArray(p.params) ? p.params : Array.isArray(p.parameters) ? p.parameters : Array.isArray(p.sliders) ? p.sliders : [];
  if (rawParams.length > FUNCTION_GRAPH_LIMITS.params) return fail(`FunctionGraph allows at most ${FUNCTION_GRAPH_LIMITS.params} params`);
  const params = [];
  for (const [i, rp] of rawParams.entries()) {
    if (!isObj(rp)) return fail(`Param ${i + 1} is not an object`);
    const name = str(rp.name, 16);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,11}$/.test(name)) return fail(`Param ${i + 1} needs a short identifier name`);
    if (RESERVED.has(name)) return fail(`Param name "${name}" is reserved`);
    if (params.some((q) => q.name === name)) return fail(`Duplicate param "${name}"`);
    const min = num(rp.min);
    const max = num(rp.max);
    if (min == null || max == null || !(min < max)) return fail(`Param "${name}" needs min < max`);
    if (max - min > FUNCTION_GRAPH_LIMITS.maxSpan) return fail(`Param "${name}" range is too wide`);
    let step = num(rp.step);
    if (step == null || step <= 0) step = (max - min) / 20;
    if ((max - min) / step > FUNCTION_GRAPH_LIMITS.maxSteps) return fail(`Param "${name}" has too many steps`);
    let value = num(rp.value ?? rp.default ?? rp.initial);
    if (value == null) value = min;
    value = Math.min(max, Math.max(min, value));
    const out = { name, min, max, step: round(step), value };
    const label = str(rp.label ?? rp.description, 40);
    if (label) out.label = label;
    const unit = str(rp.unit, 12);
    if (unit) out.unit = unit;
    params.push(out);
  }
  const names = ['x', ...params.map((q) => q.name)];
  const scope = Object.fromEntries(params.map((q) => [q.name, q.value]));

  const xr = range(p.xRange ?? p.domain ?? p.xDomain ?? p.x, 'xRange');
  if (xr.error) return fail(xr.error);
  const [x0, x1] = xr.value;

  const fns = [];
  const compiled = [];
  for (const [i, f] of rawFns.entries()) {
    const src = typeof f === 'string' ? f : isObj(f) ? f.fn ?? f.expression ?? f.formula : null;
    if (typeof src !== 'string') return fail(`Curve ${i + 1} needs fn`);
    const clean = src.trim().replace(/^y\s*=\s*/i, '');
    const c = expr.compile(clean, names);
    if (!c.ok) return fail(`Curve ${i + 1} (${clean.slice(0, 40)}): ${c.error}`);
    compiled.push(c.fn);
    const out = { fn: clean };
    const label = isObj(f) ? str(f.label ?? f.name, 40) : '';
    if (label) out.label = label;
    fns.push(out);
  }

  // the curve must actually be drawable somewhere in the window at the initial values
  const ys = [];
  for (const fn of compiled) for (const seg of expr.sample(fn, scope, x0, x1, 120, 1e9)) for (const [, y] of seg) ys.push(y);
  if (ys.length < 2) return fail('FunctionGraph curve is undefined over xRange');

  let yRange;
  if (p.yRange != null || p.range != null) {
    const yr = range(p.yRange ?? p.range, 'yRange');
    if (yr.error) return fail(yr.error);
    yRange = yr.value;
  } else {
    // auto: 5th-95th percentile with padding, always including 0 when close
    const s = [...ys].sort((a, b) => a - b);
    let lo = s[Math.floor(s.length * 0.05)];
    let hi = s[Math.ceil(s.length * 0.95) - 1];
    if (lo > 0 && lo < (hi - lo)) lo = 0;
    if (hi < 0 && -hi < (hi - lo)) hi = 0;
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.1;
    yRange = [round(lo - pad), round(hi + pad)];
  }

  const props = { fns, params, xRange: [x0, x1], yRange };
  const rawPoints = Array.isArray(p.points) ? p.points : [];
  if (rawPoints.length > FUNCTION_GRAPH_LIMITS.points) return fail(`FunctionGraph allows at most ${FUNCTION_GRAPH_LIMITS.points} points`);
  const points = [];
  for (const [i, pt] of rawPoints.entries()) {
    const x = num(isObj(pt) ? pt.x : Array.isArray(pt) ? pt[0] : null);
    const y = num(isObj(pt) ? pt.y : Array.isArray(pt) ? pt[1] : null);
    if (x == null || y == null) return fail(`Point ${i + 1} needs numeric x and y`);
    const out = { x, y };
    const label = isObj(pt) ? str(pt.label, 40) : '';
    if (label) out.label = label;
    points.push(out);
  }
  if (points.length) props.points = points;
  for (const k of ['title', 'caption', 'xLabel', 'yLabel']) { const v = str(p[k], k === 'caption' ? 300 : 80); if (v) props[k] = v; }
  return { ok: true, props };
}

const md = (s) => String(s).replace(/</g, '‹').replace(/`/g, "'").replace(/\s*\n\s*/g, ' ').trim();

/** Fallback markdown: the formula as code plus the caption (and the parameter ranges). */
export function functionGraphFallback(p) {
  const o = isObj(p) ? p : {};
  const fns = (Array.isArray(o.fns) ? o.fns : [o.fn ?? o.function ?? o.expression ?? o.formula]).map((f) => (typeof f === 'string' ? f : isObj(f) ? f.fn : null)).filter((f) => typeof f === 'string' && f.trim());
  const lines = [];
  if (str(o.title)) lines.push(`**${md(o.title)}**`, '');
  for (const f of fns.slice(0, 3)) lines.push(`\`y = ${md(f.replace(/^y\s*=\s*/i, ''))}\``);
  const params = (Array.isArray(o.params) ? o.params : []).filter(isObj).slice(0, 4);
  if (params.length) lines.push('', params.map((q) => `${md(str(q.name, 16))}${q.label ? ` (${md(str(q.label, 40))})` : ''}: ${num(q.min) ?? '?'} to ${num(q.max) ?? '?'}`).join(' · '));
  if (str(o.caption)) lines.push('', md(o.caption));
  return lines.join('\n').trim();
}
