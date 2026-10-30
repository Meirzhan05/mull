// Phase 4: mid-turn steering (abort + continuation, control records, tail replacement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { steeringUserContent, createSteeringRegistry } from '../server/steering.js';
import { trimToLastPage, steerReducer, STEER_CHIPS, pageCount } from '../public/steering-core.js';
import { ConversationSourceParser, ConversationTurn, validateRecord } from '../../chatgpt-dil/src/stream.js';
import { compileWonder } from '../server/compile.js';

const quiet = { warn() {}, error() {}, log() {} };
async function withServer(opts, fn) {
  const server = createWonderServer({ client: null, logger: quiet, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Read an NDJSON response incrementally; `onRecord(rec, turn)` may be async. Returns all records. */
async function readStream(res, onRecord) {
  const recs = [];
  const turn = new ConversationTurn();
  const queue = [];
  const parser = new ConversationSourceParser((r) => { turn.apply(r); recs.push(r); queue.push(r); });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(dec.decode(value, { stream: true }));
    while (queue.length) await onRecord?.(queue.shift(), turn);
  }
  parser.finish();
  return { recs, turn };
}

const LESSON = '# Steady lesson\n\nA hook sentence here.\n\n## Page one\n\nFirst page text that is complete.\n\n## Page two\n\nSecond page is still being wr';

/** Fake client: the first stream emits LESSON slowly and stalls until aborted; later streams emit `rest`. */
function steerableClient(rest) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          const n = calls.push({ params: structuredClone(params), opts });
          const signal = opts?.signal;
          const text = n === 1 ? LESSON : rest;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
              for (const piece of text.match(/[\s\S]{1,12}/g)) {
                if (signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } };
                await new Promise((r) => setTimeout(r, 1));
              }
              if (n === 1) {
                // stall like a long generation until the steer aborts us
                await new Promise((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', resolve, { once: true }); });
                throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
              }
              yield { type: 'content_block_stop', index: 0 };
            },
            async finalMessage() { return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }; },
          };
        },
      },
    },
    messages: { async create() { throw new Error('unused'); } },
  };
}

test('trimToLastPage keeps complete pages only (fence-aware); pageCount', () => {
  assert.equal(trimToLastPage(LESSON), '# Steady lesson\n\nA hook sentence here.\n\n## Page one\n\nFirst page text that is complete.\n\n');
  assert.equal(trimToLastPage('# Title\n\nHook still stream'), '# Title\n');
  assert.equal(trimToLastPage('# Tit'), '');
  assert.equal(trimToLastPage('# T\n\n## A\n\n```md\n## not a page\n```\n\nmore'), '# T\n\n');
  assert.equal(pageCount(LESSON), 2);
});

test('steerReducer tracks request -> accepted/rejected -> idle', () => {
  let s = steerReducer(null, { type: 'request', instruction: 'Simpler' });
  assert.equal(s.status, 'pending');
  s = steerReducer(s, { type: 'control', detail: { kind: 'steering-status', status: 'accepted' } });
  assert.deepEqual([s.status, s.count], ['accepted', 1]);
  s = steerReducer(s, { type: 'control', detail: { kind: 'steering-status', status: 'rejected', reason: 'busy' } });
  assert.deepEqual([s.status, s.count, s.reason], ['rejected', 1, 'busy']);
  assert.equal(steerReducer(s, { type: 'complete' }).status, 'idle');
  assert.equal(STEER_CHIPS.map((c) => c.label).join('|'), 'Simpler|More examples|Go deeper|Shorter');
});

