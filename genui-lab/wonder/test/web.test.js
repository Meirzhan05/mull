// The Fetch-API front end used by the Next.js route handlers (server/web.js): same core, same
// records as the node:http server, plus client-disconnect aborts and the read-only static roots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderCore } from '../server/app.js';
import { handleWebRequest, staticResponse } from '../server/web.js';
import { createMemoryStore } from '../server/memory.js';
import { ConversationSourceParser, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const core = (opts = {}) => createWonderCore({ mode: 'demo', demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null, logger: quiet }), ...opts });
const req = (path, { method = 'POST', body, signal } = {}) => new Request(`http://localhost${path}`, {
  method, signal, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
});

async function records(res) {
  const turn = new ConversationTurn();
  const recs = [];
  const parser = new ConversationSourceParser((r) => { turn.apply(r); recs.push(r); });
  parser.push(await res.text());
  parser.finish();
  return { recs, turn };
}

test('web: status, 404s and JSON errors', async () => {
  const c = core();
  const s = await handleWebRequest(c, req('/api/status', { method: 'GET' }), { logger: quiet });
  assert.equal(s.status, 200);
  assert.equal((await s.json()).mode, 'demo');
  assert.equal((await handleWebRequest(c, req('/api/nope', { method: 'GET' }))).status, 404);
  assert.equal((await handleWebRequest(c, req('/api/lesson/stream', { method: 'GET' }))).status, 404, 'wrong method');
  const bad = await handleWebRequest(c, new Request('http://localhost/api/course/plan', { method: 'POST', body: '{not json' }));
  assert.equal(bad.status, 400);
  const missing = await handleWebRequest(c, req('/api/lesson/stream', { body: {} }));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /topic/);
});

test('web: a demo lesson streams as conversation-source NDJSON and completes', async () => {
  const res = await handleWebRequest(core(), req('/api/lesson/stream', { body: { topic: 'Why the sky is blue' } }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith(CONTENT_TYPE));
  const { recs, turn } = await records(res);
  assert.ok(recs.some((r) => r.type === 'reasoning'));
  assert.ok(turn.primary.markdown.startsWith('# '));
  assert.ok(turn.primary.dil?.code, 'compiled DIL program');
  assert.equal(recs.filter((r) => r.type === 'content').at(-1).status, 'complete');
});

test('web: memory CRUD and widget actions go through the same core', async () => {
  const c = core();
  const add = await (await handleWebRequest(c, req('/api/memory', { body: { fact: 'I like worked examples', kind: 'preference' } }))).json();
  assert.equal(add.ok, true);
  const list = await (await handleWebRequest(c, req('/api/memory', { method: 'GET' }))).json();
  assert.equal(list.items.length, 1);
  const del = await (await handleWebRequest(c, req(`/api/memory?id=${encodeURIComponent(add.item.id)}`, { method: 'DELETE' }))).json();
  assert.equal(del.removed, 1);
  const plan = await (await handleWebRequest(c, req('/api/course/plan', { body: { topic: 'Optics' } }))).json();
  assert.ok(plan.plan.sections.length > 0);
});

test('web: a live steer reaches the in-flight lesson stream (shared core)', async () => {
  const c = core({ demoDelayMs: 5 });
  const res = await handleWebRequest(c, req('/api/lesson/stream', { body: { topic: 'Compound interest' } }));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let opId = null;
  let steered = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (!opId) opId = /"operationId":"([^"]+)"/.exec(text)?.[1] || null;
    if (opId && !steered && (text.match(/\n/g) || []).length > 12) {
      steered = await (await handleWebRequest(c, req('/api/lesson/steer', { body: { operationId: opId, instruction: 'Make it simpler' } }))).json();
    }
  }
  assert.ok(opId, 'records carry the operation id');
  assert.equal(steered?.ok, true);
  assert.match(text, /"steering-status"/);
});

test('web: a client disconnect aborts the turn and closes the stream', async () => {
  const ac = new AbortController();
  const res = await handleWebRequest(core({ demoDelayMs: 20 }), req('/api/tutor/stream', { body: { message: 'Explain it again', lessonContext: { title: 'T', markdown: '# T\n\n## A\n\nText.' } }, signal: ac.signal }));
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  let done = false;
  for (let i = 0; i < 50 && !done; i++) ({ done } = await reader.read());
  assert.equal(done, true);
});

test('web: static roots serve the DIL runtime and KaTeX read-only, never app sources', async () => {
  const dil = staticResponse('/chatgpt-dil/src/host.js');
  assert.equal(dil.status, 200);
  assert.match(dil.headers.get('content-type'), /javascript/);
  assert.equal(staticResponse('/wondering-genui/src/fsrs.js').status, 200);
  assert.equal(staticResponse('/vendor/katex/katex.min.js').status, 200);
  assert.equal(staticResponse('/chatgpt-dil/src/../../wonder/server/app.js').status, 404, 'no traversal');
  assert.equal(staticResponse('/chatgpt-dil/package.json').status, 404);
  assert.equal(staticResponse('/server/claude.js').status, 404);
});
