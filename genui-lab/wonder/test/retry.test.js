// Recoverable streams: client-side failure classification, Retry-After / backoff, streamTurn's
// failure paths (it always aborts its own request before throwing), the server's supersede
// registry and keep-alive, a lesson continued after a real mid-stream drop (no duplicate
// pages, Claude path and demo path), and Teacher tool calls replayed, not re-run, on a retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { friendlyError } from '../server/claude.js';
import { createTurnWriter } from '../server/ndjson.js';
import { createInflight, createTurnLedger, toolCallKey, retryNote } from '../server/retry.js';
import { stripGroundingTags } from '../server/grounding.js';
import {
  streamTurn, classifyFailure, parseRetryAfter, retryDelay, failureError, StreamError, isRetryableStatus, wait,
} from '../public/stream-client.js';
import { sourcesFromAppData, pageCount, pageTitles, statusAfterStop } from '../public/steering-core.js';
import { CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';
import { demo, fakeClient, fakeToolClient } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
async function withServer(opts, fn) {
  const memory = opts.memory ?? createMemoryStore({ file: null });
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memoryFile: null, memory, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server, memory); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const apiError = (Cls, status, type, headers = new Headers()) => new Cls(status, { type: 'error', error: { type, message: 'raw' } }, 'raw', headers);
const rec = (o) => JSON.stringify({ version: 2, ...o }) + '\n';
const ndjsonResponse = (chunks, { hang = false } = {}) => new Response(new ReadableStream({
  async start(c) {
    for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
    if (!hang) c.close();
  },
}), { status: 200, headers: { 'Content-Type': CONTENT_TYPE } });
const START = [rec({ type: 'control', detail: { operationId: 'op', kind: 'started' } }), rec({ type: 'content', messageId: 'm-12345678', revision: 1, mode: 'replace', markdown: '', status: 'streaming' })];

// ---------------------------------------------------------------- classification

test('classifyFailure: network / abort / stall / HTTP / server codes / protocol', () => {
  assert.deepEqual(pick(classifyFailure({ error: new TypeError('Failed to fetch') })), { kind: 'network', retryable: true });
  assert.deepEqual(pick(classifyFailure({ aborted: true })), { kind: 'aborted', retryable: false });
  assert.deepEqual(pick(classifyFailure({ stalled: true })), { kind: 'stalled', retryable: true });
  for (const s of [408, 425, 429, 500, 502, 503, 504, 529]) assert.equal(classifyFailure({ status: s }).retryable, true, `HTTP ${s}`);
  for (const s of [400, 401, 403, 404, 409, 413, 422]) assert.equal(classifyFailure({ status: s }).retryable, false, `HTTP ${s}`);
  assert.equal(classifyFailure({ status: 429 }).code, 'rate_limited');
  assert.equal(classifyFailure({ status: 529 }).code, 'overloaded');
  assert.equal(classifyFailure({ status: 404, message: 'No such lesson' }).message, 'No such lesson');
  assert.equal(classifyFailure({ status: 429, retryAfter: '7' }).retryAfterMs, 7000);
  assert.equal(classifyFailure({ status: 400, retryAfter: '7' }).retryAfterMs, null, 'not retryable: no wait');
  for (const c of ['network', 'stalled', 'rate_limited', 'overloaded', 'api_error']) assert.equal(classifyFailure({ code: c }).retryable, true, c);
  for (const c of ['bad_request', 'auth_failed', 'workspace_required', 'internal', 'failed']) assert.equal(classifyFailure({ code: c }).retryable, false, c);
  assert.equal(classifyFailure({ code: 'overloaded', retryAfterMs: 4000 }).retryAfterMs, 4000);
  assert.deepEqual(pick(classifyFailure({ protocol: true })), { kind: 'protocol', retryable: false });
  assert.ok(isRetryableStatus(503) && !isRetryableStatus(404));
  // the lesson keeps its pages for every retryable failure
  assert.equal(statusAfterStop({ markdown: '# T\n\nText.\n', failureCode: 'http_retryable' }), 'interrupted');
  assert.equal(statusAfterStop({ markdown: '# T\n\nText.\n', failureCode: 'overloaded' }), 'interrupted');
  const fe = failureError({ code: 'overloaded', message: 'Busy', retryAfterMs: 2000 });
  assert.ok(fe instanceof StreamError);
  assert.deepEqual([fe.kind, fe.code, fe.retryable, fe.retryAfterMs, fe.message], ['server', 'overloaded', true, 2000, 'Busy']);
});
function pick(c) { return { kind: c.kind, retryable: c.retryable }; }

test('Retry-After parsing and backoff: server wait honored and capped, else exponential with jitter', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(parseRetryAfter('3', now), 3000);
  assert.equal(parseRetryAfter('1.5', now), 1500);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 12:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 11:00:00 GMT', now), 0, 'a date in the past: retry now');
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(retryDelay(0, { retryAfterMs: 2500 }), 2500);
  assert.equal(retryDelay(0, { retryAfterMs: 0 }), 0);
  assert.equal(retryDelay(0, { retryAfterMs: 120_000, maxMs: 30_000 }), 30_000, 'capped');
  assert.equal(retryDelay(0, { random: () => 0 }), 500);
  assert.equal(retryDelay(0, { random: () => 1 }), 1000);
  assert.equal(retryDelay(2, { random: () => 0 }), 2000);
  assert.equal(retryDelay(2, { random: () => 1 }), 4000);
  assert.equal(retryDelay(10, { random: () => 1, maxMs: 30_000 }), 30_000);
  for (let n = 0; n < 50; n++) { const d = retryDelay(1); assert.ok(d >= 1000 && d <= 2000); }
});

