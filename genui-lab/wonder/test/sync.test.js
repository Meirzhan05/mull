// Account sync: records and merge rules (public/sync-core.js), the server's sync service over the
// in-memory adapter, browsers syncing through it (public/sync-client.js), the first-sign-in
// migration, and tombstones. No network and no database: each "browser" is a store.js store over
// a Map, and its transport calls the service directly (through a JSON round trip).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, emptyState } from '../public/store.js';
import { toRecords, applyRecords, recordsToState, mergeRecord, diffRecords, hashData, recordKey, hasLearnerData } from '../public/sync-core.js';
import { createSyncEngine, BASE_KEY } from '../public/sync-client.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';

const quiet = { warn() {}, error() {}, info() {}, log() {} };

function mapStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

let clock = 1_000;
const tick = () => (clock += 1000);

/** A browser signed in as `userId`: a store over its own storage, synced through `service`. */
function browser(service, userId, { seed = null, first = null } = {}) {
  const storage = mapStorage();
  if (seed) storage.setItem('wonder.v1', JSON.stringify(seed));
  if (first) storage.setItem(BASE_KEY, JSON.stringify({ userId, since: 0, base: [], first }));
  const store = createStore({ storage });
  const firsts = [];
  const engine = createSyncEngine({
    store, storage, userId, logger: quiet, now: tick,
    post: async (body) => JSON.parse(JSON.stringify(await service.sync(userId, JSON.parse(JSON.stringify(body))))),
    onFirstSync: (m) => firsts.push(m),
  });
  return { store, storage, engine, firsts, sync: () => engine.syncNow(), edit: (fn) => store.update((d) => { fn(d); return d; }) };
}