test('continuation user turn: original request + lesson so far (cites stripped) + instruction', () => {
  const content = steeringUserContent('Write a lesson about: sky', '# Sky\n\nBlue<Cite refs={["turn0search0"]}/>.\n\n', 'Simpler please');
  assert.equal(content.length, 2);
  assert.equal(content[0].text, 'Write a lesson about: sky');
  assert.match(content[1].text, /<lesson_so_far>\n# Sky\n\nBlue\.\n<\/lesson_so_far>/);
  assert.match(content[1].text, /"Simpler please"/);
  assert.match(content[1].text, /Continue the lesson from here/);
  assert.doesNotMatch(content[1].text, /Cite/);
});

test('steering a Claude lesson: abort, steering controls, replace record, continuation request shape', async () => {
  const rest = '## Page two, simpler\n\nShort and simple.\n\n## Check your understanding\n\nDone.\n';
  const client = steerableClient(rest);
  await withServer({ client }, async (base) => {
    let steered = null;
    const res = await post(base, '/api/lesson/stream', { topic: 'steady', useWebSearch: false });
    let op = null;
    const { recs, turn } = await readStream(res, async (rec, t) => {
      if (rec.type === 'control') op ??= rec.detail.operationId;
      if (!steered && rec.type === 'content' && /still being wr$/.test(t.primary.markdown)) {
        steered = await (await post(base, '/api/lesson/steer', { operationId: op, instruction: 'Simpler' })).json();
      }
    });
    assert.deepEqual(steered, { ok: true, status: 'accepted', operationId: recs[0].detail.operationId });
    for (const r of recs) validateRecord(r); // every record passes chatgpt-dil's validator

    const kinds = recs.filter((r) => r.type === 'control').map((r) => r.detail.kind);
    assert.ok(kinds.indexOf('steering-status') > 0 && kinds.indexOf('steering-message') > kinds.indexOf('steering-status'));
    const status = recs.find((r) => r.detail?.kind === 'steering-status').detail;
    assert.deepEqual([status.status, status.instruction], ['accepted', 'Simpler']);
    assert.ok(recs.every((r) => r.type !== 'control' || r.detail.operationId === status.operationId), 'same operation throughout');

    // the kept pages arrive as a replace with a strictly higher revision, then appends continue
    const contents = recs.filter((r) => r.type === 'content');
    const replace = contents.find((r) => r.mode === 'replace' && r.revision > 1);
    assert.equal(replace.markdown, trimToLastPage(LESSON));
    assert.ok(replace.dil, 'replace record carries a recompiled program');
    for (let i = 1; i < contents.length; i++) assert.ok(contents[i].revision > contents[i - 1].revision);
    assert.equal(turn.primary.markdown, trimToLastPage(LESSON) + rest);
    assert.equal(turn.primary.status, 'complete');
    assert.ok(recs.some((r) => r.type === 'reasoning' && r.status.text === 'Steering: Simpler'));

    // continuation: a single user turn (no prefill) holding the request, the kept pages and the instruction
    assert.equal(client.calls.length, 2);
    assert.ok(client.calls[0].opts.signal.aborted, 'first stream was aborted');
    const msgs = client.calls[1].params.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.match(msgs[0].content[0].text, /Write a lesson about: steady/);
    assert.match(msgs[0].content[1].text, /## Page one\n\nFirst page text that is complete\.\n<\/lesson_so_far>/);
    assert.doesNotMatch(msgs[0].content[1].text, /still being wr/, 'the unfinished page is dropped');
    assert.match(msgs[0].content[1].text, /"Simpler"/);
    assert.deepEqual(client.calls[1].params.thinking, { type: 'adaptive' });
    assert.equal(client.calls[1].params.system[0].text, client.calls[0].params.system[0].text, 'same cached system prompt');

    // after the turn the operation is gone: steering is rejected
    const late = await post(base, '/api/lesson/steer', { operationId: status.operationId, instruction: 'Shorter' });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).status, 'rejected');
  });
});

test('client-side tail replacement: ConversationTurn keeps earlier pages and swaps the tail', () => {
  const mid = 'm1';
  const recs = [
    { version: 2, type: 'content', messageId: mid, revision: 1, mode: 'replace', markdown: '', status: 'streaming' },
    { version: 2, type: 'content', messageId: mid, revision: 2, mode: 'append', baseRevision: 1, markdown: LESSON, status: 'streaming' },
    { version: 2, type: 'content', messageId: mid, revision: 3, mode: 'replace', markdown: trimToLastPage(LESSON), status: 'streaming' },
    { version: 2, type: 'content', messageId: mid, revision: 4, mode: 'append', baseRevision: 3, markdown: '## New tail\n\nSimple.\n', status: 'complete' },
  ];
  const turn = new ConversationTurn();
  for (const r of recs) turn.apply(validateRecord(r));
  assert.equal(turn.primary.markdown, trimToLastPage(LESSON) + '## New tail\n\nSimple.\n');
  assert.throws(() => turn.apply({ version: 2, type: 'content', messageId: mid, revision: 4, mode: 'replace', markdown: 'x' }), /revision mismatch/);
  // kept pages compile to the same program prefix, so components in them keep their identity
  const a = compileWonder(trimToLastPage(LESSON), { salt: mid });
  const b = compileWonder(turn.primary.markdown, { salt: mid });
  assert.ok(b.code.length > a.code.length);
});

test('steer endpoint validates input; a second steer while one is applying is rejected', async () => {
  await withServer({}, async (base) => {
    assert.equal((await post(base, '/api/lesson/steer', { operationId: 'x', instruction: '' })).status, 400);
    const r = await post(base, '/api/lesson/steer', { operationId: 'nope', instruction: 'Simpler' });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { ok: false, status: 'rejected', reason: 'not_streaming', error: 'This lesson has finished streaming.' });
  });
  const reg = createSteeringRegistry();
  const rejected = [];
  const op = reg.open('op1', new AbortController().signal, { onReject: (why) => rejected.push(why) });
  const sig = op.attempt();
  assert.equal(op.steer('a'), true);
  assert.equal(sig.aborted, true);
  assert.equal(op.steer('b'), false);
  assert.deepEqual(rejected, ['busy']);
  assert.equal(op.takeSteer(), 'a');
  op.close();
  assert.equal(reg.get('op1'), null);
});
