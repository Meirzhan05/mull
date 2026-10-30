// Learner memory: the JSON store (CRUD, caps, de-duplication, atomic file writes), the
// /api/memory endpoints, post-lesson extraction, and injection into lesson / tutor prompts
// after the cache breakpoint (omitted when the request has memoryEnabled:false).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore, isDuplicateFact, cleanFact, MAX_ITEMS } from '../server/memory.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../server/prompts.js';
import { fakeClient } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wonder-mem-')), 'data', 'memory.json');

async function withServer(opts, fn) {
  const memory = opts.memory ?? createMemoryStore({ file: null });
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memory, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, memory, server); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const req = async (base, method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('memory store: add/list/remove/restore/clear, persisted atomically to a JSON file', () => {
  const file = tmpFile();
  const m = createMemoryStore({ file, logger: quiet });
  assert.equal(m.size, 0, 'missing file -> empty store');
  const a = m.add({ fact: 'Wants to learn statistics in a week.', kind: 'goal', source: 'teacher' });
  const b = m.add({ fact: '  Likes   worked examples ', kind: 'preference' });
  assert.equal(a.ok && b.ok, true);
  assert.equal(b.item.fact, 'Likes worked examples');
  assert.equal(b.item.source, 'user');
  assert.match(a.item.id, /^mem-[0-9a-f]{8}$/);
  assert.deepEqual(m.list().map((i) => i.id), [b.item.id, a.item.id], 'newest first');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.items.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['memory.json'], 'no temp files left behind');
  const again = createMemoryStore({ file, logger: quiet });
  assert.equal(again.size, 2, 'reloads from disk');
  const removed = again.remove(a.item.id);
  assert.equal(removed.fact, a.item.fact);
  assert.equal(again.remove('mem-nothere'), null);
  assert.equal(again.restore(removed).ok, true);
  assert.equal(again.get(a.item.id).createdAt, a.item.createdAt, 'restore keeps id and timestamp');
  assert.equal(again.clear(), 2);
  assert.equal(createMemoryStore({ file, logger: quiet }).size, 0);
  assert.equal(m.add({ fact: '', kind: 'goal' }).ok, false);
  assert.equal(m.add({ fact: 'x', kind: 'nope' }).ok, false);
});

test('memory store caps: at most 100 items (oldest dropped), facts at most 200 chars, markup stripped; corrupt file starts empty', () => {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const m = createMemoryStore({ file: null, now: () => new Date((t += 1000)) });
  for (let i = 0; i < MAX_ITEMS + 5; i++) m.add({ fact: `Fact number ${i} about topic ${i * 7919}`, kind: 'background' });
  assert.equal(m.size, MAX_ITEMS);
  assert.match(m.list().at(-1).fact, /^Fact number 5 /, 'oldest five were dropped');
  const long = m.add({ fact: 'word '.repeat(80), kind: 'goal' });
  assert.ok(long.item.fact.length <= 200);
  assert.equal(cleanFact('Use <script>{x}</script> carefully'), 'Use scriptx/script carefully');
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.equal(createMemoryStore({ file, logger: quiet }).size, 0);
});

test('memory de-duplication: same fact in other words is not stored twice', () => {
  const m = createMemoryStore({ file: null });
  const a = m.add({ fact: 'Knows basic algebra.', kind: 'background' });
  const b = m.add({ fact: 'knows basic algebra', kind: 'background' });
  assert.equal(b.duplicate, true);
  assert.equal(b.item.id, a.item.id);
  assert.equal(m.size, 1);
  assert.equal(isDuplicateFact('Confuses variance and standard deviation often', 'Often confuses variance and standard deviation'), true);
  assert.equal(isDuplicateFact('Likes analogies', 'Likes worked examples'), false);
});

test('promptBlock: compact "About this learner" block, newest 15, ids only for the Teacher', () => {
  const m = createMemoryStore({ file: null });
  assert.equal(m.promptBlock(), '');
  for (let i = 0; i < 20; i++) m.add({ fact: `Distinct fact ${i} ${'abcdefghij'[i % 10]}${i * 31}`, kind: 'goal' });
  const block = m.promptBlock();
  assert.match(block, /^About this learner/);
  assert.equal(block.split('\n').length, 16);
  assert.doesNotMatch(block, /mem-/);
  assert.match(m.promptBlock({ withIds: true }), /- \(mem-[0-9a-f]{8}\) \[goal\] Distinct fact 19/);
});

