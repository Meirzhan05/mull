// Idle watchdog + network error classification: a silently stalled stream must fail fast with
// a resumable code instead of hanging until the socket dies (seen live: ~9 minutes, then "internal").
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamText, friendlyError, StreamStalledError, idleWatch } from '../server/claude.js';
import { streamGrounded } from '../server/grounding.js';

/** Fake SDK stream: yields `events`, then (if stall) waits until its signal aborts. */
function fakeClient({ events = [], stall = false, throwAfter = null } = {}) {
  return {
    beta: { messages: { stream(_params, { signal } = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
          if (throwAfter) throw throwAfter;
          if (stall) await new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })), { once: true }));
        },
        async finalMessage() { return { stop_reason: 'end_turn', content: [] }; },
      };
    } } },
  };
}
const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

test('streamText: a stalled stream raises StreamStalledError after the idle limit', async () => {
  const seen = [];
  const t0 = Date.now();
  await assert.rejects(
    streamText(fakeClient({ events: [delta('Hello')], stall: true }), {}, { onText: (t) => seen.push(t), idleMs: 60 }),
    (e) => e instanceof StreamStalledError && e.code === 'stalled',
  );
  assert.deepEqual(seen, ['Hello']);
  assert.ok(Date.now() - t0 < 2000);
});

test('streamText: events keep the watchdog alive', async () => {
  const events = Array.from({ length: 5 }, (_, i) => delta(String(i)));
  const r = await streamText(fakeClient({ events }), {}, { idleMs: 60 });
  assert.equal(r.stopReason, 'end_turn');
});

test('streamText: a caller abort is not reported as a stall', async () => {
  const ac = new AbortController();
  const p = streamText(fakeClient({ stall: true }), {}, { signal: ac.signal, idleMs: 10_000 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => !(e instanceof StreamStalledError));
});

test('streamGrounded: stalls are detected too', async () => {
  const start = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  await assert.rejects(
    streamGrounded(fakeClient({ events: [start, delta('# Title')], stall: true }), { messages: [] }, { onText: () => {}, idleMs: 60 }),
    (e) => e instanceof StreamStalledError,
  );
});

test('friendlyError: stalled and network failures are resumable, not "internal"', () => {
  assert.equal(friendlyError(new StreamStalledError(1000)).code, 'stalled');
  assert.equal(friendlyError(new TypeError('terminated')).code, 'network');
  assert.equal(friendlyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).code, 'network');
  assert.equal(friendlyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })).code, 'network');
  assert.equal(friendlyError(new Error('boom')).code, 'internal');
});

test('idleWatch: done() clears the timer and the outer signal listener', async () => {
  const ac = new AbortController();
  const w = idleWatch(ac.signal, 30);
  w.done();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.stalled, false);
  assert.equal(w.signal.aborted, false);
});
