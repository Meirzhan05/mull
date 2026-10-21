// Regression: a real Teacher turn by claude-opus-5-5 through /api/teacher/stream, recorded with
// WONDER_RECORD_DIR ("I want to get good at statistics in a week, I already know basic
// algebra": Claude called remember x2 + get_progress, then plan_study + create_lesson, then
// wrote the reply). Replayed through the browser client's streamTurn (chatgpt-dil parser +
// turn reducer) in uneven chunks, then rendered in the sandbox runtime with the learning catalog.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { streamTurn } from '../public/stream-client.js';
import { CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';
import { compileWonder } from '../server/compile.js';
import { runProgram, teacherCards, click } from './helpers.js';

const ndjson = fs.readFileSync(new URL('./fixtures/claude-teacher-statistics.ndjson', import.meta.url), 'utf8');

/** Serve the fixture to streamTurn as a fetch Response body split into uneven chunks. */
async function replay() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const bytes = new TextEncoder().encode(ndjson);
    let i = 0;
    let n = 0;
    const body = new ReadableStream({
      pull(ctrl) {
        if (i >= bytes.length) return ctrl.close();
        const size = [7, 300, 1, 4096, 913][n++ % 5];
        ctrl.enqueue(bytes.slice(i, i + size));
        i += size;
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': CONTENT_TYPE } });
  };
  const seen = { contents: [], reasoning: [], controls: [] };
  try {
    const r = await streamTurn('/api/teacher/stream', {}, {
      onContent: (msg, rec) => seen.contents.push({ markdown: msg.markdown, rec }),
      onReasoning: (s) => seen.reasoning.push(s.text),
      onControl: (d) => seen.controls.push(d.kind),
    });
    return { ...r, seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('real Claude Teacher turn: the client parser accepts every record and folds the turn', async () => {
  const r = await replay();
  assert.equal(r.failure, null);
  assert.equal(r.message.status, 'complete');
  assert.deepEqual(r.seen.controls.filter((k) => ['started', 'conversation-id', 'message-stream-complete', 'terminal-received'].includes(k)), ['started', 'conversation-id', 'message-stream-complete', 'terminal-received']);
  for (const t of ['Saving that to memory…', 'Checking your progress…', 'Drafting a study plan…', 'Preparing a lesson suggestion…']) assert.ok(r.seen.reasoning.includes(t), t);
  const kinds = [...r.message.markdown.matchAll(/<TeacherCard kind="(\w+)" __resolutionId="(tc-[0-9a-f-]{36})"\/>/g)];
  assert.deepEqual(kinds.map((m) => m[1]), ['memory', 'memory', 'plan', 'approval']);
  const results = r.message.dil.appData.opGenui.componentResults;
  for (const [, kind, rid] of kinds) {
    assert.equal(results[rid].status, 'resolved');
    assert.equal(results[rid].state.kind, kind);
  }
  const plan = Object.values(results).find((x) => x.state.kind === 'plan').state;
  assert.ok(plan.days.length >= 3 && plan.days.length <= 7);
  assert.equal(r.final.followupPrompts.length, 3);
});

test('real Claude Teacher turn: every streamed program and the final one render in the sandbox; cards are interactive', async () => {
  const r = await replay();
  const withDil = r.seen.contents.filter((c) => c.rec.dil);
  assert.ok(withDil.length >= 5);
  for (const c of withDil) {
    const env = runProgram(c.rec.dil);
    assert.deepEqual(env.errors, [], `revision ${c.rec.revision}`);
  }
  const env = runProgram(r.message.dil);
  assert.equal(teacherCards(env.mirror).length, 4);
  const text = env.mirror.text();
  assert.match(text, /Remembered: Wants to get good at statistics in a week\./);
  assert.match(text, /Remembered: Knows basic algebra\./);
  assert.match(text, /STUDY PLAN[\s\S]*Save plan/);
  assert.match(text, /SUGGESTED LESSON[\s\S]*Mean, median and mode[\s\S]*Start lesson[\s\S]*Not now/);
  assert.doesNotMatch(text, /TeacherCard|Followups/);
  click(env, 'Start lesson');
  click(env, 'Save plan');
  assert.deepEqual(env.actions.map((a) => [a.type, a.handler]), [['teacher_accept', 'server'], ['teacher_accept', 'server']]);
  // the markdown still compiles with every component valid (re-compiled from scratch)
  const out = compileWonder(r.message.markdown, { salt: r.message.messageId });
  assert.deepEqual(out.components.filter((c) => c.status !== 'valid'), []);
});
