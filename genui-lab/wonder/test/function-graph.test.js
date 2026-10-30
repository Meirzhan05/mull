// Phase 5: <FunctionGraph/>: schema validation, sandbox render, slider interaction, streaming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFunctionGraph, functionGraphFallback } from '../server/function-graph.js';
import { validateComponentProps } from '../server/catalog-schema.js';
import { compileWonder } from '../server/compile.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../server/prompts.js';
import { sampleLesson, runProgram, catalogNodes } from './helpers.js';

const SINE = { fn: 'a*sin(b*x)', params: [{ name: 'a', min: 0, max: 3, step: 0.5, value: 1, label: 'amplitude' }, { name: 'b', min: 0.5, max: 3, step: 0.5, value: 1 }], xRange: [-6.28, 6.28], yRange: [-3, 3], title: 'Sine waves', caption: 'Change a and b.', points: [{ x: 0, y: 0, label: 'origin' }] };
const tag = (p) => `<FunctionGraph ${Object.entries(p).map(([k, v]) => (typeof v === 'string' ? `${k}="${v}"` : `${k}={${JSON.stringify(v)}}`)).join(' ')}/>`;

test('valid FunctionGraph props normalize (fn -> fns, defaults, clamped values)', () => {
  const r = validateFunctionGraph(SINE);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.props.fns, [{ fn: 'a*sin(b*x)' }]);
  assert.deepEqual(r.props.params[0], { name: 'a', min: 0, max: 3, step: 0.5, value: 1, label: 'amplitude' });
  assert.deepEqual(r.props.xRange, [-6.28, 6.28]);
  assert.deepEqual(r.props.points, [{ x: 0, y: 0, label: 'origin' }]);
  const auto = validateFunctionGraph({ fn: 'y = x^2', xRange: [-2, 2], params: [{ name: 'k', min: 0, max: 1, value: 5 }] });
  assert.ok(auto.ok, auto.error);
  assert.equal(auto.props.fns[0].fn, 'x^2', '"y =" prefix dropped');
  assert.equal(auto.props.params[0].value, 1, 'value clamped into [min,max]');
  assert.equal(auto.props.params[0].step, 0.05, 'default step = span/20');
  assert.ok(auto.props.yRange[0] <= 0 && auto.props.yRange[1] >= 3.9, `auto yRange ${auto.props.yRange}`);
  const multi = validateFunctionGraph({ fns: [{ fn: 'sin(x)', label: 'sin' }, 'cos(x)'], xRange: [0, 6.28] });
  assert.ok(multi.ok);
  assert.deepEqual(multi.props.fns, [{ fn: 'sin(x)', label: 'sin' }, { fn: 'cos(x)' }]);
  assert.ok(validateComponentProps('FunctionGraph', SINE).ok, 'registered in the learning catalog');
});

test('invalid FunctionGraph props are rejected with a reason', () => {
  const bad = (p, re) => { const r = validateFunctionGraph(p); assert.equal(r.ok, false, JSON.stringify(p)); assert.match(r.error, re); };
  bad({ xRange: [0, 1] }, /needs fn/);
  bad({ ...SINE, fn: 'a*sin(b*x' }, /Expected "\)"/);
  bad({ ...SINE, fn: 'a*sin(c*x)' }, /Unknown variable "c"/);
  bad({ ...SINE, fn: 'alert(x)' }, /Unknown function "alert"/);
  bad({ ...SINE, fn: 'x.constructor' }, /Unexpected character/);
  bad({ ...SINE, params: ['a', 'b', 'c', 'd', 'k'].map((name) => ({ name, min: 0, max: 1 })) }, /at most 4 params/);
  bad({ ...SINE, params: [{ name: 'x', min: 0, max: 1 }] }, /reserved/);
  bad({ ...SINE, params: [{ name: 'pi', min: 0, max: 1 }] }, /reserved/);
  bad({ ...SINE, params: [{ name: 'a', min: 2, max: 1 }] }, /min < max/);
  bad({ ...SINE, params: [{ name: 'a', min: 0, max: 1, step: 0.0001 }] }, /too many steps/);
  bad({ ...SINE, xRange: [3, 1] }, /below max/);
  bad({ ...SINE, xRange: 'wide' }, /xRange must be/);
  bad({ ...SINE, yRange: [0, 1e9] }, /too wide/);
  bad({ ...SINE, fn: 'sqrt(x)', xRange: [-5, -1] }, /undefined over xRange/);
  bad({ ...SINE, fns: ['x', 'x', 'x', 'x'] }, /at most 3 curves/);
  bad({ ...SINE, points: Array.from({ length: 7 }, (_, i) => ({ x: i, y: 0 })) }, /at most 6 points/);
  bad({ ...SINE, points: [{ x: 'a', y: 1 }] }, /numeric x and y/);
});

