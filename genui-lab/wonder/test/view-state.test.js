// Widget state persistence (DILStatePersistence-style snapshots, public/view-state.js):
// runtime round-trips, debounce, recompiles, revisions, size caps and store tolerance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWonder } from '../server/compile.js';
import { createLearningRuntime, createMirror } from '../public/learning-runtime.js';
import {
  createViewStateStore, normalizeViewState, capViewState, pruneViewState, propsSignature, jsonSafe,
  MAX_VIEW_STATE_BYTES, MAX_VALUE_BYTES, VIEW_STATE_VERSION,
} from '../public/view-state.js';
import { resolutionIdsOf } from '../public/steering-core.js';
import { createStore } from '../public/store.js';
import { createSourceRegistry, citeComponentResults } from '../server/grounding.js';
import { sampleLesson, catalogNodes } from './helpers.js';

const SALT = 'msg-view-state';
const STEPPER = '<LessonStepper title="Steps" steps={[{"label":"One","text":"First step."},{"label":"Two","text":"Second step."},{"label":"Three","text":"Third step."}]}/>';
const CARDS = '<Flashcards title="Cards" cards={[{"front":"Front A","back":"Back A"},{"front":"Front B","back":"Back B"},{"front":"Front C","back":"Back C"}]}/>';
const GRAPH = '<FunctionGraph title="Lines" fn="a*x" params={[{"name":"a","min":0,"max":4,"step":1,"value":1}]} xRange={[0,5]} yRange={[0,20]}/>';
const REVEAL = '<Reveal title="Guess" items={[{"label":"Why A?","content":"Because A."},{"label":"Why B?","content":"Because B."}]}/>';
const COMPARE = '<CompareToggle title="AB" left={{"label":"Left side","points":["l1"]}} right={{"label":"Right side","points":["r1"]}}/>';
const SLIDER = '<InputOutputSlider title="Dial" inputLabel="Input" outputLabel="Output" stops={[{"value":1,"output":"Out one"},{"value":2,"output":"Out two"},{"value":3,"output":"Out three"}]}/>';
const QUIZ = '<Quiz title="Quick check" questions={[{"id":"q1","prompt":"Pick A","question_type":"single_select","options":[{"value":"a","label":"Alpha"},{"value":"b","label":"Beta"}],"correct_values":["a"],"explanation":"A it is."},{"id":"q2","prompt":"Pick B","question_type":"single_select","options":[{"value":"a","label":"Alpha"},{"value":"b","label":"Beta"}],"correct_values":["b"],"explanation":"B it is."}]}/>';
const LESSON = ['# Saved widgets', '', 'Intro.', '', STEPPER, '', CARDS, '', GRAPH, '', REVEAL, '', COMPARE, '', SLIDER, '', QUIZ, ''].join('\n');

const program = (md = LESSON, opts = {}) => {
  const r = compileWonder(md, { salt: SALT, ...opts });
  assert.deepEqual(r.components.filter((c) => c.status !== 'valid').map((c) => c.name), []);
  return r;
};

/** A runtime like the worker's, with a mirror, captured snapshots and (by default) no debounce. */
function mount(prog, { viewState, debounce = 0, width = 800, appData = {} } = {}) {
  const mirror = createMirror();
  const errors = [];
  const actions = [];
  const snaps = [];
  const rt = createLearningRuntime({
    viewportWidth: width,
    onOps: (ops) => mirror.apply(ops),
    onError: (e) => errors.push(e),
    onHostAction: (a) => actions.push(a),
    schedule: (fn) => fn(),
    viewState,
    viewStateDebounceMs: debounce,
    onViewState: (s) => snaps.push(s),
  });
  const env = { rt, mirror, errors, actions, snaps, prog };
  env.render = (p = env.prog, ad = appData) => { env.prog = p; rt.render({ source: p.code, constants: p.constants, appData: ad }); };
  env.render(prog);
  env.last = () => snaps[snaps.length - 1];
  return env;
}

