// Two tabs share one localStorage key. A write must not wipe the other tab's changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, mergeStates, emptyState } from '../public/store.js';

function sharedStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const lesson = (id, extra = {}) => ({ id, title: id, markdown: `# ${id}`, status: 'complete', ...extra });

test('two tabs editing different lessons: both edits survive', () => {
  const storage = sharedStorage();
  const seed = createStore({ storage });
  seed.update((d) => { d.lessons.a = lesson('a'); d.lessons.b = lesson('b'); return d; });
  seed.flush();
  const tab1 = createStore({ storage });
  const tab2 = createStore({ storage });
  tab1.update((d) => { d.lessons.a = { ...d.lessons.a, pageIndex: 3 }; return d; });
  tab2.update((d) => { d.lessons.b = { ...d.lessons.b, status: 'streaming', markdown: '# b\n\npartial' }; return d; });
  tab2.flush();
  tab1.flush(); // writes after tab2: must merge, not overwrite
  const final = createStore({ storage }).data;
  assert.equal(final.lessons.a.pageIndex, 3);
  assert.equal(final.lessons.b.status, 'streaming');
  assert.equal(final.lessons.b.markdown, '# b\n\npartial');
  assert.equal(tab1.data.lessons.b.status, 'streaming', 'the writing tab also sees the other tab\'s change');
});

test('a lesson created in one tab and a lesson deleted in another', () => {
  const storage = sharedStorage();
  const seed = createStore({ storage });
  seed.update((d) => { d.lessons.old = lesson('old'); return d; });
  seed.flush();
  const tab1 = createStore({ storage });
  const tab2 = createStore({ storage });
  tab1.update((d) => { delete d.lessons.old; return d; });
  tab2.update((d) => { d.lessons.fresh = lesson('fresh'); return d; });
  tab1.flush();
  tab2.flush();
  const final = createStore({ storage }).data;
  assert.ok(!('old' in final.lessons), 'delete kept');
  assert.ok('fresh' in final.lessons, 'create kept');
});

test('lists merge by id (teacher threads, plans) and scalars keep the changed side', () => {
  const base = { ...emptyState(), teacherThreads: [{ id: 't1', title: 'one' }], plans: [{ id: 'p1' }], stats: { xp: 10 } };
  const ours = { ...base, teacherThreads: [{ id: 't1', title: 'one (renamed)' }, { id: 't2', title: 'new here' }], stats: { xp: 10 } };
  const theirs = { ...base, teacherThreads: [{ id: 't1', title: 'one' }, { id: 't3', title: 'new there' }], plans: [], stats: { xp: 25 } };
  const m = mergeStates(base, ours, theirs);
  assert.deepEqual(m.teacherThreads.map((t) => t.id).sort(), ['t1', 't2', 't3']);
  assert.equal(m.teacherThreads.find((t) => t.id === 't1').title, 'one (renamed)');
  assert.deepEqual(m.plans, [], 'their delete kept');
  assert.deepEqual(m.stats, { xp: 25 }, 'untouched here: theirs');
});

test('a storage event from another tab refreshes an idle tab', () => {
  const storage = sharedStorage();
  const tab1 = createStore({ storage });
  const tab2 = createStore({ storage });
  let notified = 0;
  tab1.subscribe(() => notified++);
  tab2.update((d) => { d.lessons.x = lesson('x'); return d; });
  tab2.flush();
  tab1._onStorage({ key: 'wonder.v1', newValue: storage.getItem('wonder.v1') });
  assert.ok(tab1.data.lessons.x);
  assert.equal(notified, 1);
});
