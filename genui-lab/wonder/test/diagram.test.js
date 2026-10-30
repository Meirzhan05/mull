// <Diagram/>: schema validation, fallback, sandbox render, parts and steps, streaming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDiagram, diagramFallback, diagramColor } from '../server/diagram.js';
import { validateComponentProps } from '../server/catalog-schema.js';
import { compileWonder } from '../server/compile.js';
import { lintLesson } from '../server/critic.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../server/prompts.js';
import { sampleLesson, runProgram, catalogNodes } from './helpers.js';

const SCENE = {
  title: 'Light meets air', width: 400, height: 220,
  shapes: [
    { id: 'sun', type: 'circle', x: 50, y: 50, r: 24, fill: 'yellow' },
    { type: 'text', x: 50, y: 95, text: 'Sun', part: 'sun' },
    { id: 'beam', type: 'arrow', from: [80, 60], to: [200, 130], stroke: 'orange', part: 'light' },
    { id: 'mol', type: 'circle', x: 210, y: 135, r: 6, fill: '#888888', part: 'air' },
    { id: 'blue', type: 'arrow', from: [215, 130], to: [300, 60], stroke: 'blue', curve: 20 },
    { type: 'rect', x: 0, y: 190, w: 400, h: 30, fill: 'green', opacity: 0.3 },
  ],
  parts: [{ id: 'sun', label: 'The Sun', text: 'Sends **white** light.' }, { id: 'light', label: 'Sunlight', text: 'Every color together.' }, { id: 'air', label: 'Air molecule', text: 'Tiny N₂ or O₂.' }],
  steps: [
    { label: 'Light arrives', text: 'Sunlight heads down.', show: ['sun', 'beam'], highlight: ['beam'] },
    { label: 'It hits a molecule', show: ['mol'], highlight: ['air'] },
    { label: 'Blue scatters', text: 'Blue bounces off sideways.', show: ['blue'], highlight: ['blue'] },
  ],
  caption: 'Not to scale.',
};
const tag = (p) => `<Diagram ${Object.entries(p).map(([k, v]) => (typeof v === 'string' ? `${k}="${v}"` : `${k}={${JSON.stringify(v)}}`)).join(' ')}/>`;

test('valid Diagram props normalize (aliases, colors, text defaults, rounding)', () => {
  const r = validateDiagram(SCENE);
  assert.ok(r.ok, r.error);
  assert.equal(r.props.shapes.length, 6);
  assert.deepEqual(r.props.shapes[0], { type: 'circle', x: 50, y: 50, r: 24, fill: '#f2c230', id: 'sun' });
  assert.deepEqual(r.props.shapes[1], { type: 'text', x: 50, y: 95, text: 'Sun', size: 15, anchor: 'middle', part: 'sun' });
  assert.deepEqual(r.props.shapes[4], { type: 'arrow', from: [215, 130], to: [300, 60], curve: 20, stroke: '#2f7bf5', id: 'blue' });
  assert.equal(r.props.shapes[5].opacity, 0.3);
  assert.equal(r.props.steps[1].highlight[0], 'air');
  assert.equal(r.props.caption, 'Not to scale.');
  const alias = validateDiagram({ shapes: [{ type: 'box', x: 1, y: 2, width: 30, height: 20, color: 'brand' }, { type: 'label', x: 10, y: 10, label: 'Hi', align: 'left', weight: 'bold', size: 'lg' }, { type: 'dot', cx: 5, cy: 6, radius: 2 }, { type: 'segment', x1: 0, y1: 0, x2: 10, y2: 10 }] });
  assert.ok(alias.ok, alias.error);
  assert.deepEqual(alias.props.shapes.map((s) => s.type), ['rect', 'text', 'circle', 'line']);
  assert.equal(alias.props.shapes[0].stroke, 'brand-strong');
  assert.deepEqual([alias.props.shapes[1].anchor, alias.props.shapes[1].bold, alias.props.shapes[1].size], ['start', true, 19]);
  assert.deepEqual([alias.props.width, alias.props.height], [400, 250], 'default canvas');
  assert.equal(diagramColor('ink'), 'primary');
  assert.deepEqual([diagramColor('white'), diagramColor('black')], ['#ffffff', '#111111'], 'literal white/black do not flip in dark mode');
  assert.equal(diagramColor('#ABC'), '#abc');
  assert.equal(diagramColor('url(javascript:x)'), '', 'unknown colors fall back to the default');
  assert.ok(validateComponentProps('Diagram', SCENE).ok, 'registered in the learning catalog');
});