test('an invalid graph compiles to fallback markdown: formula as code + caption', () => {
  const out = compileWonder(`Intro.\n\n${tag({ ...SINE, fn: 'a*sin(c*x)' })}\n\nAfter.`);
  assert.equal(out.components[0].status, 'invalid');
  assert.deepEqual(out.requiredComponents, []);
  const env = runProgram(out);
  assert.match(env.mirror.text(), /Sine waves.*y = a\*sin\(c\*x\).*amplitude.*Change a and b\..*After\./);
  assert.match(functionGraphFallback({ fn: 'x^2', caption: 'A parabola' }), /^`y = x\^2`\n\nA parabola$/);
});

const curves = (env) => env.mirror.findAll((n) => n.type === 'path' && n.props.__component === 'GraphCurve');
const byLabel = (env, label) => env.mirror.findAll((n) => n.props?.ariaLabel === label)[0];
const press = (env, label) => { const n = byLabel(env, label); assert.ok(n, `no control "${label}"`); const r = env.rt.invokeFunction(n.props.onClick.__fn, []); assert.ok(r.ok, r.error); };

test('sandbox: axes, grid and a sampled path; pressing a slider re-renders the curve', () => {
  const env = runProgram(compileWonder(tag(SINE)));
  assert.deepEqual(env.errors, []);
  const graph = catalogNodes(env.mirror, 'FunctionGraph')[0];
  assert.ok(graph);
  const svg = env.mirror.findAll((n) => n.type === 'svg', graph)[0];
  assert.equal(svg.props.viewBox, '-6 -6 612 312');
  const [curve] = curves(env);
  assert.match(curve.props.d, /^M0\.0 1(49|50)\.\d(L[\d.]+ [\d.]+){100,}/, 'sampled polyline starts at the left edge, y=0 at mid-height');
  assert.equal(env.mirror.findAll((n) => n.type === 'circle', graph).length, 1, 'labeled point drawn');
  assert.match(env.mirror.text(graph), /Sine waves.*y = 1·sin\(1·x\).*-6\.28.*6\.28.*origin \(0, 0\).*amplitude \(a\).*a = 1.*b = 1.*Change a and b\./);
  const before = curve.props.d;

  press(env, 'Set a to 2');
  const after = curves(env)[0].props.d;
  assert.notEqual(after, before, 'path changed');
  assert.match(env.mirror.text(graph), /a = 2/);
  assert.match(env.mirror.text(graph), /Reset/);
  // a=2: the peak at x=pi/2 is twice as far from the midline (150 - 2*50 = 50)
  const minY = (d) => Math.min(...[...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1])));
  assert.ok(Math.abs(minY(after) - 50) < 1.5, `peak at ${minY(after)}`);
  assert.ok(Math.abs(minY(before) - 100) < 1.5);

  press(env, 'Increase a');
  assert.match(env.mirror.text(graph), /a = 2\.5/);
  press(env, 'Increase a');
  press(env, 'Increase a'); // clamped at max
  assert.match(env.mirror.text(graph), /a = 3b/);
  assert.equal(byLabel(env, 'Increase a').props.disabled, true);
  press(env, 'Decrease b');
  assert.match(env.mirror.text(graph), /b = 0\.5/);
  // a=3 exceeds yRange [-3,3] only at the edge; the path is clipped into the plot box
  for (const m of curves(env)[0].props.d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)) assert.ok(Number(m[2]) >= -0.01 && Number(m[2]) <= 300.01);
  const reset = env.mirror.findAll((n) => n.props?.onClick && env.mirror.text(n) === 'Reset', graph)[0];
  env.rt.invokeFunction(reset.props.onClick.__fn, []);
  assert.equal(curves(env)[0].props.d, before, 'reset restores the starting curve');
});