test('server errors: 529 / overloaded_error and Retry-After reach the failed control record', () => {
  const h = new Headers({ 'retry-after': '4' });
  assert.deepEqual(pickF(friendlyError(apiError(Anthropic.InternalServerError, 529, 'overloaded_error', h))), { code: 'overloaded', retryAfterMs: 4000 });
  // mid-stream SSE error event: no HTTP status, only the error type
  assert.equal(friendlyError(new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 'x', undefined)).code, 'overloaded');
  assert.deepEqual(pickF(friendlyError(apiError(Anthropic.RateLimitError, 429, 'rate_limit_error', h))), { code: 'rate_limited', retryAfterMs: 4000 });
  assert.equal(friendlyError(apiError(Anthropic.InternalServerError, 500, 'api_error')).code, 'api_error');
  const out = [];
  const w = createTurnWriter({ write: (s) => out.push(JSON.parse(s)) });
  w.start();
  w.fail('Busy', 'overloaded', { retryAfterMs: 4000 });
  const failed = out.find((r) => r.detail?.kind === 'failed').detail;
  assert.deepEqual([failed.code, failed.retryAfterMs], ['overloaded', 4000]);
});
function pickF(f) { return { code: f.code, retryAfterMs: f.retryAfterMs }; }

// ---------------------------------------------------------------- streamTurn failure paths

/** A fake fetch that records the AbortSignal it was given. */
function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => { calls.push(init); return respond(init); };
  f.calls = calls;
  return f;
}

test('streamTurn: HTTP 429 with Retry-After and a plain 400 become typed errors', async () => {
  const f429 = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: 'Slow down' }), { status: 429, headers: { 'Retry-After': '3' } }));
  await assert.rejects(streamTurn('/api/lesson/stream', {}, { fetch: f429 }), (e) => e instanceof StreamError && e.kind === 'http' && e.retryable && e.retryAfterMs === 3000 && e.status === 429 && e.message === 'Slow down');
  const f400 = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: 'topic is required' }), { status: 400 }));
  await assert.rejects(streamTurn('/api/lesson/stream', {}, { fetch: f400 }), (e) => e.kind === 'http' && !e.retryable && e.message === 'topic is required');
  const f503 = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 503 }));
  await assert.rejects(streamTurn('/x', {}, { fetch: f503 }), (e) => e.retryable && e.code === 'http_retryable');
});

