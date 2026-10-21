// A widget change made just before a hard reload must not be lost. The worker reports every
// change immediately (viewStateDebounceMs: 0, as wonder-worker.js configures it); the store
// batches writes and flushes them synchronously on pagehide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWonder } from '../server/compile.js';
import { createLearningRuntime, createMirror } from '../public/learning-runtime.js';
import { createStore } from '../public/store.js';
import { click } from './helpers.js';

const LESSON = `# Steps\n\n<LessonStepper title="Make tea" steps={[{"label":"Boil","text":"Heat water."},{"label":"Steep","text":"Wait."},{"label":"Pour","text":"Enjoy."}]}/>\n`;

test('worker setting: an interaction produces a snapshot synchronously (no timer pending)', () => {
  const snapshots = [];
  const mirror = createMirror();
  const rt = createLearningRuntime({
    viewportWidth: 800, viewStateDebounceMs: 0, schedule: (fn) => fn(),
    onOps: (ops) => mirror.apply(ops), onError: (e) => { throw new Error(JSON.stringify(e)); }, onHostAction: () => {},
    onViewState: (s) => snapshots.push(s),
  });
  const prog = compileWonder(LESSON, { salt: 'reload' });
  rt.render({ source: prog.code, constants: prog.constants, appData: {} });
  click({ rt, mirror }, 'Next step');
  assert.equal(snapshots.length, 1, 'delivered right away, not after 300 ms');
});

test('store: a change saved right before pagehide is written by flush()', () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const store = createStore({ storage });
  store.update((d) => { d.lessons.l1 = { id: 'l1', title: 't', markdown: '# t', status: 'complete', pageIndex: 2 }; return d; });
  store.flush(); // what the pagehide handler does
  assert.equal(JSON.parse(m.get('wonder.v1')).lessons.l1.pageIndex, 2);
});
