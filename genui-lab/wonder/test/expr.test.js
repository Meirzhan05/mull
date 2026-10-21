import test from 'node:test';
import assert from 'node:assert/strict';
import { createExprCompiler } from '../public/expr.js';

const { compile, sample } = createExprCompiler();
const val = (src, scope = {}, vars = ['x', ...Object.keys(scope)]) => {
  const r = compile(src, vars);
  assert.ok(r.ok, `${src}: ${r.error}`);
  return r.fn(scope);
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('arithmetic, precedence and associativity', () => {
  close(val('1 + 2 * 3'), 7);
  close(val('(1 + 2) * 3'), 9);
  close(val('2 ^ 3 ^ 2'), 512); // right-associative
  close(val('2 ** 3'), 8);
  close(val('-x^2', { x: 3 }), -9);
  close(val('10 / 4 - 1'), 1.5);
  close(val('1.5e2 + .5'), 150.5);
});

test('implicit multiplication and unicode operators', () => {
  close(val('2x', { x: 4 }), 8);
  close(val('3sin(0) + 2(x+1)', { x: 1 }), 4);
  close(val('a·x − b', { x: 2, a: 3, b: 1 }), 5);
  close(val('6 ÷ 3 × 2'), 4);
});

test('functions and constants', () => {
  close(val('a*sin(b*x)', { x: Math.PI / 2, a: 2, b: 1 }), 2);
  close(val('sqrt(16) + abs(-3) + ln(e)'), 8);
  close(val('max(1, x, 3)', { x: 7 }), 7);
  close(val('cos(pi)'), -1);
});

test('rejects anything outside the whitelist', () => {
  for (const bad of ['alert(1)', 'constructor', 'x.constructor', 'y + 1', '"str"', 'x[0]', 'this', '__proto__', 'Function("x")', 'process', '1 +', '(1', '']) {
    const r = compile(bad, ['x']);
    assert.equal(r.ok, false, `should reject: ${bad}`);
  }
  assert.equal(compile('x'.repeat(201), ['x']).ok, false);
  assert.equal(compile(Array(150).fill('x').join('+'), ['x']).ok, false); // too complex
});

test('non-finite results become NaN; sampling breaks at asymptotes', () => {
  assert.ok(Number.isNaN(val('1/x', { x: 0 })));
  assert.ok(Number.isNaN(val('log(x)', { x: -1 })));
  const { fn } = compile('1/x', ['x']);
  const segs = sample(fn, {}, -2, 2, 40, 50);
  assert.ok(segs.length >= 2, 'split at the pole');
  for (const s of segs) for (const [, y] of s) assert.ok(Math.abs(y) <= 50);
});

test('reports which variables an expression uses', () => {
  const r = compile('a*sin(b*x) + c', ['x', 'a', 'b', 'c', 'd']);
  assert.deepEqual([...r.vars].sort(), ['a', 'b', 'c', 'x']);
});

test('the compiler is self-contained (safe to inject into the sandbox prelude)', () => {
  const rebuilt = new Function(`return (${createExprCompiler.toString()})`)()();
  assert.equal(rebuilt.compile('2x+1', ['x']).fn({ x: 3 }), 7);
});
