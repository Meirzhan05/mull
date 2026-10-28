// Accounts on: Claude routes need a signed-in user and stay within per-user daily caps
// (server/usage.js). Auth is faked with the test header createWonderServer's getUserId reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { usageKind, usageLimits, usageDay, limitBody, createUsageGate, DEFAULT_LIMITS, RETRY_FREE, RETRY_WINDOW_MS } from '../server/usage.js';
import { streamTurn, classifyFailure, postJson } from '../public/stream-client.js';
import { fakeClient } from './helpers.js';
import { materialCharge } from '../server/materials.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };

test('which requests spend Claude, and the caps (with env overrides)', () => {
  assert.equal(usageKind('POST', '/api/lesson/stream', {}), 'lesson');
  assert.equal(usageKind('POST', '/api/tutor/stream', {}), 'tutor');
  assert.equal(usageKind('POST', '/api/teacher/stream', {}), 'teacher');
  assert.equal(usageKind('POST', '/api/course/plan', {}), 'course');
  assert.equal(usageKind('POST', '/api/practice/extract', {}), 'extract');
  assert.equal(usageKind('POST', '/api/memory/extract', {}), 'extract');
  assert.equal(usageKind('POST', '/api/widget_action', { action_type: 'explain_grade' }), 'grade');
  assert.equal(usageKind('POST', '/api/widget_action', { action_type: 'quiz_answer' }), null, 'quiz grading is local, not Claude');
  for (const p of ['/api/sync', '/api/memory', '/api/lesson/steer', '/api/account']) assert.equal(usageKind('POST', p, {}), null, p);
  assert.deepEqual(usageLimits({}), DEFAULT_LIMITS);
  const l = usageLimits({ WONDER_LIMIT_LESSON: '50', WONDER_LIMIT_TUTOR: 'off', WONDER_LIMIT_TEACHER: '-1', WONDER_LIMIT_COURSE: '0', WONDER_LIMIT_GRADE: 'lots' });
  assert.deepEqual([l.lesson, l.tutor, l.teacher, l.course, l.grade], [50, Infinity, Infinity, 0, DEFAULT_LIMITS.grade]);
  const d = usageDay(Date.UTC(2026, 9, 23, 22, 30));
  assert.equal(d.day, '2026-10-23');
  assert.equal(new Date(d.resetsAt).toISOString(), '2026-10-24T00:00:00.000Z');
  const b = limitBody('lesson', 20, Date.UTC(2026, 9, 23, 22, 30));
  assert.match(b.error, /today's 20 lessons\. More in about 2 hours \(midnight UTC\)/);
  assert.deepEqual(b.limited, { kind: 'lesson', max: 20, resetsAt: '2026-10-24T00:00:00.000Z' });
  assert.match(limitBody('course', 0).error, /Course plans are turned off/);
});

test('usage gate: counts per user, per kind and per UTC day; retries of one stream are free only briefly', async () => {
  let t = Date.UTC(2026, 9, 23, 12);
  const db = createMemoryDb();
  const gate = createUsageGate({ db, limits: { lesson: 2, tutor: 1, course: 0, teacher: Infinity }, now: () => t, logger: quiet });
  assert.equal((await gate.charge('alice', 'lesson')).ok, true);
  assert.equal((await gate.charge('alice', 'lesson')).ok, true);
  const over = await gate.charge('alice', 'lesson');
  assert.equal(over.ok, false);
  assert.equal(over.body.limited.kind, 'lesson');
  assert.equal((await gate.charge('bob', 'lesson')).ok, true, 'per user');
  assert.equal((await gate.charge('alice', 'tutor')).ok, true, 'per kind');
  assert.equal((await gate.charge('alice', 'course')).ok, false, '0 blocks the kind');
  assert.equal((await gate.charge('alice', 'teacher')).ok, true, 'Infinity: no cap');
  assert.deepEqual((await gate.today('alice')).kinds.lesson, { used: 2, max: 2 });
  t += 24 * 3600_000;
  assert.equal((await gate.charge('alice', 'lesson')).ok, true, 'a new UTC day');

  // one stream's automatic retries (same retryKey) are free up to RETRY_FREE times within the window
  const g2 = createUsageGate({ db: createMemoryDb(), limits: { lesson: 3 }, now: () => t, logger: quiet });
  assert.equal((await g2.charge('alice', 'lesson', { retryKey: 'L1' })).used, 1);
  for (let i = 0; i < RETRY_FREE; i++) assert.equal((await g2.charge('alice', 'lesson', { retryKey: 'L1' })).retried, true);
  assert.equal((await g2.charge('alice', 'lesson', { retryKey: 'L1' })).used, 2, 'a reused key past the free retries is charged');
  t += RETRY_WINDOW_MS + 1;
  assert.equal((await g2.charge('alice', 'lesson', { retryKey: 'L1' })).used, 3, 'and so is one after the window');
  assert.equal((await g2.charge('alice', 'lesson', { retryKey: 'L1' })).retried, true);
  assert.equal((await g2.charge('alice', 'lesson', { retryKey: 'L2' })).ok, false, 'cap reached');

  // a database error fails open (logged), never locking everyone out
  const warned = [];
  const broken = createUsageGate({ db: { useQuota: async () => { throw new Error('db down'); }, quotaUsed: async () => ({}) }, limits: { lesson: 1 }, logger: { warn: (m) => warned.push(m) } });
  assert.equal((await broken.charge('alice', 'lesson')).ok, true);
  assert.match(warned[0], /usage count failed \(lesson\): db down/);
});

async function withServer(opts, fn) {
  const sync = opts.sync === undefined ? createSyncService({ db: createMemoryDb() }) : opts.sync;
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null }), push: null, getUserId: (req) => req.headers['x-test-user'] || null, ...opts, sync });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user) => async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
  try { return await fn({ alice: as('alice'), bob: as('bob'), anon: as(null) }); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

const LESSON = { topic: 'photosynthesis', useWebSearch: false, verify: false };

test('accounts on, Claude mode: signed out gets 401 on every Claude route; caps give 429 with `limited`', async () => {
  const client = fakeClient({ text: '# T\n\nBody.' });
  await withServer({ mode: 'claude', client, env: { WONDER_LIMIT_LESSON: '1', WONDER_LIMIT_TUTOR: '2' } }, async ({ alice, bob, anon }) => {
    for (const [p, body] of [['/api/lesson/stream', LESSON], ['/api/tutor/stream', { message: 'why?', lessonContext: { title: 'T', markdown: '# T' } }], ['/api/teacher/stream', { message: 'hi' }], ['/api/course/plan', { topic: 'x' }], ['/api/practice/extract', { lessonMarkdown: '# T' }], ['/api/memory/extract', {}]]) {
      const r = await anon('POST', p, body);
      assert.equal(r.status, 401, p);
      assert.equal(r.body.signedOut, true, p);
      assert.match(r.body.error, /Sign in to use Mull/);
    }
    assert.equal(client.calls.stream.length, 0, 'no Claude call for a signed-out request');
    const first = await alice('POST', '/api/lesson/stream', LESSON);
    assert.equal(first.status, 200);
    assert.match(first.text, /"type":"end"/);
    const second = await alice('POST', '/api/lesson/stream', LESSON);
    assert.equal(second.status, 429);
    assert.equal(second.body.limited.kind, 'lesson');
    assert.equal(second.body.limited.max, 1);
    assert.equal((await bob('POST', '/api/lesson/stream', LESSON)).status, 200, 'Bob has his own cap');
    const acct = (await alice('GET', '/api/account')).body;
    assert.deepEqual(acct.usage.kinds.lesson, { used: 1, max: 1 });
    assert.deepEqual(acct.usage.kinds.tutor, { used: 0, max: 2 });
    assert.equal((await anon('GET', '/api/account')).body.usage, undefined);
    // widget actions that are not Claude stay open; only explain_grade is capped and signed-in
    assert.notEqual((await anon('POST', '/api/widget_action', { componentName: 'Quiz', action_type: 'quiz_answer', resolutionId: 'r1', payload: {} })).status, 401);
    assert.equal((await anon('POST', '/api/widget_action', { componentName: 'ExplainBack', action_type: 'explain_grade', resolutionId: 'r2', payload: {} })).status, 401);
  });
});

test('a lesson from a long material counts as several against the cap', async () => {
  const fake = fakeClient({ text: '# T\n\nBody.' });
  const client = { ...fake, messages: { ...fake.messages, countTokens: async () => ({ input_tokens: 600_000 }) } };
  await withServer({ mode: 'claude', client, env: { WONDER_LIMIT_LESSON: '5' } }, async ({ alice }) => {
    const { item } = (await alice('POST', '/api/materials', { kind: 'text', text: 'Plants turn light, water and carbon dioxide into glucose and oxygen. '.repeat(3) })).body;
    assert.equal(item.tokens, 600_000);
    assert.equal(materialCharge(item), 3);
    assert.equal((await alice('POST', '/api/lesson/stream', { ...LESSON, materialId: item.id })).status, 200);
    assert.deepEqual((await alice('GET', '/api/account')).body.usage.kinds.lesson, { used: 3, max: 5 });
    const second = await alice('POST', '/api/lesson/stream', { ...LESSON, materialId: item.id });
    assert.equal(second.status, 429);
    assert.match(second.body.error, /counts as 3 of today's 5 lessons/);
    assert.equal((await alice('POST', '/api/lesson/stream', LESSON)).status, 200, 'a lesson without the material still fits');
  });
});

test('demo mode has no caps (it costs nothing); accounts off keeps the single-user app open', async () => {
  await withServer({ mode: 'demo', env: { WONDER_LIMIT_LESSON: '0' } }, async ({ alice, anon }) => {
    assert.equal((await alice('POST', '/api/lesson/stream', LESSON)).status, 200, 'cap 0 ignored in demo mode');
    assert.equal((await anon('POST', '/api/lesson/stream', LESSON)).status, 401, 'but sign-in is still required with accounts on');
  });
  const client = fakeClient({ text: '# T\n\nBody.' });
  await withServer({ mode: 'claude', client, sync: null, env: { WONDER_LIMIT_LESSON: '0' } }, async ({ anon }) => {
    assert.equal((await anon('POST', '/api/lesson/stream', LESSON)).status, 200, 'no accounts: no sign-in, no caps');
  });
});

test('browser: signed out and a used-up cap are not retried, and say so', async () => {
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const err = async (status, body) => { try { await streamTurn('/api/lesson/stream', {}, { fetch: reply(status, body) }); } catch (e) { return e; } return null; };
  const out = await err(401, { ok: false, error: 'Sign in to use Mull', signedOut: true });
  assert.equal(out.code, 'signed_out');
  assert.equal(out.retryable, false);
  assert.equal(out.message, 'Sign in to use Mull');
  const lim = await err(429, limitBody('lesson', 20));
  assert.equal(lim.code, 'daily_limit');
  assert.equal(lim.retryable, false, 'a 429 that carries `limited` is final, unlike Claude being busy');
  assert.equal(classifyFailure({ status: 429 }).retryable, true, 'a plain 429 (busy) is still retried');
  const realFetch = globalThis.fetch;
  globalThis.fetch = reply(429, limitBody('course', 10));
  try { await assert.rejects(postJson('/api/course/plan', {}), (e) => e.code === 'daily_limit' && /course plans/.test(e.message)); } finally { globalThis.fetch = realFetch; }
});
