// The Postgres adapter against a real database. Skipped unless WONDER_TEST_DATABASE_URL points at
// a scratch database (its wonder_* tables are dropped first), so `npm test` needs no database:
//
//   WONDER_TEST_DATABASE_URL=postgres://localhost:5432/wonder_test node --test test/sync-pg.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../public/store.js';
import { createSyncEngine } from '../public/sync-client.js';
import { createSyncService } from '../server/sync/service.js';
import { createPgDb } from '../server/sync/pg-db.js';
import { loadUserMemory, userMaterials } from '../server/sync/user-stores.js';
import { sendDueReminders } from '../server/push.js';

const URL_ = process.env.WONDER_TEST_DATABASE_URL;
const quiet = { warn() {}, error() {}, info() {}, log() {} };

async function fresh() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: URL_, max: 8 });
  await pool.query('DROP TABLE IF EXISTS wonder_records, wonder_users, wonder_push_subscriptions, wonder_reminders_sent, wonder_usage, wonder_files, wonder_plans, wonder_spend');
  const db = createPgDb({ pool });
  return { db, svc: createSyncService({ db }) };
}

function browser(svc, userId) {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const store = createStore({ storage });
  let t = 0;
  const engine = createSyncEngine({ store, storage, userId, logger: quiet, now: () => (t += 1000), post: async (b) => JSON.parse(JSON.stringify(await svc.sync(userId, JSON.parse(JSON.stringify(b))))) });
  return { store, engine, edit: (fn) => store.update((d) => { fn(d); return d; }) };
}

test('postgres: two browsers converge, tombstones travel, users stay apart', { skip: !URL_ && 'set WONDER_TEST_DATABASE_URL' }, async () => {
  const { db, svc } = await fresh();
  try {
    const a = browser(svc, 'alice');
    const b = browser(svc, 'alice');
    a.edit((d) => { d.lessons.l1 = { id: 'l1', title: 'Sky', markdown: 'x'.repeat(2_000_000) }; d.courses.unshift({ id: 'c1', title: 'Physics' }); });
    await a.engine.syncNow();
    await b.engine.syncNow();
    assert.equal(b.store.data.lessons.l1.title, 'Sky');
    b.edit((d) => { d.lessons.l1.title = 'Why the sky is blue'; d.courses = []; });
    await b.engine.syncNow();
    await a.engine.syncNow();
    assert.equal(a.store.data.lessons.l1.title, 'Why the sky is blue');
    assert.deepEqual(a.store.data.courses, []);
    assert.equal(a.engine.pending() + b.engine.pending(), 0);
    assert.deepEqual((await svc.sync('bob', { since: 0 })).records, []);
    a.engine.stop(); b.engine.stop();
  } finally { await db.close(); }
});

test('postgres: concurrent pushes for one user get distinct, gap-free revisions', { skip: !URL_ && 'set WONDER_TEST_DATABASE_URL' }, async () => {
  const { db, svc } = await fresh();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => svc.sync('u', { changes: [{ kind: 'lesson', id: `l${i}`, data: { id: `l${i}` }, baseRev: 0, updatedAt: i + 1 }] })));
    const { records, rev } = await svc.sync('u', { since: 0 });
    assert.deepEqual(records.map((r) => r.rev), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(rev, 12);
    // a stale change merges instead of overwriting blindly
    await svc.sync('u', { changes: [{ kind: 'state', id: 'stats', data: { xp: 5, days: { d1: 5 } }, baseRev: 0, updatedAt: 1 }] });
    const r = await svc.sync('u', { since: 12, changes: [{ kind: 'state', id: 'stats', data: { xp: 3, days: { d2: 3 } }, baseRev: 0, updatedAt: 2 }] });
    assert.deepEqual(r.records.at(-1).data.days, { d1: 5, d2: 3 });
  } finally { await db.close(); }
});

