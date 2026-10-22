import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { parseConversationSource, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';
import { demo, runProgram, catalogNodes } from './helpers.js';
import { stripGroundingTags } from '../server/grounding.js';

let server;
let base;
const quiet = { warn() {}, error() {}, log() {} };

before(async () => {
  server = createWonderServer({ mode: 'demo', demoDelayMs: 0, logger: quiet, memoryFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function streamRecords(path, body) {
  const res = await post(path, body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), CONTENT_TYPE);
  return parseConversationSource(await res.text()); // validates every record, requires `end`
}

test('GET /api/status reports demo mode and the model', async () => {
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.mode, 'demo');
  assert.equal(s.model, 'claude-opus-5-5');
});

for (const [topic, file] of [['How transformers predict the next word', 'transformers.md'], ['why is the sky blue?', 'sky-blue.md'], ['compound interest', 'compound-interest.md']]) {
  test(`POST /api/lesson/stream (demo): "${topic}" streams valid conversation-source NDJSON`, async () => {
    const records = await streamRecords('/api/lesson/stream', { topic });
    assert.equal(records[0].type, 'control');
    assert.equal(records[0].detail.kind, 'started');
    assert.equal(records.at(-1).type, 'end');
    assert.ok(records.some((r) => r.type === 'reasoning' && r.status.text === 'Planning the lesson…'));
    assert.ok(records.some((r) => r.type === 'reasoning' && /Writing page 1/.test(r.status.text)));
    const kinds = records.filter((r) => r.type === 'control').map((r) => r.detail.kind);
    assert.ok(kinds.includes('terminal-received'));
    assert.ok(records.some((r) => r.type === 'state'));

    const contents = records.filter((r) => r.type === 'content');
    assert.equal(contents[0].mode, 'replace');
    assert.ok(contents.slice(1).every((r) => r.mode === 'append' && r.baseRevision === r.revision - 1));
    const deltas = contents.slice(1, -1).filter((r) => !r.markdown.includes('<Sources/>')).map((r) => r.markdown.length); // Sources list is appended separately
    assert.ok(Math.max(...deltas) <= 60 && Math.min(...deltas.slice(0, -1)) >= 20, 'demo chunks are 20-60 chars');
    const withDil = contents.filter((r) => r.dil);
    assert.ok(withDil.length >= 5 && withDil.length < contents.length, 'dil recompiled periodically, not on every record');

    const turn = new ConversationTurn();
    for (const r of records) turn.apply(r);
    const msg = turn.primary;
    assert.equal(msg.status, 'complete');
    assert.equal(stripGroundingTags(msg.markdown), demo(file), 'final markdown is exactly the demo source (+ Phase 3 demo citations)');

    const env = runProgram({ code: msg.dil.code, constants: msg.dil.constants, appData: msg.dil.appData });
    assert.deepEqual(env.errors, []);
    for (const name of ['Quiz', 'LessonStepper']) assert.ok(catalogNodes(env.mirror, name).length, `${name} node`);
    if (file === 'transformers.md') assert.ok(catalogNodes(env.mirror, 'Flowchart').length, 'Flowchart node');
  });
}

test('POST /api/lesson/stream validates input', async () => {
  const res = await post('/api/lesson/stream', { topic: '' });
  assert.equal(res.status, 400);
});

test('POST /api/tutor/stream (demo): quiz reply with followupPrompts', async () => {
  const records = await streamRecords('/api/tutor/stream', { message: 'Quiz me please', history: [], lessonContext: { title: 'Why the sky is blue', markdown: demo('sky-blue.md') } });
  const final = records.filter((r) => r.type === 'content').at(-1);
  assert.equal(final.status, 'complete');
  assert.equal(final.followupPrompts.length, 3);
  assert.equal(final.conversationFollowupSuggestionsEligible, true);
  const env = runProgram(final.dil);
  assert.equal(catalogNodes(env.mirror, 'Quiz').length, 1);
  assert.doesNotMatch(env.mirror.text(), /Followups/);
});

test('POST /api/tutor/stream (demo): "Explain this" from a missed quiz question', async () => {
  const message = 'I answered "Clouds absorb the blue light" to "Why does the setting sun look red?" but the answer is "Its light crosses much more air, so most blue is scattered away". Can you explain why?';
  const records = await streamRecords('/api/tutor/stream', { message, lessonContext: { title: 'Sky', markdown: demo('sky-blue.md') } });
  const turn = new ConversationTurn();
  for (const r of records) turn.apply(r);
  assert.match(turn.primary.markdown, /~38× more air/);
});

test('POST /api/widget_action grades quiz answers and returns componentResults', async () => {
  const question = { id: 'q1', prompt: '2+2?', options: [{ value: 'a', label: '3' }, { value: 'b', label: '4' }], correct_values: ['b'], explanation: 'Math.' };
  const rid = '11111111-2222-5333-8444-555555555555';
  let res = await (await post('/api/widget_action', { componentName: 'Quiz', action_type: 'quiz_answer', resolutionId: rid, payload: { question, selected_values: ['a'], attempt: 0 } })).json();
  assert.equal(res.ok, true);
  assert.equal(res.result.is_correct, false);
  assert.deepEqual(res.result.correct_values, ['b']);
  const state = res.componentResults[rid];
  assert.equal(state.status, 'resolved');
  assert.equal(state.state.answers.q1.is_correct, false);
  res = await (await post('/api/widget_action', { componentName: 'Quiz', action_type: 'quiz_answer', resolutionId: rid, payload: { question: { ...question, id: 'q2' }, selected_values: ['b'], attempt: 0 } })).json();
  assert.equal(res.componentResults[rid].state.score, 1);
  assert.equal(res.componentResults[rid].state.answered, 2);
  res = await (await post('/api/widget_action', { componentName: 'Quiz', action_type: 'quiz_restart', resolutionId: rid, payload: { attempt: 1 } })).json();
  assert.deepEqual(res.componentResults[rid].state.answers, {});
  const bad = await post('/api/widget_action', { componentName: 'Quiz', action_type: 'quiz_answer', resolutionId: rid, payload: { question, selected_values: ['zzz'] } });
  assert.equal(bad.status, 400);
  const explain = await (await post('/api/widget_action', { componentName: 'KeyTerm', action_type: 'explain_more', payload: { topic: 'attention' } })).json();
  assert.match(explain.issueTurn.message, /attention/);
  const grade = await (await post('/api/widget_action', { action_type: 'practice_grade', payload: { item: { type: 'cloze', prompt: 'The sky is ____.', answer: 'blue' }, answer: 'Blue' } })).json();
  assert.equal(grade.result.correct, true);
  assert.equal((await post('/api/widget_action', { action_type: 'nope' })).status, 400);
});

test('POST /api/practice/extract (demo) builds cards and items from KeyTerm + Quiz', async () => {
  const data = await (await post('/api/practice/extract', { lessonMarkdown: demo('compound-interest.md') })).json();
  assert.equal(data.ok, true);
  assert.equal(data.source, 'lesson-components');
  assert.deepEqual(data.cards.map((c) => c.term), ['principal', 'simple interest', 'compound interest', 'Rule of 72']);
  const types = new Set(data.items.map((i) => i.type));
  for (const t of ['mcq', 'cloze', 'binary_choice', 'flashcard']) assert.ok(types.has(t), t);
  const mcq = data.items.find((i) => i.type === 'mcq');
  assert.equal(mcq.choices.filter((c) => c.isCorrect).length, 1);
  assert.ok(data.items.every((i) => i.id));
  assert.equal((await post('/api/practice/extract', {})).status, 400);
});

test('POST /api/course/plan (demo) returns a course outline', async () => {
  const data = await (await post('/api/course/plan', { topic: 'compound interest', level: 'beginner' })).json();
  assert.equal(data.ok, true);
  assert.ok(data.plan.sections.length >= 2);
  assert.equal(data.plan.sections[0].lessons[0].title, 'Compound interest');
});

test('client modules and read-only module mounts are served; traversal is refused', async () => {
  // the page itself (layout, fonts, CSS) is the Next.js app in app/; this server only serves the modules
  for (const p of ['/app.js', '/shell.js', '/learning-catalog.js', '/chatgpt-dil/src/host.js', '/chatgpt-dil/src/dil.css', '/wondering-genui/src/fsrs.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    await r.arrayBuffer();
  }
  for (const p of ['/chatgpt-dil/src/%2e%2e/%2e%2e/wonder/server/claude.js', '/%2e%2e/server/claude.js', '/chatgpt-dil/fixtures/final-dil.json', '/../package.json']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    await r.arrayBuffer();
  }
});
