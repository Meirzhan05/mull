// Phase 10: the learner's own material: store, document blocks, citations to it, lessons and
// courses taught from it, and the demo fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaterialStore, documentBlock, materialCitation, materialTitle, demoMaterialLesson, demoMaterialCourse, isMaterialUrl, MAX_TEXT_CHARS, PART_BYTES, MAX_PDF_BYTES, MAX_MATERIAL_TOKENS, MAX_OPEN_UPLOADS, UPLOAD_MAX_AGE_MS, newUploadId, createPartStore, pruneUploads, takeUpload } from '../server/materials.js';
import { createSourceRegistry } from '../server/grounding.js';
import Anthropic from '@anthropic-ai/sdk';
import { createWonderServer } from '../server/app.js';
import { parseConversationSource, ConversationTurn } from '../../chatgpt-dil/src/stream.js';
import { runProgram, catalogNodes } from './helpers.js';

const NOTES = '# Photosynthesis\n\nPlants turn light, water and carbon dioxide into glucose and oxygen. The light reactions happen in the thylakoids.\n\n## The Calvin cycle\n\nThe Calvin cycle fixes carbon dioxide into sugars in the stroma, using ATP and NADPH from the light reactions.';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const quiet = { warn() {}, error() {}, info() {}, log() {} };

test('materials store: text and PDF, limits, safe ids, persistence and delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonder-mat-'));
  try {
    const store = createMaterialStore({ dir });
    assert.match(store.add({ kind: 'text', text: 'too short' }).error, /at least a paragraph/);
    assert.match(store.add({ kind: 'text', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }).error, /too long/);
    assert.match(store.add({ kind: 'pdf', base64: Buffer.from('hello world, not a pdf').toString('base64') }).error, /not a PDF/);
    const t = store.add({ kind: 'text', text: `${NOTES}\r\n` });
    assert.ok(t.ok);
    assert.match(t.item.id, /^mat-[0-9a-f]{12}$/);
    assert.equal(t.item.title, 'Photosynthesis', 'first line, heading marks dropped');
    const p = store.add({ kind: 'pdf', base64: `data:application/pdf;base64,${PDF.toString('base64')}`, filename: 'Bio ch3.pdf' });
    assert.ok(p.ok, p.error);
    assert.equal(p.item.title, 'Bio ch3');
    assert.equal(p.item.bytes, PDF.length);
    // a fresh store reads the index back
    const again = createMaterialStore({ dir });
    assert.deepEqual(again.list().map((m) => m.id), [p.item.id, t.item.id]);
    assert.equal(again.read(t.item.id), NOTES);
    assert.ok(Buffer.isBuffer(again.read(p.item.id)));
    // ids never become paths
    for (const bad of ['../index', 'mat-../../x', 'index.json', '']) { assert.equal(again.meta(bad), null); assert.equal(again.read(bad), null); }
    assert.equal(again.remove(t.item.id).id, t.item.id);
    assert.equal(fs.existsSync(path.join(dir, `${t.item.id}.txt`)), false);
    assert.equal(createMaterialStore({ dir }).size, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(materialTitle({ title: '  My  notes ' }), 'My notes');
});

test('document blocks: text and PDF sources, citations on, cached', () => {
  const t = documentBlock({ kind: 'text', title: 'Notes' }, 'abc');
  assert.deepEqual(t, { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'abc' }, title: 'Notes', citations: { enabled: true }, cache_control: { type: 'ephemeral' } });
  const p = documentBlock({ kind: 'pdf', title: 'Ch 3' }, PDF, { citations: false });
  assert.equal(p.source.type, 'base64');
  assert.equal(p.source.media_type, 'application/pdf');
  assert.equal(Buffer.from(p.source.data, 'base64').toString('latin1'), PDF.toString('latin1'));
  assert.ok(!('citations' in p));
});