function clickIn(env, root, label) {
  const nodes = env.mirror.findAll((n) => n.props?.onClick && env.mirror.text(n).includes(label), root);
  assert.ok(nodes.length, `no clickable "${label}"`);
  const r = env.rt.invokeFunction(nodes[nodes.length - 1].props.onClick.__fn, []);
  assert.ok(r.ok, r.error);
}
const clickAria = (env, root, aria) => {
  const n = env.mirror.findAll((x) => x.props?.onClick && x.props.ariaLabel === aria, root)[0];
  assert.ok(n, `no clickable [aria-label="${aria}"]`);
  assert.ok(env.rt.invokeFunction(n.props.onClick.__fn, []).ok);
};
const card = (env, name) => catalogNodes(env.mirror, name)[0];
const text = (env, name) => env.mirror.text(card(env, name));

/** Interact with every persisted widget once; returns the resulting snapshot. */
function interactAll(env) {
  clickIn(env, card(env, 'LessonStepper'), 'Next step');
  clickIn(env, card(env, 'LessonStepper'), 'Next step');
  clickIn(env, card(env, 'Flashcards'), 'Next');
  clickAria(env, card(env, 'Flashcards'), 'Flip card');
  clickAria(env, card(env, 'FunctionGraph'), 'Increase a');
  clickAria(env, card(env, 'FunctionGraph'), 'Increase a');
  clickIn(env, card(env, 'Reveal'), 'Why B?');
  clickIn(env, card(env, 'CompareToggle'), 'Right side');
  clickIn(env, card(env, 'InputOutputSlider'), '3');
  clickIn(env, card(env, 'Quiz'), 'Alpha');
  return env.last();
}

function assertRestored(env) {
  assert.match(text(env, 'LessonStepper'), /3 \/ 3.*Three.*Third step/);
  assert.match(text(env, 'Flashcards'), /2 \/ 3.*ANSWER.*Back B/);
  assert.match(text(env, 'FunctionGraph'), /a = 3/);
  assert.match(text(env, 'Reveal'), /Because B\./);
  assert.doesNotMatch(text(env, 'Reveal'), /Because A\./);
  assert.match(text(env, 'CompareToggle'), /r1/);
  assert.doesNotMatch(text(env, 'CompareToggle'), /l1/);
  assert.match(text(env, 'InputOutputSlider'), /Out three/);
  assert.match(text(env, 'Quiz'), /Correct!.*A it is\./);
}

test('render with a snapshot: every persisted widget mounts in its saved state (first frame)', () => {
  const prog = program();
  const a = mount(prog);
  const snap = interactAll(a);
  assert.equal(snap.v, VIEW_STATE_VERSION);
  assert.equal(Object.keys(snap.c).length, 7, 'one entry per persisted widget');
  assertRestored(a);

  // "reload": a fresh runtime gets the snapshot before its first render
  const b = mount(prog, { viewState: JSON.parse(JSON.stringify(snap)) });
  assert.deepEqual(b.errors, []);
  assertRestored(b);
  assert.equal(b.snaps.length, 0, 'restoring does not write the snapshot back');

  // setStateSnapshot after construction (the worker's message path) works the same
  const m = createMirror();
  const e = createLearningRuntime({ onOps: (ops) => m.apply(ops), schedule: (fn) => fn() });
  e.setStateSnapshot(snap);
  e.render({ source: prog.code, constants: prog.constants, appData: {} });
  assert.match(m.text(m.findAll((n) => n.props?.__component === 'LessonStepper')[0]), /3 \/ 3/);
  assert.match(text(mount(prog), 'LessonStepper'), /1 \/ 3/, 'no snapshot: initial state');
});