test('postgres: memory, material files, push subscriptions and reminder claims are per user', { skip: !URL_ && 'set WONDER_TEST_DATABASE_URL' }, async () => {
  const { db, svc } = await fresh();
  try {
    const mem = await loadUserMemory(svc, 'alice', { logger: quiet });
    mem.add({ fact: 'Preparing for the statistics exam', kind: 'goal' });
    await mem.flush();
    assert.equal((await loadUserMemory(svc, 'alice')).size, 1);
    assert.equal((await loadUserMemory(svc, 'bob')).size, 0);
    const mats = userMaterials(svc, 'alice');
    const up = await mats.add({ kind: 'pdf', base64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'), filename: 'notes.pdf' });
    assert.ok(up.ok, up.error);
    assert.ok(Buffer.isBuffer(await userMaterials(svc, 'alice').read(up.item.id)));
    assert.equal(await userMaterials(svc, 'bob').read(up.item.id), null);
    assert.equal(await db.getFile('bob', up.item.id), null);
    await db.addSubscription('alice', { endpoint: 'https://push.example.test/1', keys: { p256dh: 'p', auth: 'a' }, timeZone: 'UTC' });
    await db.addSubscription('bob', { endpoint: 'https://push.example.test/1', keys: { p256dh: 'p', auth: 'a' }, timeZone: 'UTC' });
    assert.deepEqual(await db.listSubscriptions('alice'), []);
    assert.equal(await db.removeSubscription('alice', 'https://push.example.test/1'), false);
    assert.equal(await db.claimReminder('bob', '2026-10-22'), true);
    assert.equal(await db.claimReminder('bob', '2026-10-22'), false);
    await svc.sync('carol', { changes: [{ kind: 'state', id: 'settings', data: { dailyGoal: 30, reminder: { enabled: true, time: '09:00' } }, baseRev: 0, updatedAt: 1 }] });
    await db.addSubscription('carol', { endpoint: 'https://push.example.test/2', keys: { p256dh: 'p', auth: 'a' }, timeZone: 'UTC' });
    const sent = [];
    const r = await sendDueReminders({ sync: svc, send: async (s, p) => sent.push([s.endpoint, JSON.parse(p).title]), now: new Date('2026-10-22T10:00:00Z'), logger: quiet });
    assert.equal(r.sent, 1);
    assert.deepEqual(sent, [['https://push.example.test/2', 'Mull']]);
    await (await import('../server/sync/import-local.js')); // loads without a database connection
  } finally { await db.close(); }
});

test('postgres: delete account wipes one user, keeps the revision counter and usage counts', { skip: !URL_ && 'set WONDER_TEST_DATABASE_URL' }, async () => {
  const { db, svc } = await fresh();
  try {
    const put = (u, id) => svc.sync(u, { changes: [{ kind: 'lesson', id, data: { id }, baseRev: 0, updatedAt: 1 }] });
    const { rev } = await put('alice', 'a1');
    await put('bob', 'b1');
    await db.putFile('alice', 'm1', { bytes: Buffer.from('notes'), contentType: 'text/plain' });
    await db.addSubscription('alice', { endpoint: 'https://push.example.test/a', keys: {} });
    await db.useQuota('alice', '2026-10-28', 'lesson', 10);
    await svc.deleteAccount('alice');
    assert.equal(await svc.count('alice'), 0);
    assert.equal(await db.getFile('alice', 'm1'), null);
    assert.deepEqual(await db.listSubscriptions('alice'), []);
    assert.deepEqual(await db.quotaUsed('alice', '2026-10-28'), { lesson: 1 });
    await assert.rejects(svc.sync('alice', { since: rev }), { status: 410 });
    assert.ok((await put('alice', 'a2')).rev > rev, 'revisions keep counting up');
    assert.equal(await svc.count('bob'), 1);
  } finally { await db.close(); }
});

test('postgres: plan records round-trip, an older provider read is dropped, and the plan goes with the account', { skip: !URL_ && 'set WONDER_TEST_DATABASE_URL' }, async () => {
  const { db, svc } = await fresh();
  try {
    assert.equal(await db.getPlan('alice'), null);
    const rec = { plan: 'pro', status: 'active', provider: 'polar', customerId: 'cus_1', subscriptionId: 'sub_1', periodEnd: Date.UTC(2026, 10, 24), cancelAtPeriodEnd: false, syncedAt: 2000 };
    assert.equal(await db.setPlan('alice', rec), true);
    assert.deepEqual(await db.getPlan('alice'), rec);
    assert.equal(await db.setPlan('alice', { ...rec, status: 'canceled', syncedAt: 1000 }), false, 'read before the stored one');
    assert.equal((await db.getPlan('alice')).status, 'active');
    assert.equal(await db.setPlan('alice', { ...rec, cancelAtPeriodEnd: true, periodEnd: null, syncedAt: 3000 }), true);
    assert.deepEqual(await db.getPlan('alice'), { ...rec, cancelAtPeriodEnd: true, periodEnd: null, syncedAt: 3000 });
    assert.equal(await db.setPlan('alice', { ...rec, status: 'trialing', syncedAt: null }), true, 'no stamp: always written');
    assert.equal(await db.getPlan('bob'), null, 'per user');
    await svc.deleteAccount('alice');
    assert.equal(await db.getPlan('alice'), null);
  } finally {
    await db.close();
  }
});