test('citations: char_location -> one source per text material, page_location -> one per PDF page', () => {
  const docs = [{ id: 'mat-0123456789ab', title: 'Bio notes', kind: 'pdf' }];
  const map = materialCitation(docs);
  const reg = createSourceRegistry();
  const cite = (c) => reg.cite(map(c));
  const r1 = cite({ type: 'page_location', document_index: 0, start_page_number: 4, end_page_number: 5, cited_text: 'The Calvin cycle…' });
  const r2 = cite({ type: 'page_location', document_index: 0, start_page_number: 4, end_page_number: 5, cited_text: 'again' });
  const r3 = cite({ type: 'page_location', document_index: 0, start_page_number: 7, end_page_number: 8, cited_text: 'x' });
  assert.equal(r1, r2, 'same page, same source');
  assert.notEqual(r1, r3);
  assert.deepEqual(reg.get(r1), { ref: r1, index: 1, url: '/api/materials/file?id=mat-0123456789ab#page=4', title: 'Bio notes, p. 4', domain: 'Your material', snippet: 'The Calvin cycle…' });
  assert.equal(cite({ type: 'char_location', document_index: 3, cited_text: 'x' }), null, 'unknown document');
  const web = { type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', cited_text: 't' };
  assert.equal(map(web), web, 'web citations pass through');
  assert.ok(isMaterialUrl('/api/materials/file?id=mat-0123456789ab'));
  assert.ok(!isMaterialUrl('/api/materials/file?id=mat-0123456789ab&x=javascript:'));
});

/** Fake client: a lesson whose text blocks carry document citations (char_location). */
function citingClient(blocks) {
  const calls = { stream: [], create: [] };
  return {
    calls,
    beta: { messages: { stream(params) {
      calls.stream.push(structuredClone(params));
      const content = blocks.map((b) => ({ type: 'text', text: b.text, ...(b.cite ? { citations: [b.cite] } : {}) }));
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { id: 'm1' } };
          for (const [i, b] of blocks.entries()) {
            yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } };
            if (b.cite) yield { type: 'content_block_delta', index: i, delta: { type: 'citations_delta', citation: b.cite } };
            yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } };
            yield { type: 'content_block_stop', index: i };
          }
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
        },
        async finalMessage() { return { id: 'm1', stop_reason: 'end_turn', content }; },
      };
    } } },
    messages: { async create(params) { calls.create.push(structuredClone(params)); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: 'Photosynthesis', description: 'd', sections: [{ title: 'S1', lessons: [{ title: 'Light reactions', summary: 's' }] }] }) }] }; } },
  };
}

async function withServer(opts, fn) {
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memoryFile: null, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('lesson from material: document block + instruction, no web search, citations become Cite pills', async () => {
  const client = citingClient([
    { text: '# Photosynthesis\n\nHow plants eat light.\n\n## Light reactions\n\nLight reactions happen in the thylakoids.', cite: { type: 'char_location', document_index: 0, document_title: 'Photosynthesis', start_char_index: 120, end_char_index: 170, cited_text: 'The light reactions happen in the thylakoids.' } },
    { text: '\n\nThen comes the Calvin cycle.\n' },
  ]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const add = await (await post(base, '/api/materials', { kind: 'text', text: NOTES })).json();
    assert.ok(add.ok);
    const id = add.item.id;
    const res = await post(base, '/api/lesson/stream', { topic: 'Photosynthesis', materialId: id });
    const recs = parseConversationSource(await res.text());
    const turn = new ConversationTurn();
    for (const r of recs) turn.apply(r);
    const msg = turn.primary;
    assert.equal(msg.status, 'complete');
    assert.match(msg.markdown, /thylakoids\.<Cite refs=\{\["turn0search0"\]\}\/>/);
    assert.match(msg.markdown, /<Sources\/>/);
    const env = runProgram(msg.dil);
    assert.deepEqual(env.errors, []);
    const cite = Object.values(msg.dil.appData.opGenui.componentResults).find((r) => r.state?.active_index === 0);
    assert.equal(cite.state.items[0].url, `/api/materials/file?id=${id}`);
    assert.equal(cite.state.items[0].domain, 'Your material');
    assert.ok(catalogNodes(env.mirror, 'Sources').length);

    const p = client.calls.stream[0];
    const content = p.messages[0].content;
    assert.equal(content[0].type, 'document');
    assert.deepEqual(content[0].citations, { enabled: true });
    assert.equal(content[0].source.data, NOTES);
    assert.match(content[1].text, /Teach this from the attached material "Photosynthesis"/);
    assert.ok(!(p.tools || []).some((t) => t.name === 'web_search'), 'material lessons do not search the web by default');

    // the original is served back for "Open source"
    const file = await fetch(`${base}/api/materials/file?id=${id}`);
    assert.equal(file.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await file.text(), NOTES);
    // unknown material: a clear 404 before any stream starts
    const gone = await post(base, '/api/lesson/stream', { topic: 'x', materialId: 'mat-000000000000' });
    assert.equal(gone.status, 404);
  });
});

