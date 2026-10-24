// Free and Pro plans (server/plans.js): which daily caps a signed-in user gets. Payments are not
// wired, so Pro comes from a stored plan record or WONDER_PRO_USERS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { createPlans, effectivePlan, cleanPlanRecord, compedUsers, PERIOD_GRACE_MS } from '../server/plans.js';
import { usageLimits, createUsageGate, DEFAULT_LIMITS, DEFAULT_PRO_LIMITS } from '../server/usage.js';
import { fakeClient } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const DAY = 24 * 3600_000;

test('effective plan: Pro only in good standing and within its period (plus grace); comped wins', () => {
  const now = Date.UTC(2026, 9, 24);
  const pro = (status, periodEnd = now + DAY) => ({ plan: 'pro', status, periodEnd });
  assert.equal(effectivePlan(null, { now }), 'free');
  assert.equal(effectivePlan(null, { now, comped: true }), 'pro');
  for (const s of ['active', 'trialing', 'past_due']) assert.equal(effectivePlan(pro(s), { now }), 'pro', s);
  for (const s of ['canceled', 'unpaid', 'incomplete', 'expired']) assert.equal(effectivePlan(pro(s), { now }), 'free', s);
  assert.equal(effectivePlan(pro('active', null), { now }), 'pro', 'no period end: open-ended');
  assert.equal(effectivePlan(pro('active', now - PERIOD_GRACE_MS + 1000), { now }), 'pro', 'a late renewal keeps Pro during the grace');
  assert.equal(effectivePlan(pro('active', now - PERIOD_GRACE_MS - 1000), { now }), 'free', 'past the grace: Free');
  assert.equal(effectivePlan({ plan: 'free', status: 'active' }, { now }), 'free');
  assert.deepEqual([...compedUsers({ WONDER_PRO_USERS: ' u1, u2 u3,,' })], ['u1', 'u2', 'u3']);
  assert.equal(compedUsers({}).size, 0);
});

test('plan records are cleaned; unknown plans and statuses are refused', () => {
  const r = cleanPlanRecord({ plan: 'pro', status: 'active', provider: ' stripe ', customerId: '', periodEnd: '2026-11-24T00:00:00Z', cancelAtPeriodEnd: 1, extra: 'x' });
  assert.deepEqual(r, { plan: 'pro', status: 'active', provider: 'stripe', customerId: null, subscriptionId: null, periodEnd: Date.UTC(2026, 10, 24), cancelAtPeriodEnd: true });
  assert.throws(() => cleanPlanRecord({ plan: 'gold', status: 'active' }), /Unknown plan/);
  assert.throws(() => cleanPlanRecord({ plan: 'pro', status: 'paid' }), /Unknown plan status/);
});

test('plans over the database: describe, comped users, and a failing lookup counts as Free', async () => {
  const now = Date.UTC(2026, 9, 24);
  const db = createMemoryDb();
  const plans = createPlans({ db, env: { WONDER_PRO_USERS: 'carol' }, now: () => now, logger: quiet });
  assert.equal(plans.billing, null, 'no payment provider yet');
  assert.deepEqual(await plans.describe('alice'), { id: 'free', name: 'Free', source: null, status: null, renewsAt: null, endsAt: null });
  await plans.setPlan('alice', { plan: 'pro', status: 'active', provider: 'test', periodEnd: now + 30 * DAY });
  assert.equal(await plans.planId('alice'), 'pro');
  assert.equal((await plans.describe('alice')).renewsAt, new Date(now + 30 * DAY).toISOString());
  await plans.setPlan('alice', { plan: 'pro', status: 'active', periodEnd: now + 30 * DAY, cancelAtPeriodEnd: true });
  const d = await plans.describe('alice');
  assert.equal(d.renewsAt, null);
  assert.equal(d.endsAt, new Date(now + 30 * DAY).toISOString());
  assert.equal(await plans.planId('bob'), 'free', 'per user');
  assert.deepEqual(await plans.describe('carol'), { id: 'pro', name: 'Pro', source: 'comped', status: null, renewsAt: null, endsAt: null });
  const warned = [];
  const broken = createPlans({ db: { getPlan: async () => { throw new Error('db down'); } }, env: {}, logger: { warn: (m) => warned.push(m) } });
  assert.equal(await broken.planId('alice'), 'free');
  assert.match(warned[0], /plan lookup failed: db down/);
});