test('interaction posts one debounced snapshot (~300 ms) per burst', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = mount(program(), { debounce: 300 });
  clickIn(env, card(env, 'LessonStepper'), 'Next step');
  clickIn(env, card(env, 'LessonStepper'), 'Next step');
  clickAria(env, card(env, 'FunctionGraph'), 'Increase a');
  assert.equal(env.snaps.length, 0, 'nothing posted inside the debounce window');
  t.mock.timers.tick(299);
  assert.equal(env.snaps.length, 0);
  t.mock.timers.tick(2);
  assert.equal(env.snaps.length, 1, 'one message for the burst');
  const values = Object.values(env.last().c).map((e) => e.s);
  assert.ok(values.some((s) => s.i === 2), 'stepper index 2');
  assert.ok(values.some((s) => s.params?.a === 2), 'graph a = 2');
  clickIn(env, card(env, 'LessonStepper'), 'Back');
  env.rt.flushViewState();
  assert.equal(env.snaps.length, 2, 'flush delivers a pending change immediately');
  env.rt.destroy();
});

test('streaming recompiles keep live state and the snapshot; later widgets read theirs on mount', () => {
  const full = program();
  const a = mount(full);
  const snap = interactAll(a);
  // reload mid-stream: the first revision only has the stepper; later revisions add the rest
  const upTo = LESSON.indexOf(CARDS);
  const partial = program(LESSON.slice(0, upTo), { partial: true });
  const b = mount(partial, { viewState: snap });
  assert.match(text(b, 'LessonStepper'), /3 \/ 3/);
  clickIn(b, card(b, 'LessonStepper'), 'Back');
  assert.match(text(b, 'LessonStepper'), /2 \/ 3/);
  b.render(program(LESSON.slice(0, LESSON.indexOf(REVEAL)), { partial: true }));
  b.render(full);
  assert.deepEqual(b.errors, []);
  assert.match(text(b, 'LessonStepper'), /2 \/ 3/, 'live state survives recompiles (not re-read)');
  assert.match(text(b, 'Flashcards'), /2 \/ 3.*Back B/, 'widgets that mount later start from the snapshot');
  assert.match(text(b, 'Quiz'), /Correct!/);
  const stepperRid = resolutionIdsOf({ code: partial.code, constants: partial.constants });
  assert.equal(stepperRid.size, 1);
  assert.equal(b.last().c[[...stepperRid][0]].s.i, 1);
});

test('unknown keys, foreign ids and invalid values are ignored', () => {
  const prog = program();
  const a = mount(prog);
  const snap = interactAll(a);
  const ids = Object.keys(snap.c);
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.c['not-a-widget'] = { h: 'x', t: 1, s: { i: 2 } };
  for (const id of ids) {
    const e = tampered.c[id];
    if ('i' in e.s) e.s.i = 'two'; // wrong type
    if ('card' in e.s) e.s.card = { i: 99, flipped: 'yes' }; // out of range
    if ('params' in e.s) e.s.params = { a: 'big', zz: 3 }; // NaN + unknown param
    if ('open' in e.s) e.s.open = { 0: true, 7: true, x: 'y' }; // 7 out of range -> only item 0
    if ('view' in e.s) e.s.view = 'diagonal';
    if ('quiz' in e.s) e.s.quiz = 'nope';
    e.s.unknownKey = { deep: [1, 2, 3] };
  }
  const b = mount(prog, { viewState: tampered });
  assert.deepEqual(b.errors, []);
  assert.match(text(b, 'LessonStepper'), /1 \/ 3/);
  assert.match(text(b, 'Flashcards'), /1 \/ 3.*PROMPT/);
  assert.match(text(b, 'FunctionGraph'), /a = 1/);
  assert.match(text(b, 'Reveal'), /Because A\./, 'valid part of the open set kept');
  assert.doesNotMatch(text(b, 'Reveal'), /Because B\./);
  assert.match(text(b, 'CompareToggle'), /l1/);
  assert.doesNotMatch(text(b, 'Quiz'), /Correct!/);

  // garbage snapshots of every shape: initial state, no throw
  for (const junk of [null, 42, 'not json', '{"v":1,"c":[1,2]}', { v: 2, c: {} }, { v: 1, c: { a: null, b: { h: 1 } } }, { v: 1, c: { x: { h: 'q', s: [] } } }]) {
    const env = mount(prog, { viewState: junk });
    assert.deepEqual(env.errors, [], JSON.stringify(junk));
    assert.match(text(env, 'LessonStepper'), /1 \/ 3/);
  }
});