test('course from material: structured plan with the document (no citations), course follows it', async () => {
  const client = citingClient([]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const { item } = await (await post(base, '/api/materials', { kind: 'text', text: NOTES })).json();
    const r = await (await post(base, '/api/course/plan', { topic: item.title, materialId: item.id })).json();
    assert.equal(r.plan.title, 'Photosynthesis');
    const params = client.calls.create[0];
    assert.equal(params.messages[0].content[0].type, 'document');
    assert.ok(!('citations' in params.messages[0].content[0]), 'citations do not combine with structured output');
    assert.match(params.messages[0].content[1].text, /following its structure and order/);
  });
});

test('demo mode: a lesson outline and a course from the material\'s own headings', async () => {
  const md = demoMaterialLesson({ title: 'Photosynthesis' }, NOTES);
  assert.match(md, /^# Photosynthesis\n/);
  assert.match(md, /## The Calvin cycle/);
  assert.match(md, /<Callout title="Key idea" tone="insight">The Calvin cycle fixes carbon dioxide/);
  const course = demoMaterialCourse({ title: 'Photosynthesis' }, NOTES);
  assert.deepEqual(course.sections[0].lessons.map((l) => l.title), ['Photosynthesis', 'The Calvin cycle']);
  await withServer({ mode: 'demo' }, async (base) => {
    const { item } = await (await post(base, '/api/materials', { kind: 'text', text: NOTES })).json();
    const recs = parseConversationSource(await (await post(base, '/api/lesson/stream', { topic: item.title, materialId: item.id })).text());
    const turn = new ConversationTurn();
    for (const r of recs) turn.apply(r);
    assert.match(turn.primary.markdown, /Demo mode: a page-by-page outline of your material/);
    assert.deepEqual(runProgram(turn.primary.dil).errors, []);
    const list = await (await fetch(`${base}/api/materials`)).json();
    assert.equal(list.items.length, 1);
    const del = await (await fetch(`${base}/api/materials?id=${item.id}`, { method: 'DELETE' })).json();
    assert.equal(del.items.length, 0);
  });
});

// ---------------------------------------------------------------- Next.js Fetch adapter

import { createWonderCore, MAX_BODY } from '../server/app.js';
import { handleWebRequest } from '../server/web.js';

test('web adapter: a PDF larger than the JSON limit uploads to /api/materials only; the file comes back raw', async () => {
  const core = createWonderCore({ mode: 'demo', demoDelayMs: 0, logger: quiet, memoryFile: null });
  const big = Buffer.concat([PDF, Buffer.alloc(MAX_BODY, 0x20)]); // base64 of this exceeds MAX_BODY
  const body = JSON.stringify({ kind: 'pdf', base64: big.toString('base64'), filename: 'Big notes.pdf' });
  assert.ok(Buffer.byteLength(body) > MAX_BODY);
  const send = (path, b, method = 'POST') => handleWebRequest(core, new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: b }), { logger: quiet });
  assert.equal((await send('/api/course/plan', body)).status, 413, 'other routes keep the 2 MB limit');
  const up = await send('/api/materials', body);
  assert.equal(up.status, 200);
  const { item } = await up.json();
  assert.equal(item.bytes, big.length);
  const file = await handleWebRequest(core, new Request(`http://localhost/api/materials/file?id=${item.id}`), { logger: quiet });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString('latin1'), '%PDF-');
  const del = await handleWebRequest(core, new Request(`http://localhost/api/materials?id=${item.id}`, { method: 'DELETE' }), { logger: quiet });
  assert.equal((await del.json()).items.length, 0);
});