test('a free label inside a shape joins that shape (smallest container); outside labels stay free and let taps through', () => {
  const r = validateDiagram({
    shapes: [
      { id: 'heart', type: 'rect', x: 0, y: 0, w: 400, h: 250 },
      { id: 'ra', type: 'rect', x: 40, y: 40, w: 100, h: 80, part: 'atrium' },
      { id: 'lv', type: 'circle', x: 300, y: 150, r: 40 },
      { type: 'text', x: 90, y: 80, text: 'Right atrium' },
      { type: 'text', x: 300, y: 150, text: 'Left ventricle' },
      { type: 'text', x: 200, y: 200, text: 'Heart' },
      { type: 'text', x: 200, y: 260, text: 'Outside' },
      { type: 'text', x: 90, y: 60, text: 'Mine', part: 'other' },
    ],
    parts: [{ id: 'atrium', label: 'Atrium', text: 'Collects blood.' }],
  });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.props.shapes.filter((s) => s.type === 'text').map((s) => [s.part ?? null, s.follows ?? null]),
    [['atrium', 'ra'], [null, 'lv'], [null, 'heart'], [null, null], ['other', null]]);
  const env = runProgram(compileWonder(tag(r.props)));
  const label = (t) => env.mirror.findAll((n) => n.type === 'svg-text' && n.props.text === t)[0];
  assert.ok(label('Right atrium').props.onClick, 'the label taps like its chamber');
  assert.equal(label('Outside').props.pointerEvents, 'none');
  press(env, label('Right atrium'));
  assert.equal(label('Right atrium').props.opacity, 1, 'the selected part keeps its label bright');
  assert.equal(label('Left ventricle').props.opacity, 0.22);
});

test('a label follows its shape through steps even when the shape is staged by id, not by part', () => {
  const r = validateDiagram({
    shapes: [{ id: 'mol', type: 'circle', x: 100, y: 100, r: 30, part: 'air' }, { type: 'text', x: 100, y: 100, text: 'N₂' }, { id: 'sun', type: 'circle', x: 300, y: 60, r: 20 }],
    parts: [{ id: 'air', label: 'Air', text: 'Molecules.' }],
    steps: [{ label: 'Sun', show: ['sun'] }, { label: 'Molecule', show: ['mol'], highlight: ['mol'] }],
  });
  assert.ok(r.ok, r.error);
  const env = runProgram(compileWonder(tag(r.props)));
  const label = () => env.mirror.findAll((n) => n.type === 'svg-text')[0];
  assert.equal(label().props.opacity, 0, 'hidden with its molecule at step 1');
  press(env, byLabel(env, 'Next step'));
  assert.equal(label().props.opacity, 1, 'shown and highlighted with it at step 2');
  assert.equal(opacities(env)[2], 0.22);
});

test('invalid Diagram props are rejected with a reason', () => {
  const bad = (p, re) => { const r = validateDiagram(p); assert.equal(r.ok, false, JSON.stringify(p)); assert.match(r.error, re); };
  const one = (s) => ({ shapes: [s] });
  bad({}, /needs shapes/);
  bad({ shapes: Array.from({ length: 41 }, () => ({ type: 'circle', x: 1, y: 1, r: 1 })) }, /at most 40 shapes/);
  bad({ ...SCENE, width: 50 }, /width must be/);
  bad({ ...SCENE, width: 1000, height: 100 }, /too narrow or too tall/);
  bad(one({ type: 'star', x: 1, y: 1 }), /unknown type "star"/);
  bad(one({ type: 'rect', x: 1, y: 1, w: -5, h: 3 }), /positive w, h/);
  bad(one({ type: 'circle', x: 900, y: 10, r: 5 }), /outside the 400x250 canvas/);
  bad(one({ type: 'arrow', from: [1, 1] }), /needs from \[x,y\] and to/);
  bad(one({ type: 'line', from: [5, 5], to: [5, 5] }), /zero length/);
  bad(one({ type: 'polygon', points: [[0, 0], [1, 1]] }), /3\+ points/);
  bad(one({ type: 'path', d: 'M0 0 L10 10"/><script>' }), /SVG path commands only/);
  bad(one({ type: 'path', d: 'L0 0' }), /SVG path commands only/);
  bad(one({ type: 'path', d: 'M0 0 L99999 0' }), /outside the canvas/);
  bad(one({ type: 'text', x: 5, y: 5 }), /needs x, y and text/);
  bad(one({ type: 'circle', x: 5, y: 5, r: 2, id: '1bad id' }), /short identifier/);
  bad({ shapes: [{ type: 'circle', x: 5, y: 5, r: 2, id: 'a' }, { type: 'circle', x: 9, y: 5, r: 2, id: 'a' }] }, /Duplicate shape id/);
  bad({ ...SCENE, parts: [{ id: 'ghost', label: 'Ghost', text: 'Nothing.' }] }, /Part "ghost" matches no shape/);
  bad({ ...SCENE, parts: [{ id: 'sun', label: 'Sun' }] }, /needs id, label and text/);
  bad({ ...SCENE, steps: [{ label: 'Only one' }] }, /at least 2 steps/);
  bad({ ...SCENE, steps: [{ label: 'a', show: ['nope'] }, { label: 'b' }] }, /Step 1 show "nope" matches no shape/);
  bad({ ...SCENE, steps: [{ label: 'a' }, { label: 'b', highlight: ['nope'] }] }, /Step 2 highlight "nope"/);
  bad({ ...SCENE, steps: [{}, { label: 'b' }] }, /needs a label or text/);
});