test('usage gate: Pro gets the Pro caps; Pro caps have their own env overrides', async () => {
  assert.deepEqual(usageLimits({}, 'pro'), DEFAULT_PRO_LIMITS);
  for (const k of Object.keys(DEFAULT_LIMITS)) assert.ok(DEFAULT_PRO_LIMITS[k] > DEFAULT_LIMITS[k], k);
  const l = usageLimits({ WONDER_LIMIT_LESSON: '3', WONDER_PRO_LIMIT_LESSON: 'off', WONDER_PRO_LIMIT_TUTOR: '7' }, 'pro');
  assert.deepEqual([l.lesson, l.tutor], [Infinity, 7], 'Free overrides do not touch Pro');
  const gate = createUsageGate({ db: createMemoryDb(), limits: { lesson: 1 }, proLimits: { lesson: 2 }, logger: quiet });
  assert.equal((await gate.charge('alice', 'lesson')).ok, true);
  const over = await gate.charge('alice', 'lesson');
  assert.equal(over.ok, false);
  assert.equal(over.body.limited.plan, 'free');
  assert.equal((await gate.charge('alice', 'lesson', { plan: 'pro' })).ok, true, 'the same day counts on Pro caps');
  const proOver = await gate.charge('alice', 'lesson', { plan: 'pro' });
  assert.deepEqual([proOver.ok, proOver.body.limited.plan, proOver.body.limited.max], [false, 'pro', 2]);
  assert.deepEqual((await gate.today('alice', 'pro')).kinds.lesson, { used: 2, max: 2 });
  assert.equal((await gate.today('alice', 'pro')).plan, 'pro');
});

test('over HTTP: a Pro user (stored or comped) gets Pro caps, and /api/account shows the plan', async () => {
  const sync = createSyncService({ db: createMemoryDb() });
  await sync.db.setPlan('alice', cleanPlanRecord({ plan: 'pro', status: 'active', periodEnd: Date.now() + 30 * DAY }));
  const server = createWonderServer({
    mode: 'claude', client: fakeClient({ text: '# T\n\nBody.' }), demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null }), push: null, sync,
    getUserId: (req) => req.headers['x-test-user'] || null,
    env: { WONDER_LIMIT_LESSON: '1', WONDER_PRO_LIMIT_LESSON: '2', WONDER_PRO_USERS: 'carol' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json };
  };
  const LESSON = { topic: 'photosynthesis', useWebSearch: false, verify: false };
  try {
    const statuses = async (user) => { const out = []; for (let i = 0; i < 3; i++) out.push((await call(user, 'POST', '/api/lesson/stream', LESSON)).status); return out; };
    assert.deepEqual(await statuses('alice'), [200, 200, 429], 'stored Pro: 2 a day');
    assert.deepEqual(await statuses('carol'), [200, 200, 429], 'comped Pro: 2 a day');
    assert.deepEqual(await statuses('bob'), [200, 429, 429], 'Free: 1 a day');
    const alice = (await call('alice', 'GET', '/api/account')).body;
    assert.equal(alice.plan.id, 'pro');
    assert.equal(alice.plan.source, 'subscription');
    assert.equal(alice.billing, null);
    assert.equal(alice.usage.plan, 'pro');
    assert.deepEqual(alice.usage.kinds.lesson, { used: 2, max: 2 });
    const bob = (await call('bob', 'GET', '/api/account')).body;
    assert.equal(bob.plan.id, 'free');
    assert.deepEqual(bob.usage.kinds.lesson, { used: 1, max: 1 });
    const anon = (await call(null, 'GET', '/api/account')).body;
    assert.equal(anon.plan, undefined);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