test('streamTurn: fetch rejecting, a body cut before `end`, and a caller abort', async () => {
  const down = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(streamTurn('/x', {}, { fetch: down }), (e) => e.kind === 'network' && e.retryable);
  const cut = fakeFetch(() => ndjsonResponse([...START, '{"version":2,"type":"cont']));
  const seen = [];
  await assert.rejects(streamTurn('/x', {}, { fetch: cut, onControl: (d) => seen.push(d.kind) }), (e) => e.kind === 'network' && e.retryable && e.received === 2);
  assert.deepEqual(seen, ['started']);
  const ac = new AbortController();
  const hang = fakeFetch(() => ndjsonResponse(START, { hang: true }));
  const p = streamTurn('/x', {}, { fetch: hang, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.kind === 'aborted' && !e.retryable);
  assert.ok(hang.calls[0].signal.aborted);
});

test('streamTurn: a silent stream stalls after idleMs and its request is aborted before the error surfaces', async () => {
  const hang = fakeFetch(() => ndjsonResponse(START, { hang: true }));
  const t0 = Date.now();
  await assert.rejects(streamTurn('/x', {}, { fetch: hang, idleMs: 80 }), (e) => {
    assert.equal(hang.calls[0].signal.aborted, true, 'the stalled request is aborted first: a retry never overlaps it');
    return e.kind === 'stalled' && e.retryable;
  });
  assert.ok(Date.now() - t0 < 2000);
  // bytes (the server's blank keep-alive lines) keep the watchdog quiet
  const slow = fakeFetch(() => new Response(new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      for (const ch of START) c.enqueue(enc.encode(ch));
      for (let i = 0; i < 4; i++) { await wait(40); c.enqueue(enc.encode('\n')); }
      c.enqueue(enc.encode(rec({ type: 'end' })));
      c.close();
    },
  }), { headers: { 'Content-Type': CONTENT_TYPE } }));
  const r = await streamTurn('/x', {}, { fetch: slow, idleMs: 100 });
  assert.equal(r.failure, null);
});

test('streamTurn: a server `control failed` record returns a classified failure', async () => {
  const f = fakeFetch(() => ndjsonResponse([...START, rec({ type: 'control', detail: { operationId: 'op', kind: 'failed', code: 'overloaded', message: 'Busy', retryAfterMs: 2000 } }), rec({ type: 'end' })]));
  const r = await streamTurn('/x', {}, { fetch: f });
  assert.deepEqual([r.failure.code, r.failure.retryable, r.failure.retryAfterMs], ['overloaded', true, 2000]);
  const g = fakeFetch(() => ndjsonResponse([...START, rec({ type: 'control', detail: { operationId: 'op', kind: 'failed', code: 'bad_request', message: 'No' } }), rec({ type: 'end' })]));
  assert.equal((await streamTurn('/x', {}, { fetch: g })).failure.retryable, false);
});

// ---------------------------------------------------------------- server: supersede + keep-alive

test('inflight registry: a second claim on the same key aborts the first', () => {
  const reg = createInflight();
  const a = reg.claim('lesson:abcdefgh');
  const b = reg.claim('lesson:abcdefgh');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  a.release(); // a stale release does not drop the new holder
  assert.ok(reg.has('lesson:abcdefgh'));
  b.release();
  assert.equal(reg.size, 0);
  assert.equal(reg.claim('other-key-1').signal.aborted, false);
});

/** Fake Claude client whose first stream emits `head` then hangs until aborted; later streams emit `rest`. */
function droppingClient(head, rest) {
  const calls = [];
  const textEvents = (t) => (t.match(/[\s\S]{1,30}/g) || []).map((p) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }));
  return {
    calls,
    beta: { messages: { stream(params, { signal } = {}) {
      const n = calls.push({ params, signal });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { id: 'msg' } };
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          for (const e of textEvents(n === 1 ? head : rest)) yield e;
          if (n === 1) await new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })), { once: true }));
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
        },
        async finalMessage() { return { stop_reason: 'end_turn', content: [] }; },
      };
    } } },
  };
}

/** A fetch whose response body errors (connection lost) once `cutAfter(text)` says so. */
function droppingFetch(cutAfter) {
  return async (url, init) => {
    const res = await fetch(url, init);
    const reader = res.body.getReader();
    let seen = '';
    const dec = new TextDecoder();
    return new Response(new ReadableStream({
      async pull(c) {
        const { value, done } = await reader.read();
        if (done) { c.close(); return; }
        seen += dec.decode(value, { stream: true });
        c.enqueue(value);
        if (cutAfter(seen)) { reader.cancel().catch(() => {}); c.error(new TypeError('network error')); }
      },
    }), { status: res.status, headers: res.headers });
  };
}

const FULL = '# Steady lesson\n\nA hook sentence here.\n\n## Page one\n\nFirst page text.\n\n## Page two\n\nSecond page text, which is long enough to be cut partway through.\n\n## Page three\n\nThird page text.\n\n## Check your understanding\n\nQuiz here.\n';
const HEAD = FULL.slice(0, FULL.indexOf('which is long'));

