// The iOS bundles, run the way JavaScriptCore runs them: a bare context with only the language
// built-ins (no setTimeout, queueMicrotask, console, fetch or modules) plus the `__native` bridge
// that Swift installs. Run: node --test ios/engine/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { bundle, BUNDLES } from '../bundle.mjs';
import { fixtures } from '../fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const W = path.join(repo, 'genui-lab/wonder');
const JS = path.join(repo, 'ios/Wonder/Engine/JS');
const { compileWonder, toWonderDil } = await import(path.join(W, 'server/compile.js'));
const { createMirror } = await import(path.join(repo, 'genui-lab/chatgpt-dil/src/runtime.js'));

/** A JSC-like context: built-ins only, plus a Swift-like bridge. */
function jscContext(file, extra = {}) {
  const posted = [];
  const logs = [];
  const timers = new Map();
  const ctx = vm.createContext({});
  const native = {
    post: (json) => posted.push(JSON.parse(json)),
    setTimer: (id, ms) => { clearTimeout(timers.get(id)); timers.set(id, setTimeout(() => { timers.delete(id); ctx.__wonderFireTimer(id); }, ms)); },
    clearTimer: (id) => { clearTimeout(timers.get(id)); timers.delete(id); },
    log: (level, text) => logs.push([level, text]),
  };
  ctx.__native = native;
  Object.assign(ctx, extra);
  vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), ctx, { filename: file });
  return { ctx, posted, logs, stop: () => { for (const t of timers.values()) clearTimeout(t); } };
}

const lessonDil = (file) => toWonderDil(compileWonder(fs.readFileSync(path.join(W, file), 'utf8')));
const settle = () => new Promise((r) => setTimeout(r, 20));

test('the written bundles match their sources', () => {
  for (const [name, entry] of Object.entries(BUNDLES)) {
    assert.equal(fs.readFileSync(path.join(JS, name), 'utf8'), bundle(entry, name), `${name} is stale: run node ios/engine/bundle.mjs`);
  }
});

test('the iOS unit-test fixtures match the web fixtures they are made from', async () => {
  for (const [name, text] of Object.entries(await fixtures())) {
    assert.equal(fs.readFileSync(path.join(repo, 'ios/WonderTests/Fixtures', name), 'utf8'), text, `${name} is stale: run node ios/engine/fixtures.mjs`);
  }
});

test('engine: a demo lesson renders through the worker protocol', async () => {
  const e = jscContext('wonder-engine.js');
  assert.equal(typeof e.ctx.__native, 'undefined', 'the bridge is hidden from programs');
  const send = (m) => e.ctx.__wonderReceive(JSON.stringify(m));
  const dil = lessonDil('server/demo/transformers.md');
  send({ type: 'init', viewportWidth: 390, binary: false });
  send({ type: 'render', source: dil.code, constants: dil.constants, appData: dil.appData, animated: false, sourceGeneration: 1 });
  await settle();
  const errors = e.posted.filter((m) => m.type === 'error');
  assert.deepEqual(errors, []);
  const mirror = createMirror();
  for (const m of e.posted.filter((x) => x.type === 'ops')) mirror.apply(m.ops);
  const text = mirror.text();
  assert.match(text, /How transformers predict the next word/);
  assert.ok(mirror.nodes.size > 300, `rendered ${mirror.nodes.size} nodes`);

  // tap a KeyTerm: its onClick crosses as {__fn}, comes back as invokeFunction, re-renders
  const key = mirror.findAll((n) => n.props?.__component === 'KeyTerm')[0];
  assert.ok(key?.props.onClick?.__fn, 'KeyTerm has an onClick function id');
  const before = e.posted.length;
  send({ type: 'invokeFunction', fnId: key.props.onClick.__fn, args: [] });
  await settle();
  const later = e.posted.slice(before).filter((m) => m.type === 'ops');
  assert.ok(later.length, 'the tap produced a new op batch');
  for (const m of later) mirror.apply(m.ops);
  assert.equal(mirror.nodes.get(key.id).props.ariaPressed, true);
  e.stop();
});

test('engine: model programs cannot reach the native bridge or the host globals', async () => {
  const e = jscContext('wonder-engine.js');
  const send = (m) => e.ctx.__wonderReceive(JSON.stringify(m));
  send({ type: 'init', viewportWidth: 390, binary: false });
  const probe = 'DIL.render(__dil.jsx("text", null, [typeof __native, typeof fetch, typeof self, typeof postMessage, typeof __wonderReceive === "function" ? "x" : "-"].join(",")));';
  send({ type: 'render', source: probe, constants: {}, appData: {}, animated: false, sourceGeneration: 1 });
  await settle();
  const mirror = createMirror();
  for (const m of e.posted.filter((x) => x.type === 'ops')) mirror.apply(m.ops);
  const [bridge, fetchT, selfT, postT] = mirror.text().split(',');
  assert.deepEqual([bridge, fetchT, selfT, postT], ['undefined', 'undefined', 'undefined', 'undefined']);
  e.stop();
});

