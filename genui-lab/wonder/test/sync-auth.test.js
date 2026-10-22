// Account sync over HTTP: per-user authorization on every endpoint (sync, memory, material, push),
// signed-out behaviour on a server with accounts, and a static check that every Postgres
// statement touching learner data is scoped to one user. Auth is faked with a test header that
// only these servers read (createWonderServer's getUserId); the real one is Clerk (server/auth.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { syncConfig } from '../server/sync/index.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const NOTES = '# Photosynthesis\n\nPlants turn light, water and carbon dioxide into glucose and oxygen. The light reactions happen in the thylakoids.';

async function withServer(opts, fn) {
  const sync = createSyncService({ db: createMemoryDb() });
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null }), sync, push: null, getUserId: (req) => req.headers['x-test-user'] || null, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user) => async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { 'x-test-user': user } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
  try { return await fn({ alice: as('alice'), bob: as('bob'), anon: as(null), sync, server }); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('sync config: off unless both an auth provider and a database are configured', () => {
  assert.equal(syncConfig({}).enabled, false);
  assert.equal(syncConfig({ DATABASE_URL: 'postgres://x' }).enabled, false, 'no accounts without auth');
  const clerk = { CLERK_SECRET_KEY: 'sk', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk' };
  assert.equal(syncConfig(clerk).enabled, false, 'no database');
  assert.equal(syncConfig({ CLERK_SECRET_KEY: 'sk', DATABASE_URL: 'postgres://x' }).enabled, false, 'no way to sign in without the publishable key');
  assert.deepEqual(syncConfig({ ...clerk, DATABASE_URL: 'postgres://x' }), { enabled: true, auth: 'clerk', db: 'postgres' });
  assert.equal(syncConfig({ ...clerk, WONDER_SYNC_DB: 'memory' }).db, 'memory');
});

test('account sync over HTTP: /api/sync is per user; signed out is 401; a stale account cache is refused', async () => {
  await withServer({}, async ({ alice, bob, anon }) => {
    assert.deepEqual((await anon('GET', '/api/account')).body, { ok: true, sync: true, signedIn: false, push: null });
    assert.equal((await anon('POST', '/api/sync', { since: 0, changes: [] })).status, 401);
    const put = await alice('POST', '/api/sync', { userId: 'alice', since: 0, changes: [{ kind: 'lesson', id: 'l1', data: { id: 'l1', title: 'Alice only' }, baseRev: 0, updatedAt: 1 }] });
    assert.equal(put.status, 200);
    assert.equal(put.body.records[0].data.title, 'Alice only');
    const acct = (await alice('GET', '/api/account')).body;
    assert.equal(acct.signedIn, true);
    assert.equal(acct.userId, 'alice');
    assert.equal(acct.records, 1);
    const peek = await bob('POST', '/api/sync', { since: 0, changes: [] });
    assert.deepEqual(peek.body.records, [], 'Bob sees none of Alice\'s records');
    // Bob's browser still holding Alice's cache (she signed out, he signed in elsewhere) must not upload it
    const stale = await bob('POST', '/api/sync', { userId: 'alice', since: 0, changes: [{ kind: 'lesson', id: 'l2', data: { id: 'l2' }, baseRev: 0 }] });
    assert.equal(stale.status, 409);
    assert.equal((await bob('POST', '/api/sync', { since: 0, changes: [] })).body.records.length, 0);
  });
});

test('account sync over HTTP: learner memory belongs to the signed-in user', async () => {
  await withServer({}, async ({ alice, bob, anon, sync }) => {
    const add = await alice('POST', '/api/memory', { fact: 'Preparing for the statistics exam in May', kind: 'goal' });
    assert.equal(add.status, 200);
    const id = add.body.item.id;
    assert.equal((await alice('GET', '/api/memory')).body.items.length, 1);
    assert.deepEqual((await bob('GET', '/api/memory')).body.items, []);
    assert.deepEqual((await anon('GET', '/api/memory')).body.items, [], 'signed out: no shared memory');
    assert.equal((await anon('POST', '/api/memory', { fact: 'x y z w', kind: 'goal' })).status, 401);
    // Bob cannot delete Alice's item by id
    assert.equal((await bob('DELETE', `/api/memory?id=${id}`, { id })).status, 404);
    assert.equal((await alice('GET', '/api/memory')).body.items.length, 1);
    // stored as a server-only record: never sent to browsers by /api/sync
    assert.equal((await sync.list('alice', ['memory'])).length, 1);
    assert.deepEqual((await alice('POST', '/api/sync', { since: 0, changes: [] })).body.records, []);
    // the Teacher / lesson prompts read the same per-user memory (the lesson route loads it)
    const lesson = await alice('POST', '/api/lesson/stream', { topic: 'Why the sky is blue' });
    assert.equal(lesson.status, 200);
    assert.equal((await alice('DELETE', `/api/memory?id=${id}`, { id })).status, 200);
    assert.deepEqual((await sync.list('alice', ['memory'])), []);
  });
});

test('account sync over HTTP: material and its file are readable only by their owner', async () => {
  await withServer({}, async ({ alice, bob, anon }) => {
    const up = await alice('POST', '/api/materials', { kind: 'text', text: NOTES });
    assert.equal(up.status, 200, up.text);
    const id = up.body.item.id;
    assert.equal((await alice('GET', `/api/materials/file?id=${id}`)).text, NOTES);
    assert.equal((await bob('GET', `/api/materials/file?id=${id}`)).status, 404);
    assert.equal((await anon('GET', `/api/materials/file?id=${id}`)).status, 401);
    assert.deepEqual((await bob('GET', '/api/materials')).body.items, []);
    assert.equal((await bob('DELETE', `/api/materials?id=${id}`, { id })).status, 404);
    // a lesson from someone else's material id is "missing", not served
    assert.equal((await bob('POST', '/api/lesson/stream', { topic: 'Photosynthesis', materialId: id })).status, 404);
    const lesson = await alice('POST', '/api/lesson/stream', { topic: 'Photosynthesis', materialId: id });
    assert.equal(lesson.status, 200);
    assert.equal((await alice('DELETE', `/api/materials?id=${id}`, { id })).status, 200);
    assert.equal((await alice('GET', `/api/materials/file?id=${id}`)).status, 404);
  });
});

test('push subscriptions are per user, validated, and move with the browser', async () => {
  const push = { publicKey: 'BPUB', privateKey: 'secret', subject: 'mailto:a@b.c' };
  await withServer({ push }, async ({ alice, bob, anon, sync }) => {
    const acct = (await anon('GET', '/api/account')).body;
    assert.deepEqual(acct.push, { publicKey: 'BPUB' }, 'only the public key reaches a browser');
    assert.ok(!JSON.stringify(acct).includes('secret'));
    const subscription = { endpoint: 'https://push.example.test/send/abc123', keys: { p256dh: 'p', auth: 'a' } };
    assert.equal((await anon('POST', '/api/push/subscribe', { subscription })).status, 401);
    assert.equal((await alice('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure/x', keys: {} } })).status, 400);
    assert.equal((await alice('POST', '/api/push/subscribe', { subscription, timeZone: 'Europe/Berlin' })).status, 200);
    assert.equal((await sync.db.listSubscriptions('alice'))[0].timeZone, 'Europe/Berlin');
    // Bob cannot remove Alice's subscription
    assert.equal((await bob('DELETE', '/api/push/subscribe', { endpoint: subscription.endpoint })).body.removed, false);
    // the same browser signs in as Bob: Alice stops sending to it
    await bob('POST', '/api/push/subscribe', { subscription, timeZone: 'Europe/Berlin' });
    assert.equal((await sync.db.listSubscriptions('alice')).length, 0);
    assert.equal((await sync.db.listSubscriptions('bob')).length, 1);
  });
});