test('an invalid diagram compiles to fallback markdown: parts as a list, steps in order', () => {
  const out = compileWonder(`Intro.\n\n${tag({ ...SCENE, width: 10 })}\n\nAfter.`);
  assert.equal(out.components[0].status, 'invalid');
  const env = runProgram(out);
  assert.deepEqual(env.errors, []);
  assert.match(env.mirror.text(), /Light meets air.*The Sun.*Sends white light\..*Sunlight.*Light arrives.*Sunlight heads down\..*Blue scatters.*Not to scale\..*After\./);
  assert.equal(diagramFallback({ title: 'T', steps: [{ label: 'A', text: 'x' }, { text: 'y' }] }), '**T**\n\n1. **A**: x\n2. y');
});

const shapeNodes = (env) => catalogNodes(env.mirror, 'DiagramShape');
const opacities = (env) => shapeNodes(env).map((n) => n.props.opacity);
const byLabel = (env, label) => env.mirror.findAll((n) => n.props?.ariaLabel === label)[0];
const press = (env, node) => { assert.ok(node, 'no such control'); const r = env.rt.invokeFunction(node.props.onClick.__fn, []); assert.ok(r.ok, r.error); };

test('sandbox: shapes, labels and arrowheads draw on the canvas; steps reveal and highlight', () => {
  const env = runProgram(compileWonder(tag(SCENE)));
  assert.deepEqual(env.errors, []);
  const d = catalogNodes(env.mirror, 'Diagram')[0];
  assert.ok(d);
  const svg = catalogNodes(env.mirror, 'DiagramCanvas')[0];
  assert.equal(svg.props.viewBox, '0 0 400 220');
  assert.match(svg.props.ariaLabel, /Light meets air\. Parts: The Sun, Sunlight, Air molecule/);
  assert.deepEqual(shapeNodes(env).map((n) => n.type), ['circle', 'svg-text', 'g', 'circle', 'g', 'rect']);
  assert.equal(env.mirror.findAll((n) => n.type === 'svg-text')[0].props.text, 'Sun');
  const heads = env.mirror.findAll((n) => n.type === 'polygon', shapeNodes(env)[2]);
  assert.equal(heads.length, 1, 'one arrowhead');
  assert.match(env.mirror.text(d), /Step 1 of 3.*Light arrives.*Sunlight heads down\..*Back.*Next.*Not to scale\./);
  // step 1: sun + beam shown, beam highlighted; mol and blue (staged later) hidden; the ground is always there
  assert.deepEqual(opacities(env), [0.22, 0.22, 1, 0, 0, 0.22]);
  assert.equal(shapeNodes(env)[3].props.pointerEvents, 'none', 'hidden shapes are not tappable');
  press(env, byLabel(env, 'Next step'));
  assert.deepEqual(opacities(env), [0.22, 0.22, 0.22, 1, 0, 0.22], 'step 2 reveals the molecule and highlights the air part');
  press(env, byLabel(env, 'Next step'));
  assert.deepEqual(opacities(env), [0.22, 0.22, 0.22, 0.22, 1, 0.22]);
  assert.match(env.mirror.text(d), /Step 3 of 3.*Blue scatters.*Start over/);
  press(env, byLabel(env, 'Go to step 1'));
  assert.deepEqual(opacities(env), [0.22, 0.22, 1, 0, 0, 0.22]);
  assert.equal(byLabel(env, 'Previous step').props.disabled, true);
});