test('Claude lesson: a mid-stream drop, then the client\'s retry continues it with no duplicate pages; the server aborted the dropped upstream first', async () => {
  // the continuation (like a real model resuming mid-page) restates page two's heading and
  // first sentence; the continuation guard drops the repeat
  const REST = '## Page two\n\nSecond page text, which is long enough to be cut partway through.\n\n## Page three\n\nThird page text.\n\n## Check your understanding\n\nQuiz here.\n';
  const client = droppingClient(HEAD, REST);
  await withServer({ mode: 'claude', client }, async (base) => {
    const body = { topic: 'steady', level: 'beginner', variant: 'story', streamKey: 'lesson-abc-12345678', useWebSearch: false };
    let latest = null;
    let messageId = null;
    const first = streamTurn(`${base}/api/lesson/stream`, body, {
      fetch: droppingFetch((seen) => seen.includes('Page two')),
      onContent: (msg, r) => { latest = msg; messageId = r.messageId; },
    });
    const err = await first.catch((e) => e);
    assert.ok(err instanceof StreamError && err.kind === 'network' && err.retryable, 'a dropped body is a retryable network failure');
    assert.ok(latest.markdown.includes('## Page two'), 'pages already received are kept on the client');
    // no double-charging: the server noticed the closed connection and aborted the upstream
    for (let i = 0; i < 50 && !client.calls[0].signal.aborted; i++) await wait(10);
    assert.equal(client.calls[0].signal.aborted, true);
    // the retry: same request + continueFrom (what app.js sends)
    const r = await streamTurn(`${base}/api/lesson/stream`, { ...body, continueFrom: { markdown: latest.markdown, messageId, sources: sourcesFromAppData(latest.dil?.appData) } });
    assert.equal(r.failure, null);
    assert.equal(r.message.messageId, messageId, 'the lesson keeps its message id');
    assert.equal(r.message.markdown, FULL);
    assert.deepEqual(pageTitles(r.message.markdown), ['Page one', 'Page two', 'Page three', 'Check your understanding'], 'no page twice');
    // the continuation request carries the original request (variant included) + the kept text, no prefill
    const cont = client.calls[1].params;
    const userText = JSON.stringify(cont.messages);
    assert.equal(cont.messages.length, 1);
    assert.match(userText, /connection dropped/);
    assert.match(userText, /Page one/);
  });
});

test('demo lesson: a drop mid-stream, then a resume, reproduces the lesson exactly once', async () => {
  const full = demo('sky-blue.md');
  await withServer({ mode: 'demo', demoDelayMs: 1 }, async (base) => {
    const body = { topic: 'why is the sky blue', streamKey: 'lesson-sky-12345678', useWebSearch: false };
    let latest = null;
    let messageId = null;
    const err = await streamTurn(`${base}/api/lesson/stream`, body, {
      fetch: droppingFetch((seen) => (seen.match(/\\n## /g) || []).length >= 2),
      onContent: (msg, r) => { latest = msg; messageId = r.messageId; },
    }).catch((e) => e);
    assert.ok(err?.retryable);
    assert.ok(pageCount(latest.markdown) >= 1 && latest.markdown.length < full.length);
    const r = await streamTurn(`${base}/api/lesson/stream`, { ...body, continueFrom: { markdown: latest.markdown, messageId } });
    assert.equal(stripGroundingTags(r.message.markdown), full);
    const titles = pageTitles(r.message.markdown);
    assert.equal(new Set(titles).size, titles.length, 'no duplicate pages');
  });
});

test('a new request with the same streamKey aborts the older one on the server before it streams', async () => {
  const client = droppingClient('# Old\n\nOld text.\n\n', '# New\n\nNew text.\n');
  await withServer({ mode: 'claude', client }, async (base) => {
    const body = { topic: 'steady', streamKey: 'lesson-same-12345678', useWebSearch: false, verify: false };
    const ac = new AbortController();
    const old = streamTurn(`${base}/api/lesson/stream`, body, { signal: ac.signal }).catch((e) => e); // never aborted by the client
    for (let i = 0; i < 100 && client.calls.length < 1; i++) await wait(10);
    const r = await streamTurn(`${base}/api/lesson/stream`, body);
    assert.equal(client.calls[0].signal.aborted, true, 'superseded upstream aborted');
    assert.equal(r.message.status, 'complete');
    const e = await old;
    assert.ok(e instanceof StreamError && e.kind === 'network', 'the superseded response just ends');
  });
});

test('the server writes a blank keep-alive line while a stream is quiet', async () => {
  const client = droppingClient('# T\n\n', '');
  await withServer({ mode: 'claude', client, heartbeatMs: 20 }, async (base) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/lesson/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'x', useWebSearch: false }), signal: ac.signal });
    const reader = res.body.getReader();
    let text = '';
    const t0 = Date.now();
    while (!/\n\n\n/.test(text) && Date.now() - t0 < 2000) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    assert.match(text, /\n\n\n/, 'blank lines between records');
  });
});