test('without account sync the server behaves exactly as before (no accounts, local memory)', async () => {
  const memory = createMemoryStore({ file: null });
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memory, getUserId: () => 'ignored' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await fetch(`${base}/api/account`).then((r) => r.json()), { ok: true, sync: false, signedIn: false, push: null });
    assert.equal((await fetch(`${base}/api/sync`, { method: 'POST', body: '{}' })).status, 404);
    const add = await fetch(`${base}/api/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fact: 'Likes worked examples first', kind: 'preference' }) }).then((r) => r.json());
    assert.equal(add.ok, true);
    assert.equal(memory.size, 1, 'the local store, as before');
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test('cron route: needs CRON_SECRET', async () => {
  await withServer({ env: { CRON_SECRET: 'cron-s3cret' }, push: { publicKey: 'P', privateKey: 'K', subject: 'mailto:a@b.c' }, pushSender: async () => {} }, async ({ anon }) => {
    assert.equal((await anon('GET', '/api/cron/reminders')).status, 401);
    assert.equal((await anon('GET', '/api/cron/reminders', null, { Authorization: 'Bearer wrong-secret' })).status, 401);
    const ok = await anon('GET', '/api/cron/reminders', null, { Authorization: 'Bearer cron-s3cret' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.checked, 0);
  });
  await withServer({ env: {} }, async ({ anon }) => {
    assert.equal((await anon('GET', '/api/cron/reminders', null, { Authorization: 'Bearer undefined' })).status, 401, 'no secret configured: closed');
  });
});

test('postgres adapter: every statement on learner data is scoped to one user', () => {
  const src = fs.readFileSync(new URL('../server/sync/pg-db.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function createPgDb'));
  // every SQL literal passed to query(): '...' or `...` starting with a SQL verb
  const statements = [...body.matchAll(/(?:query|q)\(\s*(?:'([^']*)'|`([^`]*)`)/g)].map((m) => (m[1] ?? m[2]).replace(/\s+/g, ' ').trim());
  assert.ok(statements.length >= 15, `found ${statements.length} statements`);
  const crossUser = [];
  for (const sql of statements) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) continue;
    if (/wonder_users/.test(sql)) { assert.match(sql, /\bid = \$1\b|VALUES \(\$1\)/, sql); continue; }
    if (/user_id = \$1\b/.test(sql) || /INSERT INTO \w+ \(user_id[^)]*\) VALUES \(\$1/.test(sql) || /SELECT \$1, \* FROM unnest/.test(sql)) continue;
    crossUser.push(sql);
  }
  // the only statements without a user filter: the cron's subscriber list and moving an endpoint
  assert.equal(crossUser.length, 2, crossUser.join('\n'));
  assert.ok(crossUser.some((s) => /^SELECT user_id, endpoint/.test(s)));
  assert.ok(crossUser.some((s) => /^DELETE FROM wonder_push_subscriptions WHERE endpoint = \$2 AND user_id <> \$1/.test(s)));
  assert.equal((body.match(/CROSS-USER/g) || []).length, 2, 'both are marked in the source');
});

test('import-local: signed-out server memory and material move into one account, once', async () => {
  const { importLocal } = await import('../server/sync/import-local.js');
  const { createMaterialStore } = await import('../server/materials.js');
  const sync = createSyncService({ db: createMemoryDb() });
  const memory = createMemoryStore({ file: null });
  memory.add({ fact: 'Studies for the statistics exam in May', kind: 'goal' });
  const materials = createMaterialStore({ dir: null });
  const m = materials.add({ kind: 'text', text: NOTES });
  assert.deepEqual(await importLocal({ sync, userId: 'alice', memory, materials }), { memory: 1, materials: 1 });
  assert.deepEqual(await importLocal({ sync, userId: 'alice', memory, materials }), { memory: 0, materials: 0 }, 'idempotent');
  assert.equal((await sync.db.getFile('alice', m.item.id)).bytes.toString('utf8'), NOTES);
  assert.equal(await sync.db.getFile('bob', m.item.id), null);
});