test('sandbox: asymptotes break the path; mobile layout is narrower; multiple curves', () => {
  const tan = runProgram(compileWonder(tag({ fn: 'tan(x)', xRange: [-3, 3], yRange: [-5, 5] })));
  assert.deepEqual(tan.errors, []);
  assert.ok((curves(tan)[0].props.d.match(/M/g) || []).length >= 3, 'separate pieces around the poles');
  const mobile = runProgram(compileWonder(tag({ fns: [{ fn: 'sin(x)', label: 'sin' }, { fn: 'cos(x)', label: 'cos' }], xRange: [0, 6.28] })), { viewportWidth: 390 });
  assert.deepEqual(mobile.errors, []);
  assert.equal(mobile.mirror.findAll((n) => n.type === 'svg')[0].props.viewBox, '-6 -6 332 232');
  assert.equal(curves(mobile).length, 2);
  assert.deepEqual(curves(mobile).map((c) => c.props.stroke), ['brand-strong', 'warning']);
});

test('compound-interest sample: FunctionGraph renders and the r slider bends the curve', () => {
  const md = sampleLesson('compound-interest.md');
  const out = compileWonder(md, { salt: 'sample' });
  const fg = out.components.find((c) => c.name === 'FunctionGraph');
  assert.equal(fg.status, 'valid');
  const env = runProgram(out);
  assert.deepEqual(env.errors, []);
  assert.equal(catalogNodes(env.mirror, 'FunctionGraph').length, 1);
  const end = () => Number(/L600\.0 ([\d.]+)$/.exec(curves(env)[0].props.d)[1]);
  const at7 = end();
  assert.ok(Math.abs(at7 - (300 - (14974 / 22000) * 300)) < 1, `1000·1.07^40 ≈ 14974 -> y=${at7}`);
  press(env, 'Set r to 0.03');
  assert.ok(end() > at7 + 100, 'lower rate -> lower end point');
});

test('every streamed prefix of the compound-interest sample keeps FunctionGraph valid or absent', () => {
  const md = sampleLesson('compound-interest.md');
  const start = md.indexOf('<FunctionGraph');
  const stop = md.indexOf('/>', start) + 2;
  for (let i = start - 2; i <= stop + 2; i += 3) {
    const out = compileWonder(md.slice(0, i), { partial: true, salt: 'sample' });
    const fg = out.components.filter((c) => c.name === 'FunctionGraph');
    assert.ok(fg.every((c) => c.status !== 'invalid'), `prefix ${i}`);
    assert.doesNotMatch(out.code, /FunctionGraph title=|fns=\{/, 'raw tag text never leaks into the program');
    const env = runProgram(out);
    assert.deepEqual(env.errors, [], `prefix ${i}`);
    if (i >= stop) assert.equal(catalogNodes(env.mirror, 'FunctionGraph').length, 1);
  }
});

test('prompts teach FunctionGraph and grounding', () => {
  assert.match(LESSON_SYSTEM_PROMPT, /<FunctionGraph title=/);
  assert.match(LESSON_SYSTEM_PROMPT, /exactly one FunctionGraph/);
  assert.match(LESSON_SYSTEM_PROMPT, /Never write citation markup yourself/);
  assert.match(TUTOR_SYSTEM_PROMPT, /<FunctionGraph/);
});