test('a widget rewritten by a revision (same id, other props) starts fresh; unchanged ones keep state', () => {
  const prog = program();
  const a = mount(prog);
  const snap = interactAll(a);
  // revise: the stepper text changed and the flashcards were removed, same messageId salt
  const revisedMd = LESSON.replace('Second step.', 'A rewritten second step.').replace(CARDS, '');
  const revised = program(revisedMd);
  const b = mount(revised, { viewState: snap });
  assert.match(text(b, 'LessonStepper'), /1 \/ 3/, 'changed props: saved state ignored');
  assert.match(text(b, 'FunctionGraph'), /a = 3/, 'unchanged widget keeps its state');
  assert.match(text(b, 'Quiz'), /Correct!/);
  // the app prunes to the ids of the final program after a continuation
  b.rt.pruneViewState(resolutionIdsOf(revised));
  b.rt.flushViewState();
  const pruned = b.last();
  assert.equal(Object.keys(pruned.c).length, 5, 'stepper (rewritten) and flashcards (removed) dropped');

  // in-place revision in a live runtime: prune uses the live props signature
  const c = mount(prog, { viewState: snap });
  c.render(revised);
  c.rt.pruneViewState(resolutionIdsOf(revised));
  c.rt.flushViewState();
  assert.equal(Object.keys(c.last().c).length, 5);
  // pure helper agrees
  assert.equal(Object.keys(pruneViewState(snap, resolutionIdsOf(revised)).c).length, 6, 'id-only prune keeps the rewritten stepper (its hash is checked on read)');
});

test('reset clears every saved widget and remounts fresh', () => {
  const prog = program();
  const a = mount(prog);
  interactAll(a);
  a.rt.resetViewState();
  assert.deepEqual(a.last(), { v: VIEW_STATE_VERSION, c: {} });
  assert.match(text(a, 'LessonStepper'), /1 \/ 3/);
  assert.match(text(a, 'FunctionGraph'), /a = 1/);
  assert.match(text(a, 'Flashcards'), /1 \/ 3.*PROMPT/);
  assert.deepEqual(a.errors, []);
});

test('server-graded Quiz componentResults win over local progress', () => {
  const prog = program(['# Q', '', QUIZ].join('\n'));
  const a = mount(prog);
  clickIn(a, card(a, 'Quiz'), 'Beta'); // wrong answer to q1, saved locally
  const snap = a.last();
  const [rid] = resolutionIdsOf(prog);
  const server = { opGenui: { componentResults: { [rid]: { status: 'resolved', state: { attempt: 0, answers: { q1: { selected_values: ['a'], is_correct: true } } } } } } };
  const b = mount(prog, { viewState: snap, appData: server });
  assert.match(text(b, 'Quiz'), /2 of 2.*Pick B/, 'server answers decide where the quiz resumes');
  const c = mount(prog, { viewState: snap });
  assert.match(text(c, 'Quiz'), /Not quite/, 'no server state: local progress restored');
  assert.equal(a.actions.filter((x) => x.handler === 'server').length, 1, 'the answer still went to the server');
});

test('Cite popover is ephemeral; KeyTerm and other selections are not persisted', () => {
  const reg = createSourceRegistry();
  const ref = reg.cite({ url: 'https://en.wikipedia.org/wiki/Compound_interest', title: 'Compound interest', cited_text: 'Interest on interest.' });
  const md = `Interest grows<KeyTerm term="principal" definition="The starting amount."/> fast<Cite refs={["${ref}"]}/>.\n\n${STEPPER}\n`;
  const prog = program(md);
  const appData = { opGenui: { componentResults: citeComponentResults(prog, reg) } };
  const env = mount(prog, { appData });
  const pill = catalogNodes(env.mirror, 'Cite')[0];
  assert.ok(pill, 'cite pill rendered');
  env.rt.invokeFunction(pill.props.onClick.__fn, []);
  assert.equal(catalogNodes(env.mirror, 'CiteCard').length, 1, 'popover open');
  clickIn(env, env.mirror.root, 'principal');
  assert.equal(env.snaps.length, 0, 'Cite / KeyTerm interactions write nothing');
  clickIn(env, card(env, 'LessonStepper'), 'Next step');
  const b = mount(prog, { appData, viewState: env.last() });
  assert.equal(catalogNodes(b.mirror, 'CiteCard').length, 0, 'popover starts closed after a reload');
  assert.match(text(b, 'LessonStepper'), /2 \/ 3/);
});