const lesson = (id, title, extra = {}) => ({ id, title, topic: title, markdown: `# ${title}\n\nBody of ${title}.`, updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
const service = () => createSyncService({ db: createMemoryDb() });

test('sync-core: a whole state round-trips through records, lists stay newest first', () => {
  const d = emptyState();
  d.courses = [{ id: 'c2', title: 'Newer' }, { id: 'c1', title: 'Older' }];
  d.lessons = { l1: lesson('l1', 'Sky') };
  d.deck = { items: [{ id: 'e1', item: { id: 'q1' }, card: { due: 'x' } }, { id: 'e2', item: { id: 'q2' }, card: { due: 'y' } }], logs: [{ entryId: 'e1', review: '2026-10-02T00:00:00Z', rating: 3 }, { entryId: 'e1', review: '2026-10-03T00:00:00Z', rating: 4 }] };
  d.mastery = { mean: { label: 'Mean', events: [{ at: '2026-10-01', score: 1, source: 'quiz' }] } };
  d.plans = [{ id: 'p1', goal: 'Exam', days: [] }];
  d.settings = { memoryEnabled: true, dailyGoal: 30 };
  d.stats = { xp: 40, streak: { count: 2, lastDate: '2026-10-02', best: 2 }, days: { '2026-10-02': 40 } };
  d.searchIndex = { built: true }; // a key a later phase adds syncs too
  const records = toRecords(d);
  assert.ok(records.has('lesson:l1') && records.has('card:e2') && records.has('reviewLog:e1@2026-10-03T00:00:00Z') && records.has('concept:mean') && records.has('state:settings') && records.has('state:searchIndex'));
  assert.ok(!records.has('state:version'));
  // in revision order, as the server returns them
  const ordered = [...records.values()].reverse().map((r, i) => ({ ...r, rev: i + 1 }));
  const back = recordsToState(ordered);
  assert.deepEqual(back.lessons, d.lessons);
  assert.deepEqual(back.deck, d.deck.items.length ? { items: d.deck.items.slice().reverse(), logs: d.deck.logs } : d.deck);
  assert.deepEqual(back.settings, d.settings);
  assert.deepEqual(back.searchIndex, d.searchIndex);
  // ... and in creation order (oldest rev first) the lists come back newest first
  const created = [...records.values()].map((r) => ({ ...r, rev: r.kind === 'course' ? (r.id === 'c1' ? 1 : 2) : 10 }));
  assert.deepEqual(recordsToState(created).courses.map((c) => c.id), ['c2', 'c1']);
  assert.ok(hasLearnerData(d) && !hasLearnerData(emptyState()));
});

test('sync-core: diff finds edits, additions and deletions (tombstones) against the base', () => {
  const d = emptyState();
  d.lessons = { a: lesson('a', 'A'), b: lesson('b', 'B') };
  const base = new Map([...toRecords(d)].map(([k, r]) => [k, { rev: 1, h: hashData(r.data) }]));
  assert.equal(diffRecords(base, toRecords(d)).length, 0);
  d.lessons.a.title = 'A2';
  delete d.lessons.b;
  d.lessons.c = lesson('c', 'C');
  const changes = diffRecords(base, toRecords(d), 5);
  const by = Object.fromEntries(changes.map((c) => [recordKey(c.kind, c.id), c]));
  assert.equal(by['lesson:a'].data.title, 'A2');
  assert.equal(by['lesson:a'].baseRev, 1);
  assert.equal(by['lesson:b'].deleted, true);
  assert.equal(by['lesson:c'].baseRev, 0);
  assert.equal(changes.length, 3);
});

test('sync-core: merge rules: last edit wins, deletes too; concepts, XP and settings combine', () => {
  const lww = mergeRecord('lesson', 'a', { data: { t: 1 }, updatedAt: 10 }, { data: { t: 2 }, updatedAt: 5 });
  assert.deepEqual(lww.data, { t: 1 });
  assert.equal(mergeRecord('lesson', 'a', { data: { t: 1 }, updatedAt: 10 }, { deleted: true, updatedAt: 20 }).deleted, true);
  assert.equal(mergeRecord('lesson', 'a', { deleted: true, updatedAt: 20 }, { data: { t: 3 }, updatedAt: 30 }).data.t, 3, 'an edit after the delete brings it back');
  const concept = mergeRecord('concept', 'mean',
    { data: { label: 'Mean', events: [{ at: '1', score: 1, source: 'quiz' }, { at: '2', score: 0, source: 'quiz' }] }, updatedAt: 1 },
    { data: { label: 'Mean', events: [{ at: '1', score: 1, source: 'quiz' }, { at: '3', score: 1, source: 'review' }] }, updatedAt: 2 });
  assert.deepEqual(concept.data.events.map((e) => e.at), ['1', '2', '3']);
  const stats = mergeRecord('state', 'stats',
    { data: { xp: 100, streak: { count: 3, lastDate: '2026-10-03', best: 5 }, days: { d1: 50, d2: 30 } }, updatedAt: 1 },
    { data: { xp: 90, streak: { count: 1, lastDate: '2026-10-02', best: 1 }, days: { d1: 40, d3: 20 } }, updatedAt: 2 });
  assert.deepEqual(stats.data.days, { d1: 50, d2: 30, d3: 20 });
  assert.equal(stats.data.xp, 100);
  assert.equal(stats.data.streak.lastDate, '2026-10-03');
  assert.equal(stats.data.streak.best, 5);
  assert.deepEqual(mergeRecord('state', 'settings', { data: { dailyGoal: 30, name: 'A' }, updatedAt: 2 }, { data: { dailyGoal: 50 }, updatedAt: 1 }).data, { dailyGoal: 30, name: 'A' });
  assert.deepEqual(mergeRecord('state', 'awarded', { data: { x: true }, updatedAt: 1 }, { data: { y: true }, updatedAt: 2 }).data, { x: true, y: true });
});

test('sync: two browsers of one account converge; edits, deletes and tombstones travel', async () => {
  const svc = service();
  const a = browser(svc, 'user-a');
  const b = browser(svc, 'user-a');
  try {
    a.edit((d) => { d.lessons.l1 = lesson('l1', 'Sky'); d.courses.unshift({ id: 'c1', title: 'Physics' }); });
    await a.sync();
    await b.sync();
    assert.equal(b.store.data.lessons.l1.title, 'Sky');
    assert.deepEqual(b.store.data.courses.map((c) => c.id), ['c1']);
    // B edits the lesson, A deletes the course; both sync both ways
    b.edit((d) => { d.lessons.l1.title = 'Why the sky is blue'; });
    a.edit((d) => { d.courses = []; });
    await b.sync();
    await a.sync();
    await b.sync();
    for (const x of [a, b]) {
      assert.equal(x.store.data.lessons.l1.title, 'Why the sky is blue');
      assert.deepEqual(x.store.data.courses, []);
      assert.equal(x.engine.pending(), 0);
    }
    // the tombstone stays on the server: a third browser never sees the course
    const c = browser(svc, 'user-a');
    await c.sync();
    assert.deepEqual(c.store.data.courses, []);
    assert.equal(c.store.data.lessons.l1.title, 'Why the sky is blue');
    c.engine.stop();
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('sync: concurrent edits merge by kind (different records both survive; same record: later edit)', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  const b = browser(svc, 'u');
  try {
    a.edit((d) => { d.lessons.l1 = lesson('l1', 'One'); d.stats = { xp: 10, streak: { count: 1, lastDate: '2026-10-01', best: 1 }, days: { '2026-10-01': 10 } }; });
    await a.sync();
    await b.sync();
    // offline on both: A adds a lesson and earns XP on day 2; B renames l1 and earns XP on day 3
    a.edit((d) => { d.lessons.l2 = lesson('l2', 'Two'); d.stats = { ...d.stats, xp: 30, days: { ...d.stats.days, '2026-10-02': 20 } }; d.lessons.l1.title = 'One (A)'; });
    b.edit((d) => { d.lessons.l1.title = 'One (B)'; d.stats = { ...d.stats, xp: 15, days: { ...d.stats.days, '2026-10-03': 5 } }; });
    await a.sync();
    await b.sync(); // B's edit to l1 is later (its clock ticked after A's)
    await a.sync();
    for (const x of [a, b]) {
      assert.deepEqual(Object.keys(x.store.data.lessons).sort(), ['l1', 'l2']);
      assert.equal(x.store.data.lessons.l1.title, 'One (B)');
      assert.deepEqual(x.store.data.stats.days, { '2026-10-01': 10, '2026-10-02': 20, '2026-10-03': 5 });
      assert.equal(x.engine.pending(), 0);
    }
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('sync: an edit made while a round is in flight is kept and pushed next round', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  const b = browser(svc, 'u');
  try {
    b.edit((d) => { d.lessons.l1 = lesson('l1', 'From B'); });
    await b.sync();
    // A's transport lets the user type while the request is out
    const slow = createSyncEngine({
      store: a.store, storage: a.storage, userId: 'u', logger: quiet, now: tick,
      post: async (body) => {
        const res = JSON.parse(JSON.stringify(await svc.sync('u', JSON.parse(JSON.stringify(body)))));
        a.store.update((d) => { if (d.lessons.l1) d.lessons.l1.title = 'Edited on A mid-flight'; return d; });
        return res;
      },
    });
    a.engine.stop();
    await slow.syncNow(); // pulls l1; the mid-flight edit only applies once l1 exists locally
    a.store.update((d) => { d.lessons.l1.note = 'x'; return d; });
    await slow.syncNow(); // the title changes while this round's request is out
    assert.equal(a.store.data.lessons.l1.title, 'Edited on A mid-flight', 'the server copy did not overwrite it');
    assert.equal(a.store.data.lessons.l1.note, 'x');
    assert.ok(slow.pending() > 0);
    await slow.syncNow(); // ... and goes up on the next round
    assert.equal(slow.pending(), 0);
    slow.stop();
    await b.sync();
    assert.equal(b.store.data.lessons.l1.title, 'Edited on A mid-flight');
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('sync: the same change from two tabs is answered, not re-sent forever', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  const b = browser(svc, 'u');
  try {
    for (const x of [a, b]) x.edit((d) => { d.settings = { ...d.settings, dailyGoal: 50 }; });
    await a.sync();
    await b.sync();
    assert.equal(b.engine.pending(), 0);
    const res = await svc.sync('u', { since: 0, changes: [] });
    const settingsRevs = res.records.filter((r) => r.kind === 'state' && r.id === 'settings');
    assert.equal(settingsRevs.length, 1);
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('sync: large accounts pull in pages under the size limit', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  const b = browser(svc, 'u');
  try {
    const big = 'x'.repeat(900_000);
    a.edit((d) => { for (let i = 0; i < 8; i++) d.lessons[`l${i}`] = lesson(`l${i}`, `L${i}`, { markdown: big }); });
    await a.sync();
    const first = await svc.sync('u', { since: 0, changes: [] });
    assert.equal(first.more, true, 'one response cannot hold 7 MB');
    await b.sync();
    assert.equal(Object.keys(b.store.data.lessons).length, 8);
    assert.equal(b.engine.pending(), 0);
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('migration: the first sign-in uploads this browser\'s data into an empty account', async () => {
  const svc = service();
  const anon = emptyState();
  anon.lessons = { l1: lesson('l1', 'Local lesson') };
  anon.deck = { items: [{ id: 'e1', item: { id: 'q1' }, card: { due: 'z' } }], logs: [] };
  anon.stats = { xp: 70, streak: { count: 1, lastDate: '2026-10-01', best: 1 }, days: { '2026-10-01': 70 } };
  anon.settings = { memoryEnabled: true, name: 'Ada', dailyGoal: 50 };
  const a = browser(svc, 'u', { seed: anon, first: 'merge' });
  try {
    await a.sync();
    assert.deepEqual(a.firsts, ['merge']);
    assert.equal(a.engine.pending(), 0);
    const server = recordsToState(await svc.list('u'));
    assert.equal(server.lessons.l1.title, 'Local lesson');
    assert.equal(server.deck.items.length, 1);
    assert.equal(server.stats.xp, 70);
    assert.equal(server.settings.name, 'Ada');
    assert.equal(await svc.count('u') > 0, true);
  } finally { a.engine.stop(); }
});

test('migration: merging into an account that has data keeps both, account settings first', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  a.edit((d) => { d.lessons.acct = lesson('acct', 'Account lesson'); d.settings = { ...d.settings, name: 'Ada', dailyGoal: 100 }; d.stats = { xp: 100, streak: { count: 4, lastDate: '2026-10-04', best: 4 }, days: { '2026-10-04': 100 } }; });
  await a.sync();
  const anon = emptyState();
  anon.lessons = { mine: lesson('mine', 'Laptop lesson') };
  anon.settings = { memoryEnabled: true, fontScale: 1.2 };
  anon.stats = { xp: 20, streak: { count: 1, lastDate: '2026-10-05', best: 1 }, days: { '2026-10-05': 20 } };
  const b = browser(svc, 'u', { seed: anon, first: 'merge' });
  try {
    await b.sync();
    await a.sync();
    for (const x of [a, b]) {
      assert.deepEqual(Object.keys(x.store.data.lessons).sort(), ['acct', 'mine']);
      assert.equal(x.store.data.settings.name, 'Ada');
      assert.equal(x.store.data.settings.dailyGoal, 100, 'the account keeps its goal');
      assert.equal(x.store.data.settings.fontScale, 1.2, 'fields only this browser had are kept');
      assert.deepEqual(x.store.data.stats.days, { '2026-10-04': 100, '2026-10-05': 20 });
    }
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('migration: declining the merge starts this browser from the account only', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  a.edit((d) => { d.lessons.acct = lesson('acct', 'Account lesson'); });
  await a.sync();
  const b = browser(svc, 'u', { seed: emptyState(), first: 'pull' });
  try {
    await b.sync();
    assert.deepEqual(Object.keys(b.store.data.lessons), ['acct']);
    assert.equal(b.engine.pending(), 0);
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('sync service: one user never reads or overwrites another user\'s records', async () => {
  const svc = service();
  await svc.sync('alice', { changes: [{ kind: 'lesson', id: 'l1', data: lesson('l1', 'Alice private'), baseRev: 0, updatedAt: 1 }] });
  const bob = await svc.sync('bob', { since: 0, changes: [] });
  assert.deepEqual(bob.records, []);
  // same record id from Bob is Bob's own record
  await svc.sync('bob', { changes: [{ kind: 'lesson', id: 'l1', data: lesson('l1', 'Bob'), baseRev: 0, updatedAt: 2 }] });
  const alice = await svc.sync('alice', { since: 0, changes: [] });
  assert.equal(alice.records.find((r) => r.id === 'l1').data.title, 'Alice private');
  await assert.rejects(() => svc.sync(null, {}), (e) => e.status === 401);
  await assert.rejects(() => svc.sync('', {}), (e) => e.status === 401);
  // browsers cannot write server-owned kinds or unknown kinds
  const r = await svc.sync('bob', { changes: [{ kind: 'memory', id: 'm1', data: { fact: 'x' }, baseRev: 0 }, { kind: 'nope', id: 'x', data: {} }] });
  assert.equal(r.rejected.length, 2);
  assert.deepEqual(await svc.list('bob', ['memory']), []);
});

test('sync: an edit during a round still merges with what another device sent meanwhile (XP)', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  const b = browser(svc, 'u');
  try {
    b.edit((d) => { d.stats = { xp: 50, streak: { count: 1, lastDate: '2026-10-01', best: 1 }, days: { '2026-10-01': 50 } }; });
    await b.sync();
    await a.sync();
    b.edit((d) => { d.stats = { ...d.stats, xp: 80, days: { ...d.stats.days, '2026-10-02': 30 } }; });
    await b.sync();
    // A earns XP on day 3 while its round (which brings B's day 2) is out
    const slow = createSyncEngine({
      store: a.store, storage: a.storage, userId: 'u', logger: quiet, now: tick,
      post: async (body) => {
        const res = JSON.parse(JSON.stringify(await svc.sync('u', JSON.parse(JSON.stringify(body)))));
        if (!a.store.data.stats.days['2026-10-03']) a.store.update((d) => { d.stats = { ...d.stats, xp: 60, days: { ...d.stats.days, '2026-10-03': 10 } }; return d; });
        return res;
      },
    });
    a.engine.stop();
    await slow.syncNow();
    await slow.syncNow();
    await b.sync();
    for (const x of [a, b]) assert.deepEqual(x.store.data.stats.days, { '2026-10-01': 50, '2026-10-02': 30, '2026-10-03': 10 });
    slow.stop();
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('migration: a concept both sides have keeps the evidence of both', async () => {
  const svc = service();
  const a = browser(svc, 'u');
  a.edit((d) => { d.mastery.mean = { label: 'Mean', events: [{ at: '2026-10-01', score: 1, source: 'quiz' }] }; });
  await a.sync();
  const anon = emptyState();
  anon.lessons = { l: lesson('l', 'Stats') };
  anon.mastery = { mean: { label: 'Mean', events: [{ at: '2026-10-05', score: 0, source: 'review' }] } };
  const b = browser(svc, 'u', { seed: anon, first: 'merge' });
  try {
    await b.sync();
    await a.sync();
    for (const x of [a, b]) assert.deepEqual(x.store.data.mastery.mean.events.map((e) => e.at), ['2026-10-01', '2026-10-05']);
  } finally { a.engine.stop(); b.engine.stop(); }
});

test('sync: requests stay under the byte limit for non-ASCII lessons', async () => {
  const svc = service();
  const sizes = [];
  const a = browser(svc, 'u');
  a.engine.stop();
  const eng = createSyncEngine({ store: a.store, storage: a.storage, userId: 'u', logger: quiet, now: tick, post: async (body) => { sizes.push(Buffer.byteLength(JSON.stringify(body))); return JSON.parse(JSON.stringify(await svc.sync('u', JSON.parse(JSON.stringify(body))))); } });
  const cjk = '光合作用'.repeat(200_000); // 800k characters, 2.4 MB of UTF-8
  a.edit((d) => { for (let i = 0; i < 3; i++) d.lessons[`l${i}`] = lesson(`l${i}`, `L${i}`, { markdown: cjk }); });
  await eng.syncNow();
  assert.ok(sizes.length >= 3, `${sizes.length} requests`);
  assert.ok(Math.max(...sizes) < 4 * 1024 * 1024, `largest request ${Math.max(...sizes)} bytes`);
  assert.equal(eng.pending(), 0);
  eng.stop();
});
