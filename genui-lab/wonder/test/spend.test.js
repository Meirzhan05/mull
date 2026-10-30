// The server-wide daily budget (server/spend.js), counting that fails closed (server/usage.js),
// and a production deployment that refuses to run without accounts (server/app.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { createPgDb } from '../server/sync/pg-db.js';
import { usageCost, dailyBudget, createSpendGuard, budgetBody, DEFAULT_DAILY_BUDGET_USD, SEARCH_USD } from '../server/spend.js';
import { usageDay, UNCOUNTED } from '../server/usage.js';
import { streamText, streamUsage, onUsage } from '../server/claude.js';
import { fakeClient, steerableClient, withAccountsServer as withServer, STEADY_LESSON } from './helpers.js';

process.env.WONDER_LOG_USAGE ??= 'off';
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

const OPUS = 'claude-opus-5-5';
/** fakeClient whose responses cost `output` Opus output tokens ($20 per million). */
const pricedClient = (output) => fakeClient({ text: '# Tides\n\nThe sea rises and falls.\n', model: OPUS, usage: { input_tokens: 0, output_tokens: output } });

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
  // Vercel production; any server with some account settings but not all (one went missing); or asked to
  for (const env of [{ VERCEL_ENV: 'production' }, { DATABASE_URL: 'postgres://x', NEON_AUTH_BASE_URL: 'https://auth.example' }, { WONDER_REQUIRE_ACCOUNTS: 'on' }]) {
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
  for (const env of [{}, { VERCEL_ENV: 'production', WONDER_REQUIRE_ACCOUNTS: 'off' }, { DATABASE_URL: 'postgres://x', WONDER_REQUIRE_ACCOUNTS: 'off' }]) {
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

test('a stream that stops mid-way still reports what it was billed', async () => {
  const seen = [];
  const off = onUsage((e) => seen.push(e));
  try {
    // the unit: message_start's usage, output estimated from the text when no message_delta came
    const u = streamUsage('lesson');
    u.settle(); // nothing started: nothing billed
    assert.equal(seen.length, 0);
    u.see({ type: 'message_start', message: { model: OPUS, usage: { input_tokens: 9000, cache_read_input_tokens: 1000, output_tokens: 1 } } });
    u.see({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(400) } });
    u.settle();
    u.settle(); // once only
    assert.deepEqual(seen.map(({ task, model, input, cacheRead, output }) => ({ task, model, input, cacheRead, output })), [{ task: 'lesson', model: OPUS, input: 9000, cacheRead: 1000, output: 100 }]);
    // through streamText: a slow stream aborted part-way
    seen.length = 0;
    const client = fakeClient({ text: 'y'.repeat(4000), delayMs: 2, model: OPUS, usage: { input_tokens: 5000, output_tokens: 0 } });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await assert.rejects(streamText(client, { model: OPUS, messages: [] }, { signal: ctrl.signal, task: 'tutor' }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].input, 5000);
    assert.ok(seen[0].output > 1 && seen[0].output < 1000, `estimated output ${seen[0].output}`);
  } finally { off(); }
});

test('a steered lesson counts the attempt the steer stopped as well as the one that finished', async () => {
  const usage = { input_tokens: 100_000, output_tokens: 0 }; // $0.40 of Opus input per attempt
  const client = steerableClient('## Page two\n\nDone.\n', { model: OPUS, usage });
  const db = createMemoryDb();
  await withServer({ client, db }, async ({ alice }) => {
    const { reader, op } = await startLesson(alice);
    assert.equal((await alice('POST', '/api/lesson/steer', { operationId: op, instruction: 'Simpler' })).status, 200);
    for (;;) { const { done } = await reader.read(); if (done) break; }
    assert.equal(client.calls.length, 2);
    const usd = (await db.spendToday(usageDay().day)) / 1e6;
    assert.ok(usd > 0.8 && usd < 0.81, `two attempts' input plus a little output: ${usd}`);
  });
});

test('the response waits for its spend to be written', async () => {
  const db = createMemoryDb();
  const add = db.addSpend;
  db.addSpend = async (...a) => { await new Promise((r) => setTimeout(r, 60)); return add(...a); };
  await withServer({ client: pricedClient(50_000), db }, async ({ alice }) => {
    assert.equal((await alice('POST', '/api/lesson/stream', LESSON)).status, 200);
    assert.equal(await db.spendToday(usageDay().day), 1_000_000, 'written before the response ended');
  });
});

test('spend recorded while the total is being re-read is not lost', async () => {
  const db = createMemoryDb();
  let release;
  const read = db.spendToday;
  const guard = createSpendGuard({ db: { ...db, spendToday: async (d) => { const v = await read(d); await new Promise((r) => { release = r; }); return v; } }, budgetUsd: 1 });
  const pending = guard.reached(); // reads 0 and waits
  await new Promise((r) => setImmediate(r));
  await guard.record({ model: OPUS, input: 0, output: 50_000 }); // $1.00 lands after the read
  release();
  assert.equal(await pending, true);
});

/** Start a lesson and read until it stalls mid-page (steerableClient); returns its reader and operation id. */
async function startLesson(user) {
  const res = await user.raw('POST', '/api/lesson/stream', LESSON);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const stall = JSON.stringify(STEADY_LESSON.match(/[\s\S]{1,12}/g).at(-1));
  let text = '';
  let op = null;
  while (!op || !text.includes(stall)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    op ??= /"operationId":"([^"]+)"/.exec(text)?.[1] ?? null;
  }
  assert.ok(op, 'the stream names its operation');
  return { reader, op, text: async () => { let rest = text; for (;;) { const { value, done } = await reader.read(); if (done) return rest; rest += dec.decode(value, { stream: true }); } } };
}