test('FunctionGraph slider value round-trips through a snapshot (compound-interest sample)', () => {
  const prog = compileWonder(sampleLesson('compound-interest.md'), { salt: SALT });
  const a = mount(prog);
  const graph = () => card(a, 'FunctionGraph');
  assert.match(a.mirror.text(graph()), /r = 0\.07/);
  clickAria(a, graph(), 'Decrease r');
  clickAria(a, graph(), 'Decrease r');
  assert.match(a.mirror.text(graph()), /r = 0\.05/);
  const snap = JSON.parse(JSON.stringify(a.last()));
  const b = mount(prog, { viewState: snap });
  const g = card(b, 'FunctionGraph');
  assert.match(b.mirror.text(g), /r = 0\.05/);
  assert.match(b.mirror.text(g), /1000·\(1\+0\.05\)\^x/, 'formula uses the restored value');
  assert.ok(b.mirror.findAll((n) => n.props?.ariaLabel === 'Set r to 0.05' && n.props.ariaPressed === true, g).length, 'track shows the restored stop');
  assert.ok(b.mirror.findAll((n) => n.props?.onClick && b.mirror.text(n) === 'Reset', g).length, 'Reset (changed) button shown');
  // the sample's flashcards and stepper round-trip too
  clickIn(b, card(b, 'Flashcards'), 'Next');
  clickAria(b, card(b, 'Flashcards'), 'Flip card');
  clickIn(b, card(b, 'LessonStepper'), 'Next step');
  const c = mount(prog, { viewState: b.last() });
  assert.match(c.mirror.text(card(c, 'Flashcards')), /2 \/ 4.*ANSWER/);
  assert.match(c.mirror.text(card(c, 'LessonStepper')), /2 \/ /);
  assert.match(c.mirror.text(card(c, 'FunctionGraph')), /r = 0\.05/);
  assert.deepEqual(c.errors, []);
});

test('LessonStepper and Flashcards round-trip at phone width; CompareToggle "both" falls back on mobile', () => {
  const prog = program();
  const a = mount(prog, { width: 1024 });
  clickIn(a, card(a, 'CompareToggle'), 'Side by side');
  clickIn(a, card(a, 'LessonStepper'), 'Next step');
  clickIn(a, card(a, 'Flashcards'), 'Next');
  clickIn(a, card(a, 'Flashcards'), 'Next');
  const b = mount(prog, { viewState: a.last(), width: 390 });
  assert.match(text(b, 'LessonStepper'), /2 \/ 3.*Second step/);
  assert.match(text(b, 'Flashcards'), /3 \/ 3.*Front C/);
  assert.match(text(b, 'CompareToggle'), /l1/);
  assert.doesNotMatch(text(b, 'CompareToggle'), /r1/, 'no side-by-side on phones');
  const c = mount(prog, { viewState: a.last(), width: 1024 });
  assert.match(text(c, 'CompareToggle'), /l1.*r1/);
});