test('engine: widget state snapshots come back as viewState messages', async () => {
  const e = jscContext('wonder-engine.js');
  const send = (m) => e.ctx.__wonderReceive(JSON.stringify(m));
  const dil = lessonDil('server/demo/transformers.md');
  send({ type: 'init', viewportWidth: 390, binary: false });
  send({ type: 'render', source: dil.code, constants: dil.constants, appData: dil.appData, sourceGeneration: 1 });
  await settle();
  const mirror = createMirror();
  for (const m of e.posted.filter((x) => x.type === 'ops')) mirror.apply(m.ops);
  const next = mirror.findAll((n) => n.type === 'button' && /Next step/.test(mirror.text(n)))[0];
  send({ type: 'invokeFunction', fnId: next.props.onClick.__fn, args: [] });
  await settle();
  const vs = e.posted.filter((m) => m.type === 'viewState').pop();
  assert.ok(vs?.snapshot?.c && Object.keys(vs.snapshot.c).length, 'a stepper change is reported');
  e.stop();
});

function coreContext(initial = null) {
  const disk = new Map(initial ? [['wonder.v1', initial]] : []);
  let changes = 0;
  const c = jscContext('wonder-core.js', {
    __wonderCoreNative: {
      storageGet: (k) => (disk.has(k) ? disk.get(k) : null),
      storageSet: (k, v) => disk.set(k, v),
      storageRemove: (k) => disk.delete(k),
      changed: () => { changes++; },
    },
  });
  const call = (name, args) => {
    const r = JSON.parse(c.ctx.WonderCore.call(name, JSON.stringify(args ?? {})));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { ...c, call, disk, changes: () => changes };
}

test('core: a recorded Claude lesson stream parses in arbitrary chunks', () => {
  const core = coreContext();
  const raw = fs.readFileSync(path.join(W, 'test/fixtures/claude-lesson-cited.ndjson'), 'utf8');
  const id = core.call('openStream');
  let contents = 0;
  for (let i = 0; i < raw.length; i += 997) contents += core.call('pushStream', { id, text: raw.slice(i, i + 997) }).filter((e) => e.type === 'content').length;
  const done = core.call('finishStream', { id });
  assert.ok(contents > 3);
  assert.equal(done.failure, null);
  assert.match(done.message.markdown, /^# /);
  assert.ok(done.message.dil.code.length > 1000);
  core.stop();
});

test('core: lessons, finishing, review and persistence', async () => {
  const core = coreContext();
  const id = core.call('createLesson', { topic: 'Compound interest', title: 'Compound interest', level: 'beginner' });
  assert.equal(core.call('lessonPhase', { id }), 'new');
  core.call('saveLesson', { id, patch: { status: 'complete', markdown: '# Compound interest\n\nHook.\n\n## Page one\n\nText.', dil: { code: '', constants: {} } } });
  const items = [
    { type: 'flashcard', front: 'Principal', back: 'The starting amount' },
    { type: 'binary_choice', prompt: 'Interest compounds on interest.', answer: true, explanation: 'Yes.' },
  ];
  const filed = core.call('fileCards', { lessonId: id, items });
  assert.equal(filed.added, 2);
  assert.ok(filed.gained >= 50);
  const queue = core.call('reviewQueue', {});
  assert.equal(queue.length, 2);
  const tf = queue.find((e) => e.item.type === 'binary_choice');
  assert.equal(core.call('grade', { item: tf.item, answer: true }).correct, true);
  const rec = core.call('reviewRecord', { entryId: tf.id, rating: 3, correct: true });
  assert.ok(rec.nextDue);
  const today = core.call('today');
  assert.equal(today.recent[0].id, id);
  assert.ok(today.xp >= 55);
  core.call('flush');
  const saved = JSON.parse(core.disk.get('wonder.v1'));
  assert.equal(saved.lessons[id].finished, true);
  assert.ok(core.changes() > 0);
  core.stop();

  // a fresh launch reads the same document back
  const again = coreContext(core.disk.get('wonder.v1'));
  assert.equal(again.call('lesson', { id }).title, 'Compound interest');
  assert.equal(again.call('lessonPhase', { id }), 'complete');
  again.stop();
});

test('core: icons and constants cross the bridge as plain JSON', () => {
  const core = coreContext();
  const icons = core.call('icons');
  assert.ok(Array.isArray(icons['arrow-right']));
  assert.ok(core.call('constants').XP.lessonComplete > 0);
  core.stop();
});