test('a live steer: refused before it stops the lesson when the budget is spent or usage cannot be read', async () => {
  let spent = false;
  const spend = { budgetUsd: 1, reached: async () => spent, record: () => null };
  const client = steerableClient('## Page two\n\nDone.\n');
  const db = createMemoryDb();
  await withServer({ client, db, spend }, async ({ alice }) => {
    const { reader, op } = await startLesson(alice);
    spent = true;
    const r = await alice('POST', '/api/lesson/steer', { operationId: op, instruction: 'Simpler' });
    assert.equal(r.status, 429);
    assert.equal(r.body.limited.kind, 'budget');
    spent = false;
    const read = db.quotaUsed;
    db.quotaUsed = async () => { throw new Error('db down'); };
    const r2 = await alice('POST', '/api/lesson/steer', { operationId: op, instruction: 'Simpler' });
    assert.equal(r2.status, 503, 'a failed read refuses the steer');
    assert.equal(r2.body.code, 'usage_unavailable');
    db.quotaUsed = read;
    assert.equal(client.calls.length, 1, 'the lesson kept streaming');
    await reader.cancel();
  });
});

test('a steer whose charge fails ends the stream with usage_unavailable', async () => {
  const client = steerableClient('## Page two\n\nDone.\n');
  const db = createMemoryDb();
  await withServer({ client, db }, async ({ alice }) => {
    const lesson = await startLesson(alice);
    db.useQuota = async () => { throw new Error('db down'); };
    assert.equal((await alice('POST', '/api/lesson/steer', { operationId: lesson.op, instruction: 'Simpler' })).status, 200);
    const rest = await lesson.text();
    assert.match(rest, /"code":"usage_unavailable"/);
    assert.equal(client.calls.length, 1, 'the steer never reached Claude');
  });
});

test('postgres adapter: spend is one atomic upsert per response and read back as a number', async () => {
  const queries = [];
  const pool = { query: async (text, params) => { queries.push({ text, params }); return { rows: /SELECT micro_usd/.test(text) ? [{ micro_usd: '1500000' }] : [] }; } };
  const db = createPgDb({ pool });
  await db.addSpend('2026-10-30', 250_000);
  assert.equal(await db.spendToday('2026-10-30'), 1_500_000);
  const [, add, read] = queries; // the first query creates the schema
  assert.match(queries[0].text, /CREATE TABLE IF NOT EXISTS wonder_spend/);
  assert.match(add.text, /^INSERT INTO wonder_spend \(day, micro_usd\) VALUES \(\$1, \$2\) ON CONFLICT \(day\) DO UPDATE SET micro_usd = wonder_spend\.micro_usd \+ \$2$/);
  assert.deepEqual(add.params, ['2026-10-30', 250_000]);
  assert.deepEqual(read.params, ['2026-10-30']);
});