test('sandbox: tapping a shape or a chip shows its part; tapping again closes it', () => {
  const env = runProgram(compileWonder(tag({ ...SCENE, steps: undefined })));
  assert.deepEqual(env.errors, []);
  assert.deepEqual(opacities(env), [1, 1, 1, 1, 1, 1], 'no steps: everything visible, nothing dimmed');
  const sun = shapeNodes(env)[0];
  assert.equal(sun.type, 'circle');
  assert.ok(sun.props.onClick, 'the drawing itself is tappable');
  assert.equal(sun.props.ariaHidden, true, 'shapes are pointer-only; the chips are the keyboard controls');
  assert.equal(sun.props.ariaPressed, undefined);
  press(env, sun);
  assert.match(env.mirror.text(catalogNodes(env.mirror, 'DiagramPart')[0]), /^The SunSends white light\.$/);
  assert.deepEqual(opacities(env), [1, 1, 0.22, 0.22, 0.22, 0.22], 'the Sun and its label stay; the rest dims');
  assert.match(env.mirror.text(catalogNodes(env.mirror, 'Diagram')[0]), /Tap the part again to close/);
  // the thin arrow has a wide, invisible, pointer-only hit area
  const hit = catalogNodes(env.mirror, 'DiagramHit')[0];
  assert.equal(hit.props.ariaHidden, true);
  press(env, hit);
  assert.match(env.mirror.text(catalogNodes(env.mirror, 'DiagramPart')[0]), /^SunlightEvery color together\.$/);
  const chip = env.mirror.findAll((n) => n.type === 'button' && env.mirror.text(n) === 'Sunlight')[0];
  assert.equal(chip.props.ariaPressed, true);
  press(env, chip);
  assert.equal(catalogNodes(env.mirror, 'DiagramPart').length, 0);
});

test('sandbox: labels grow on phones so they stay readable', () => {
  const size = (env) => env.mirror.findAll((n) => n.type === 'svg-text')[0].props.fontSize;
  assert.equal(size(runProgram(compileWonder(tag(SCENE)))), 15);
  assert.equal(size(runProgram(compileWonder(tag(SCENE)), { viewportWidth: 390 })), 18.8);
});

test('sky-blue sample: the sunset Diagram is valid, steps through, and the lesson still lints clean', () => {
  const md = sampleLesson('sky-blue.md');
  const out = compileWonder(md, { salt: 'sample' });
  const dg = out.components.find((c) => c.name === 'Diagram');
  assert.equal(dg.status, 'valid');
  const env = runProgram(out);
  assert.deepEqual(env.errors, []);
  assert.equal(catalogNodes(env.mirror, 'Diagram').length, 1);
  assert.match(env.mirror.text(catalogNodes(env.mirror, 'Diagram')[0]), /Step 1 of 3.*Noon/);
  press(env, byLabel(env, 'Next step'));
  assert.match(env.mirror.text(catalogNodes(env.mirror, 'Diagram')[0]), /Step 2 of 3.*Sunset/);
  assert.equal(lintLesson(md).score, 1);
});

test('every streamed prefix of the sky-blue sample keeps Diagram valid or absent', () => {
  const md = sampleLesson('sky-blue.md');
  const start = md.indexOf('<Diagram');
  const stop = md.indexOf('/>', md.indexOf('caption=', start)) + 2;
  for (let i = start - 2; i <= stop + 2; i += 37) {
    const out = compileWonder(md.slice(0, i), { partial: true, salt: 'sample' });
    assert.ok(out.components.filter((c) => c.name === 'Diagram').every((c) => c.status !== 'invalid'), `prefix ${i}`);
    assert.doesNotMatch(out.code, /Diagram title=|shapes=\{/, 'raw tag text never leaks into the program');
    const env = runProgram(out);
    assert.deepEqual(env.errors, [], `prefix ${i}`);
  }
  const env = runProgram(compileWonder(md.slice(0, stop), { partial: true, salt: 'sample' }));
  assert.equal(catalogNodes(env.mirror, 'Diagram').length, 1);
});

test('prompts teach Diagram', () => {
  assert.match(LESSON_SYSTEM_PROMPT, /<Diagram title=/);
  assert.match(LESSON_SYSTEM_PROMPT, /physical or spatial/);
  assert.match(LESSON_SYSTEM_PROMPT, /spatial mechanisms -> Diagram/);
  assert.match(TUTOR_SYSTEM_PROMPT, /<Diagram/);
});
