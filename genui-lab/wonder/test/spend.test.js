// The server-wide daily budget (server/spend.js), counting that fails closed (server/usage.js),
// and a production deployment that refuses to run without accounts (server/app.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { usageCost, dailyBudget, createSpendGuard, budgetBody, DEFAULT_DAILY_BUDGET_USD, SEARCH_USD } from '../server/spend.js';
import { usageDay, UNCOUNTED } from '../server/usage.js';
import { fakeClient } from './helpers.js';

process.env.WONDER_LOG_USAGE ??= 'off';
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const LESSON = { topic: 'tides', useWebSearch: false, verify: false };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('a response is priced from its tokens, model and searches', () => {
  close(usageCost({ model: 'claude-opus-5-5', input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 24);
  close(usageCost({ model: 'claude-sonnet-5-5', input: 10_000, cacheRead: 100_000, cacheWrite: 20_000, output: 2_000 }), 0.02 + 0.02 + 0.05 + 0.02);
  close(usageCost({ model: 'claude-haiku-5-5', input: 50_000, output: 1_000 }), 0.005 + 0.0005);
  close(usageCost({ model: 'claude-haiku-5-5', input: 150_000, output: 1_000 }), 0.075 + 0.0025); // over 100K: the long-prompt rate
  close(usageCost({ model: 'claude-opus-5-5', input: 0, output: 0, searches: 3 }), 3 * SEARCH_USD);
  close(usageCost({ model: 'some-new-model', input: 1_000_000, output: 0 }), 4); // unknown: priced as Opus
});

test('WONDER_DAILY_BUDGET_USD sets the budget; off removes it', () => {
  assert.equal(dailyBudget({}), DEFAULT_DAILY_BUDGET_USD);
  assert.equal(dailyBudget({ WONDER_DAILY_BUDGET_USD: '12.5' }), 12.5);
  assert.equal(dailyBudget({ WONDER_DAILY_BUDGET_USD: 'off' }), Infinity);
  assert.equal(dailyBudget({ WONDER_DAILY_BUDGET_USD: '-1' }), Infinity);
  assert.equal(dailyBudget({ WONDER_DAILY_BUDGET_USD: '0' }), 0);
  assert.equal(dailyBudget({ WONDER_DAILY_BUDGET_USD: 'lots' }), DEFAULT_DAILY_BUDGET_USD);
});

test('the guard adds spend to today, shares it through the database, and resets each UTC day', async () => {
  let t = Date.UTC(2026, 9, 30, 12);
  const db = createMemoryDb();
  const a = createSpendGuard({ db, budgetUsd: 1, now: () => t, cacheMs: 1000 });
  const b = createSpendGuard({ db, budgetUsd: 1, now: () => t, cacheMs: 1000 }); // another instance
  assert.equal(await a.reached(), false);
  a.record({ model: 'claude-opus-5-5', input: 0, output: 50_000 }); // $1.00
  await new Promise((r) => setImmediate(r));
  assert.equal(await a.reached(), true, 'its own spend counts at once');
  assert.equal(await db.spendToday(usageDay(t).day), 1_000_000);
  assert.equal(await b.reached(), true, 'another instance reads it from the database');
  t += 24 * 3_600_000;
  assert.equal(await a.reached(), false, 'a new day starts at zero');
  const failing = createSpendGuard({ db: { ...db, spendToday: async () => { throw new Error('db down'); } }, budgetUsd: 1 });
  await assert.rejects(failing.reached(), /db down/);
  const off = createSpendGuard({ db: { spendToday: async () => { throw new Error('unused'); } }, budgetUsd: Infinity });
  assert.equal(await off.reached(), false);
});

/** fakeClient whose responses carry an Opus usage block, so the server prices them. */
function pricedClient(output) {
  const c = fakeClient({ text: '# Tides\n\nThe sea rises and falls.\n' });
  const stream = c.beta.messages.stream;
  c.beta.messages.stream = (p, o) => {
    const s = stream(p, o);
    const final = s.finalMessage;
    s.finalMessage = async () => ({ ...(await final()), model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: output } });
    return s;
  };
  return c;
}

async function withServer({ db = createMemoryDb(), ...opts }, fn) {
  const server = createWonderServer({ logger: quiet, memory: createMemoryStore({ file: null }), push: null, sync: createSyncService({ db }), getUserId: (req) => req.headers['x-test-user'] || null, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user) => async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
  try { return await fn({ alice: as('alice'), bob: as('bob'), anon: as(null) }); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('once today\'s budget is spent, nobody starts a new Claude request', async () => {
  const client = pricedClient(50_000); // $1.00 a lesson
  const db = createMemoryDb();
  await withServer({ client, db, env: { WONDER_DAILY_BUDGET_USD: '1.5', WONDER_ADMIN_USERS: 'owner' } }, async ({ alice, bob }) => {
    assert.equal((await alice('POST', '/api/lesson/stream', LESSON)).status, 200);
    assert.equal(await db.spendToday(usageDay().day), 1_000_000, 'the lesson was priced into today');
    assert.equal((await bob('POST', '/api/lesson/stream', LESSON)).status, 200, 'still under $1.50');
    const third = await alice('POST', '/api/lesson/stream', LESSON);
    assert.equal(third.status, 429);
    assert.equal(third.body.limited.kind, 'budget');
    assert.match(third.body.error, /limit for today across everyone/);
    const tutor = await bob('POST', '/api/tutor/stream', { message: 'Why are there two tides a day?' });
    assert.equal(tutor.status, 429, 'every Claude route stops');
    assert.equal(client.calls.stream.length, 2);
    assert.deepEqual((await alice('GET', '/api/account')).body.usage.kinds.lesson.used, 1, 'a refused request is not charged to the user');
  });
  // the server's owner (an admin) is not held to the budget
  await withServer({ client, db, env: { WONDER_DAILY_BUDGET_USD: '1.5', WONDER_ADMIN_USERS: 'alice' } }, async ({ alice }) => {
    assert.equal((await alice('POST', '/api/lesson/stream', LESSON)).status, 200);
  });
});

test('when usage cannot be counted, the request is refused (503), not let through', async () => {
  const client = pricedClient(10);
  const db = createMemoryDb();
  db.useQuota = async () => { throw new Error('db down'); };
  await withServer({ client, db }, async ({ alice }) => {
    const r = await alice('POST', '/api/lesson/stream', LESSON);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ...UNCOUNTED });
    assert.equal(client.calls.stream.length, 0);
  });
  const down = createMemoryDb();
  down.spendToday = async () => { throw new Error('db down'); };
  await withServer({ client, db: down }, async ({ alice }) => {
    assert.equal((await alice('POST', '/api/lesson/stream', LESSON)).status, 503, 'nor when the budget cannot be read');
    assert.equal(client.calls.stream.length, 0);
  });
});

test('a production deployment without accounts refuses to run instead of opening up', async () => {
  const client = pricedClient(10);
  for (const env of [{ VERCEL_ENV: 'production' }, { WONDER_REQUIRE_ACCOUNTS: 'on' }]) {
    await withServer({ client, sync: null, env }, async ({ anon }) => {
      const r = await anon('POST', '/api/lesson/stream', LESSON);
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'not_configured');
      assert.match(r.body.error, /Accounts are not set up/);
      assert.equal((await anon('POST', '/api/memory', { fact: 'I like tides' })).status, 503, 'no shared single-user store either');
      const status = (await anon('GET', '/api/status')).body;
      assert.equal(status.claude, false);
      assert.match(status.error, /Accounts are not set up/);
    });
  }
  assert.equal(client.calls.stream.length, 0);
  // a local server (or an explicit opt-out) still runs as the single-user app
  for (const env of [{}, { VERCEL_ENV: 'production', WONDER_REQUIRE_ACCOUNTS: 'off' }]) {
    await withServer({ client, sync: null, env }, async ({ anon }) => {
      assert.equal((await anon('POST', '/api/lesson/stream', LESSON)).status, 200);
    });
  }
});

test('the budget body tells the browser not to retry and when it resets', () => {
  const b = budgetBody(Date.UTC(2026, 9, 30, 22));
  assert.equal(b.limited.kind, 'budget');
  assert.equal(b.limited.resetsAt, '2026-10-31T00:00:00.000Z');
  assert.match(b.error, /in about 2 hours/);
});