test('size caps: oversize values are refused, snapshots are evicted oldest-first under the cap', () => {
  const props = (rid) => ({ __resolutionId: rid, title: rid });
  const out = [];
  const store = createViewStateStore({ debounceMs: 0, onChange: (s) => out.push(s), maxBytes: 2000 });
  assert.equal(store.api.write(props('big'), 'k', 'x'.repeat(MAX_VALUE_BYTES + 1)), false, 'value over the per-key cap');
  assert.equal(store.api.write(props('fn'), 'k', () => 1), false, 'functions are not JSON');
  assert.equal(store.api.write(props('nan'), 'k', { a: NaN }), false);
  assert.equal(store.api.write({ title: 'no id' }, 'k', 1), false, 'no resolution id: not persisted');
  for (let i = 0; i < 40; i++) store.api.write(props(`w${i}`), 'v', 'y'.repeat(80));
  const snap = out[out.length - 1];
  assert.ok(JSON.stringify(snap).length <= 2000, `capped at ${JSON.stringify(snap).length}`);
  assert.ok(snap.c.w39 && !snap.c.w0, 'newest kept, oldest evicted');
  assert.equal(MAX_VIEW_STATE_BYTES, 50_000);
  const huge = { v: 1, c: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`r${i}`, { h: 'h', t: i, s: { v: 'z'.repeat(300) } }])) };
  const capped = capViewState(normalizeViewState(huge));
  assert.ok(JSON.stringify(capped).length <= MAX_VIEW_STATE_BYTES);
  assert.ok(capped.c.r299 && !capped.c.r0);
  assert.deepEqual(jsonSafe({ a: [1, 'b', null, true], u: undefined }), { a: [1, 'b', null, true] });
  assert.equal(jsonSafe(new Date()), undefined);
  assert.equal(propsSignature({ a: 1, __resolutionId: 'x', children: 'c' }), propsSignature({ a: 1, __resolutionId: 'y' }));
  assert.notEqual(propsSignature({ a: 1 }), propsSignature({ a: 2 }));
});

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
}

test('store persists viewState with lessons, tutor and Teacher messages, and tolerates corruption', () => {
  const prog = program();
  const a = mount(prog);
  const snap = interactAll(a);
  const storage = memStorage();
  const s1 = createStore({ storage });
  s1.update((d) => {
    d.lessons.l1 = { id: 'l1', status: 'complete', dil: { code: prog.code, constants: prog.constants }, viewState: snap, tutor: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', viewState: snap }] };
    d.teacherThreads = [{ id: 't1', messages: [{ role: 'assistant', content: 'x', viewState: snap }] }];
    return d;
  });
  s1.flush();
  const s2 = createStore({ storage });
  assert.deepEqual(s2.data.lessons.l1.viewState, snap);
  assert.deepEqual(s2.data.lessons.l1.tutor[1].viewState, snap);
  assert.deepEqual(s2.data.teacherThreads[0].messages[0].viewState, snap);
  const b = mount(prog, { viewState: s2.data.lessons.l1.viewState });
  assertRestored(b);

  // corrupted snapshots are dropped on load; the lessons themselves survive
  const raw = JSON.parse(storage.getItem('wonder.v1'));
  raw.lessons.l1.viewState = '{{{ not json';
  raw.lessons.l1.tutor[1].viewState = { v: 1, c: { r: { h: 'h', t: 1, s: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } } } };
  raw.lessons.l2 = { id: 'l2', status: 'complete', viewState: { v: 1, c: { ok: { h: 'h', t: 1, s: { i: 2, bad: 'x'.repeat(MAX_VALUE_BYTES + 10) } } } } };
  raw.teacherThreads[0].messages[0].viewState = 7;
  storage.setItem('wonder.v1', JSON.stringify(raw));
  const s3 = createStore({ storage });
  assert.equal(s3.data.lessons.l1.status, 'complete');
  assert.equal('viewState' in s3.data.lessons.l1, false);
  assert.equal('viewState' in s3.data.lessons.l1.tutor[1], false, 'too deep: dropped');
  assert.deepEqual(s3.data.lessons.l2.viewState.c.ok.s, { i: 2 }, 'valid keys kept, oversize key dropped');
  assert.equal('viewState' in s3.data.teacherThreads[0].messages[0], false);
  // a corrupted snapshot still renders the lesson in its initial state
  const c = mount(prog, { viewState: raw.lessons.l1.viewState });
  assert.deepEqual(c.errors, []);
  assert.match(text(c, 'LessonStepper'), /1 \/ 3/);
});