// ---------------------------------------------------------------- Teacher: replay, not re-run

test('turn ledger: keys, replay with the same resolution id, read-only tools re-run', async () => {
  assert.equal(toolCallKey('create_lesson', { topic: ' Mean  and Median ', level: 'beginner', reason: 'a' }), toolCallKey('create_lesson', { topic: 'mean and median', level: 'beginner', reason: 'b' }));
  assert.equal(toolCallKey('get_progress', {}), null);
  const ledger = createTurnLedger();
  let runs = 0;
  const exec = async (name, input) => { runs++; return name === 'get_progress' ? { content: '{}' } : { content: `ok ${input.fact}`, card: { kind: 'memory', state: { n: runs } } }; };
  const a = ledger.open('turn-aaaa-1111').wrap(exec);
  const r1 = await a('remember', { fact: 'Likes maps.', kind: 'preference' });
  await a('get_progress', {});
  const t2 = ledger.open('turn-aaaa-1111');
  assert.equal(t2.attempt, 2);
  assert.deepEqual(t2.recorded, [{ name: 'remember', args: { fact: 'Likes maps.', kind: 'preference' } }]);
  const b = t2.wrap(exec);
  const r2 = await b('remember', { fact: 'likes maps.', kind: 'preference' });
  await b('get_progress', {});
  assert.equal(runs, 3, 'remember ran once; get_progress twice');
  assert.equal(r2.card.rid, r1.card.rid);
  assert.equal(r2.replayed, true);
  assert.match(retryNote(t2.recorded), /remember \{"fact":"Likes maps\."/);
  assert.equal(retryNote([]), '');
});

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('Teacher retry after a mid-reply failure: remember is not saved twice, the card keeps its id, the retry note reaches the model', async () => {
  const overloaded = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 'x', undefined);
  const remember = tool('t1', 'remember', { fact: 'Studies on the train.', kind: 'preference' });
  const client = fakeToolClient([
    // attempt 1: remember runs, then the stream dies partway through the reply text
    { content: [{ type: 'text', text: 'Noted. ' }, remember], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Here is how to use your commute' }], error: overloaded },
    // attempt 2 (the retry): the model calls remember again with the same fact
    { content: [{ type: 'text', text: 'Noted. ' }, { ...remember, id: 't2' }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Here is how to use your commute.' }], stop_reason: 'end_turn' },
  ]);
  const memory = createMemoryStore({ file: null });
  let added = 0;
  const add = memory.add.bind(memory);
  memory.add = (x) => { added++; return add(x); };
  await withServer({ mode: 'claude', client, memory }, async (base) => {
    const body = { message: 'I study on the train', turnId: 'turn-train-12345678', history: [] };
    const r1 = await streamTurn(`${base}/api/teacher/stream`, body);
    assert.equal(r1.failure.code, 'overloaded');
    assert.equal(r1.failure.retryable, true);
    const rid1 = /__resolutionId="([^"]+)"/.exec(r1.message.markdown)[1];
    const r2 = await streamTurn(`${base}/api/teacher/stream`, body);
    assert.equal(r2.failure, null);
    const rid2 = /__resolutionId="([^"]+)"/.exec(r2.message.markdown)[1];
    assert.equal(rid2, rid1, 'the replayed card keeps its resolution id');
    assert.equal(added, 1, 'memory.add ran once across both attempts');
    assert.equal(memory.list().length, 1);
    const state = r2.message.dil.appData.opGenui.componentResults[rid2].state;
    assert.equal(state.status, 'saved');
    assert.match(JSON.stringify(client.calls[2].params), /This reply is a retry/);
    assert.doesNotMatch(JSON.stringify(client.calls[0].params), /This reply is a retry/);
    // tool_result content of the replay is the recorded one
    assert.match(JSON.stringify(client.calls[3].params.messages.at(-1)), /Saved to memory as mem-/);
  });
});