test('web adapter: a PDF over Vercel\'s 4.5 MB body cap goes up in parts, each request under it', async () => {
  const VERCEL_BODY_CAP = 4.5 * 1024 * 1024;
  const core = createWonderCore({ mode: 'demo', demoDelayMs: 0, logger: quiet, memoryFile: null });
  const book = Buffer.concat([PDF, Buffer.alloc(7 * 1024 * 1024, 0x20)]);
  const send = async (path, payload) => {
    const b = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(b) < VERCEL_BODY_CAP, `${path} body is ${Buffer.byteLength(b)} bytes`);
    const res = await handleWebRequest(core, new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b }), { logger: quiet });
    return { status: res.status, body: await res.json() };
  };
  const total = Math.ceil(book.length / PART_BYTES);
  let upload = null;
  for (let index = 0; index < total; index++) {
    const r = await send('/api/materials/part', { upload, index, total, base64: book.subarray(index * PART_BYTES, (index + 1) * PART_BYTES).toString('base64') });
    assert.equal(r.status, 200);
    upload = r.body.upload;
  }
  assert.match(upload, /^up-[0-9a-f]{16}$/);
  const done = await send('/api/materials', { kind: 'pdf', upload, parts: total, filename: 'Book.pdf' });
  assert.equal(done.status, 200);
  assert.equal(done.body.item.bytes, book.length);
  assert.equal(done.body.item.title, 'Book');
  const file = await handleWebRequest(core, new Request(`http://localhost/api/materials/file?id=${done.body.item.id}`), { logger: quiet });
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(book), 'the parts are put back together in order');
  // the parts are gone once used; a missing part, a forged id or a too-large file is refused
  assert.equal((await send('/api/materials', { kind: 'pdf', upload, parts: total })).status, 400);
  const first = await send('/api/materials/part', { index: 0, total: 2, base64: PDF.toString('base64') });
  assert.equal((await send('/api/materials', { kind: 'pdf', upload: first.body.upload, parts: 2 })).status, 400);
  assert.equal((await send('/api/materials/part', { upload: '../x', index: 1, total: 2, base64: 'AAAA' })).status, 400);
  assert.equal((await send('/api/materials/part', { index: 0, total: Math.ceil(MAX_PDF_BYTES / PART_BYTES) + 1, base64: 'AAAA' })).status, 400);
  // the size limit itself: a 20 MB book is kept, a byte more is refused
  assert.equal(MAX_PDF_BYTES, 20 * 1024 * 1024);
  const store = createMaterialStore({ dir: null });
  const atLimit = Buffer.concat([PDF, Buffer.alloc(MAX_PDF_BYTES - PDF.length, 0x20)]);
  assert.equal(store.add({ kind: 'pdf', bytes: atLimit }).ok, true);
  assert.match(store.add({ kind: 'pdf', bytes: Buffer.concat([atLimit, Buffer.from(' ')]) }).error, /the limit is 20 MB/);
});

test('upload parts: abandoned uploads are pruned; only exactly the stated parts are put together', async () => {
  const now = Date.now();
  const parts = createPartStore();
  const old = newUploadId(now - UPLOAD_MAX_AGE_MS - 1000);
  const recent = [3, 2, 1].map((m) => newUploadId(now - m * 60_000)); // oldest first
  for (const u of [old, ...recent]) await parts.put(u, 0, Buffer.from('x'));
  await pruneUploads(parts, now);
  assert.deepEqual((await parts.list()).sort(), recent.slice(-MAX_OPEN_UPLOADS).map((u) => `${u}.0`).sort(), 'the stale one and all but the newest are gone');
  // five parts stored, four claimed: refused (a truncated PDF is never saved), and none are left behind
  const u = newUploadId(now);
  for (let i = 0; i < 5; i++) await parts.put(u, i, Buffer.from(`${i}`));
  assert.equal(await takeUpload(parts, u, 4), null);
  assert.equal((await parts.list()).filter((k) => k.startsWith(u)).length, 0);
  for (let i = 0; i < 3; i++) await parts.put(u, i, Buffer.from(`${i}`));
  assert.equal((await takeUpload(parts, u, 3)).toString(), '012');
});

test('Claude mode: a material too long for a lesson is refused at upload, with Claude\'s own reason for an unreadable one', async () => {
  let answer = { input_tokens: MAX_MATERIAL_TOKENS + 1 };
  const client = { messages: { countTokens: async () => { if (answer instanceof Error) throw answer; return answer; } } };
  const core = createWonderCore({ mode: 'claude', client, demoDelayMs: 0, logger: quiet, memoryFile: null });
  const add = async () => (await handleWebRequest(core, new Request('http://localhost/api/materials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'pdf', base64: PDF.toString('base64'), filename: 'Book.pdf' }) }), { logger: quiet })).json();
  assert.match((await add()).error, /too long for one lesson .*the limit is 800k/);
  answer = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'A maximum of 600 PDF pages may be provided.' } }, undefined, new Headers());
  assert.match((await add()).error, /Claude can't read that file: A maximum of 600 PDF pages/);
  answer = new Error('socket hang up');
  const kept = await add();
  assert.equal(kept.ok, true, 'a counting hiccup keeps the material');
  assert.equal(kept.item.tokens, undefined);
  answer = { input_tokens: 120_000 };
  assert.equal((await add()).item.tokens, 120_000);
});