test('GET/POST/DELETE /api/memory', async () => {
  await withServer({ mode: 'demo' }, async (base, memory) => {
    assert.deepEqual((await req(base, 'GET', '/api/memory')).body.items, []);
    let r = await req(base, 'POST', '/api/memory', { fact: 'I like analogies', kind: 'preference' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.source, 'user');
    const id = r.body.item.id;
    r = await req(base, 'POST', '/api/memory', { fact: 'i like analogies!', kind: 'preference' });
    assert.equal(r.body.duplicate, true);
    assert.equal((await req(base, 'POST', '/api/memory', { fact: 'x', kind: 'bogus' })).status, 400);
    await req(base, 'POST', '/api/memory', { fact: 'Studies on the train', kind: 'background' });
    assert.equal((await req(base, 'GET', '/api/memory')).body.items.length, 2);
    r = await req(base, 'DELETE', `/api/memory?id=${id}`);
    assert.equal(r.body.removed, 1);
    assert.equal(r.body.items.length, 1);
    assert.equal((await req(base, 'DELETE', '/api/memory?id=mem-missing1')).status, 404);
    assert.equal((await req(base, 'DELETE', '/api/memory', {})).status, 400);
    r = await req(base, 'DELETE', '/api/memory', { all: true });
    assert.equal(r.body.removed, 1);
    assert.equal(memory.size, 0);
  });
});

test('POST /api/memory/extract via Claude: structured output (effort low), 0-3 facts, de-duplicated against memory', async () => {
  const structured = { facts: [
    { fact: 'Confuses variance with standard deviation.', kind: 'struggle' },
    { fact: 'Knows basic algebra.', kind: 'background' }, // already known
    { fact: 'Likes real-world examples.', kind: 'preference' },
    { fact: 'Likes real world examples', kind: 'preference' }, // duplicate within the batch
    { fact: 'Wants to pass a stats exam.', kind: 'goal' },
    { fact: 'Fourth new fact that exceeds the cap.', kind: 'goal' },
    { fact: 'bad kind', kind: 'secret' },
  ] };
  const client = fakeClient({ structured });
  const memory = createMemoryStore({ file: null });
  memory.add({ fact: 'Knows basic algebra.', kind: 'background' });
  await withServer({ mode: 'claude', client, memory }, async (base) => {
    const r = await req(base, 'POST', '/api/memory/extract', { lessonTitle: 'Variance', quizResults: [{ prompt: 'What is variance?', correct: false }, { prompt: 'SD?', correct: true }], tutorThread: [{ role: 'user', content: 'Why square the differences?' }, { role: 'assistant', content: 'ignored' }] });
    assert.equal(r.body.source, 'claude');
    assert.deepEqual(r.body.added.map((i) => i.fact), ['Confuses variance with standard deviation.', 'Likes real-world examples.', 'Wants to pass a stats exam.']);
    assert.ok(r.body.added.every((i) => i.source === 'lesson'));
    assert.equal(memory.size, 4);
    const params = client.calls.create[0];
    assert.equal(params.model, 'claude-haiku-5-5');
    assert.equal(params.output_config.effort, 'low');
    assert.equal(params.output_config.format.type, 'json_schema');
    assert.equal(params.output_config.format.schema.properties.facts.items.additionalProperties, false);
    assert.match(params.messages[0].content, /WRONG: What is variance\?/);
    assert.match(params.messages[0].content, /Why square the differences\?/);
    assert.doesNotMatch(params.messages[0].content, /ignored/);
    assert.match(params.messages[0].content, /Already in memory[\s\S]*Knows basic algebra/);
    const off = await req(base, 'POST', '/api/memory/extract', { lessonTitle: 'x', memoryEnabled: false });
    assert.deepEqual(off.body, { ok: true, added: [], source: 'disabled' });
    assert.equal(client.calls.create.length, 1, 'disabled memory makes no request');
  });
});

test('POST /api/memory/extract in demo mode: deterministic rule on the quiz score', async () => {
  await withServer({ mode: 'demo' }, async (base, memory) => {
    let r = await req(base, 'POST', '/api/memory/extract', { lessonTitle: 'Variance', quizResults: [{ prompt: 'a', correct: true }, { prompt: 'b', correct: true }, { prompt: 'c', correct: true }] });
    assert.deepEqual(r.body.added, []);
    r = await req(base, 'POST', '/api/memory/extract', { lessonTitle: 'Variance', quizResults: [{ prompt: 'a', correct: false }, { prompt: 'b', correct: false }, { prompt: 'c', correct: true }] });
    assert.equal(r.body.added.length, 1);
    assert.equal(r.body.added[0].kind, 'struggle');
    assert.match(r.body.added[0].fact, /Variance.*missed 2 of 3/);
    r = await req(base, 'POST', '/api/memory/extract', { lessonTitle: 'Variance', quizResults: [{ prompt: 'a', correct: false }, { prompt: 'b', correct: false }, { prompt: 'c', correct: true }] });
    assert.deepEqual(r.body.added, [], 'not saved twice');
    assert.equal(memory.size, 1);
  });
});

test('memory is injected into lesson and tutor prompts after the cache breakpoint, and omitted with memoryEnabled:false', async () => {
  const memory = createMemoryStore({ file: null });
  memory.add({ fact: 'Knows basic algebra.', kind: 'background' });
  const client = fakeClient({ text: '# T\n\nBody.' });
  await withServer({ mode: 'claude', client, memory }, async (base) => {
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
    await post('/api/lesson/stream', { topic: 'variance' });
    await post('/api/lesson/stream', { topic: 'variance', memoryEnabled: false });
    await post('/api/tutor/stream', { message: 'why?', lessonContext: { title: 'Var', markdown: '# Var' } });
    await post('/api/tutor/stream', { message: 'why?', lessonContext: { title: 'Var', markdown: '# Var' }, memoryEnabled: false });
    const [lessonOn, lessonOff, tutorOn, tutorOff] = client.calls.stream.map((c) => c.params);
    assert.equal(lessonOn.system[0].text, LESSON_SYSTEM_PROMPT);
    assert.ok(lessonOn.system[0].cache_control);
    assert.equal(lessonOn.system.length, 2);
    assert.match(lessonOn.system[1].text, /About this learner[\s\S]*\[background\] Knows basic algebra\./);
    assert.ok(!lessonOn.system[1].cache_control);
    assert.equal(lessonOff.system.length, 1, 'no memory block when disabled');
    assert.equal(tutorOn.system[0].text, TUTOR_SYSTEM_PROMPT);
    assert.match(tutorOn.system[1].text, /<lesson title="Var">[\s\S]*About this learner/);
    assert.doesNotMatch(tutorOff.system[1].text, /About this learner/);
    assert.deepEqual(lessonOn.system[0], lessonOff.system[0], 'cached prefix is identical with and without memory');
  });
});
