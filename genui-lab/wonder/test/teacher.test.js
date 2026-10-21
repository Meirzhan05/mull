// Teacher agent: the manual streaming tool loop against a scripted fake client (request shape,
// tool execution, strict validation, pause_turn, refusal/max_tokens, card splicing and
// stripping), teacher card widget actions, and the demo-mode Teacher end to end over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { TEACHER_TOOLS, validateToolInput, createCardStripper, stripCardMarkup, sanitizeProgress } from '../server/teacher.js';
import { TEACHER_SYSTEM_PROMPT } from '../server/prompts.js';
import { parseConversationSource, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';
import { fakeToolClient, runProgram, teacherCards, click } from './helpers.js';
import { historyForModel, cardNotes, progressSnapshot } from '../public/teacher-core.js';
import { emptyState } from '../public/store.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };

async function withServer(opts, fn) {
  const memory = opts.memory ?? createMemoryStore({ file: null });
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memory, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server, memory); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function teacherTurn(base, body) {
  const res = await post(base, '/api/teacher/stream', body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), CONTENT_TYPE);
  const recs = parseConversationSource(await res.text()); // validates every record + requires `end`
  const t = new ConversationTurn();
  for (const r of recs) t.apply(r);
  const final = recs.filter((r) => r.type === 'content').at(-1);
  return { recs, msg: t.primary, final };
}
const action = async (base, body) => {
  const res = await post(base, '/api/widget_action', body);
  return { status: res.status, body: await res.json() };
};

const thinking = { type: 'thinking', thinking: 'Planning…', signature: 'sig' };
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const PLAN = {
  goal: 'Statistics in a week',
  days: [
    { day: 1, focus: 'Averages', items: [{ kind: 'lesson', title: 'Mean, median, mode', topic: 'mean median and mode' }] },
    { day: 2, focus: 'Spread', items: [{ kind: 'lesson', title: 'Variance', topic: 'variance and standard deviation' }, { kind: 'review', title: 'Review' }] },
    { day: 3, focus: 'Check', items: [{ kind: 'quiz', title: 'Quick check', topic: 'averages and spread' }] },
  ],
};

// ---------------------------------------------------------------- request shape

test('teacher request: model, adaptive thinking, effort, fallbacks, cache breakpoint, strict eager tools, no forced tool_choice', async () => {
  const client = fakeToolClient([{ content: [{ type: 'text', text: 'Hi! <Followups items={["A?","B?"]}/>' }] }]);
  const memory = createMemoryStore({ file: null });
  memory.add({ fact: 'Knows basic algebra.', kind: 'background', source: 'user' });
  await withServer({ mode: 'claude', client, memory }, async (base) => {
    const { final } = await teacherTurn(base, { message: 'Hello', threadId: 'thread-1', progress: {} });
    assert.deepEqual(final.followupPrompts, ['A?', 'B?']);
    const { params, opts } = client.calls[0];
    assert.equal(params.model, 'claude-opus-5-5');
    assert.deepEqual(params.thinking, { type: 'adaptive' });
    assert.deepEqual(params.output_config, { effort: 'medium' });
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.system[0], { type: 'text', text: TEACHER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } });
    assert.ok(!params.system[1].cache_control, 'per-request context sits after the breakpoint');
    assert.match(params.system[1].text, /About this learner[\s\S]*\(mem-[\w-]+\) \[background\] Knows basic algebra\./);
    assert.ok(!('tool_choice' in params), 'forced tool_choice is a 400 on this model');
    for (const banned of ['temperature', 'top_p', 'top_k']) assert.ok(!(banned in params), banned);
    assert.equal(params.messages.at(-1).role, 'user', 'no assistant prefill');
    assert.deepEqual(params.tools.map((t) => t.name), ['create_lesson', 'plan_study', 'quiz_me', 'remember', 'forget', 'get_progress']);
    const checkObjects = (schema, at) => {
      if (schema.type === 'object') {
        assert.equal(schema.additionalProperties, false, `${at} additionalProperties`);
        assert.ok(Array.isArray(schema.required), `${at} required`);
        for (const [k, v] of Object.entries(schema.properties)) checkObjects(v, `${at}.${k}`);
      } else if (schema.type === 'array') checkObjects(schema.items, `${at}[]`);
    };
    for (const t of params.tools) {
      assert.equal(t.strict, true, t.name);
      assert.equal(t.eager_input_streaming, true, t.name);
      checkObjects(t.input_schema, t.name);
    }
    assert.ok(opts?.signal, 'abortable');
    assert.deepEqual(JSON.parse(JSON.stringify(params.tools)), JSON.parse(JSON.stringify(TEACHER_TOOLS)), 'tools are static (stable cache prefix)');
  });
});

// ---------------------------------------------------------------- loop

test('tool loop: tool_use blocks run, ALL results return in one user message, full content is appended, cards are spliced', async () => {
  const client = fakeToolClient([
    { content: [thinking, { type: 'text', text: 'Great goal! Let me note it.' }, tool('t1', 'remember', { fact: 'Wants to learn statistics in a week.', kind: 'goal' }), tool('t2', 'create_lesson', { topic: 'Mean, median and mode', level: 'beginner', reason: 'Averages come first.' })], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Tap Start when ready.\n\n<Followups items={["Make a plan","Quiz me"]}/>' }], stop_reason: 'end_turn' },
  ]);
  await withServer({ mode: 'claude', client }, async (base, server, memory) => {
    const { recs, msg, final } = await teacherTurn(base, { message: 'I want to learn statistics in a week', threadId: 't-1' });
    assert.equal(client.calls.length, 2);
    const second = client.calls[1].params.messages;
    assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(second[1].content.map((b) => b.type), ['thinking', 'text', 'tool_use', 'tool_use'], 'full message.content (incl. thinking) is appended');
    assert.equal(second[2].content.length, 2, 'both tool_results in ONE user message');
    assert.deepEqual(second[2].content.map((b) => [b.type, b.tool_use_id, !!b.is_error]), [['tool_result', 't1', false], ['tool_result', 't2', false]]);
    assert.match(second[2].content[0].content, /Saved to memory as mem-/);
    assert.equal(memory.list()[0].fact, 'Wants to learn statistics in a week.');
    assert.equal(memory.list()[0].source, 'teacher');

    // cards spliced at the point of the call, after the text that preceded it
    const cards = [...msg.markdown.matchAll(/<TeacherCard kind="(\w+)" __resolutionId="([\w-]+)"\/>/g)];
    assert.deepEqual(cards.map((m) => m[1]), ['memory', 'approval']);
    assert.ok(msg.markdown.indexOf('Let me note it.') < cards[0].index && cards[1].index < msg.markdown.indexOf('Tap Start'));
    const results = final.dil.appData.opGenui.componentResults;
    for (const [, kind, rid] of cards) {
      assert.equal(results[rid].status, 'resolved');
      assert.equal(results[rid].state.kind, kind);
      assert.ok(results[rid].state.summary);
    }
    assert.deepEqual(final.followupPrompts, ['Make a plan', 'Quiz me']);
    // tool status as reasoning records (Wondering's tool_start)
    const texts = recs.filter((r) => r.type === 'reasoning').map((r) => r.status.text);
    for (const t of ['Thinking…', 'Saving that to memory…', 'Preparing a lesson suggestion…', 'Writing a reply…']) assert.ok(texts.includes(t), t);
    assert.ok(recs.some((r) => r.type === 'control' && r.detail.kind === 'conversation-id' && r.detail.conversationId === 't-1'));
    // the program renders both cards through the sandbox runtime
    const env = runProgram(final.dil);
    assert.deepEqual(env.errors, []);
    assert.equal(teacherCards(env.mirror).length, 2);
    assert.match(env.mirror.text(), /Remembered: Wants to learn statistics/);
    assert.match(env.mirror.text(), /SUGGESTED LESSON[\s\S]*Mean, median and mode[\s\S]*Start lesson/);
  });
});

test('strict validation failure -> is_error tool_result, tool not run; quiz_me splices a normal Quiz', async () => {
  const badPlan = { goal: 'Stats', days: PLAN.days.slice(0, 2) }; // 2 days: outside 3-7
  const quiz = { topic: 'Averages', questions: [{ id: 'q1', prompt: 'Median of 1, 2, 9?', question_type: 'single_select', options: [{ value: 'a', label: '2' }, { value: 'b', label: '4' }], correct_values: ['a'], hint: 'Middle value.', explanation: 'Sorted, the middle is 2.' }] };
  const client = fakeToolClient([
    { content: [tool('p1', 'plan_study', badPlan), tool('p2', 'create_lesson', { topic: 'x', level: 'expert', reason: 'r' }), tool('p3', 'quiz_me', quiz)], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' },
  ]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const { msg, final } = await teacherTurn(base, { message: 'plan please' });
    const results = client.calls[1].params.messages.at(-1).content;
    assert.equal(results[0].is_error, true);
    assert.match(results[0].content, /days must have 3-7 entries/);
    assert.match(JSON.parse(results[0].content).INVALID_INPUT, /"goal":"Stats"/, 'raw input is echoed back (JSON-encoded) so Claude can retry');
    assert.equal(results[1].is_error, true);
    assert.match(results[1].content, /level must be one of beginner, intermediate, advanced/);
    assert.ok(!results[2].is_error);
    assert.doesNotMatch(msg.markdown, /TeacherCard/, 'no card for rejected inputs');
    assert.deepEqual(Object.keys(final.dil.appData.opGenui.componentResults), []);
    const env = runProgram(final.dil);
    assert.deepEqual(env.errors, []);
    assert.match(env.mirror.text(), /Quiz: Averages[\s\S]*Median of 1, 2, 9\?/);
  });
});

test('validateToolInput: schema (types, enums, required, additionalProperties) and semantic bounds', () => {
  assert.equal(validateToolInput('plan_study', PLAN).ok, true);
  assert.match(validateToolInput('plan_study', { ...PLAN, extra: 1 }).error, /extra is not allowed/);
  assert.match(validateToolInput('plan_study', { goal: 'x' }).error, /days is required/);
  assert.match(validateToolInput('plan_study', { goal: 'x', days: [{ day: 1.5, focus: 'f', items: [] }, ...PLAN.days] }).error, /integer/);
  assert.match(validateToolInput('remember', { fact: 'x', kind: 'secret' }).error, /kind must be one of/);
  assert.match(validateToolInput('remember', { fact: '   ', kind: 'goal' }).error, /fact must not be empty/);
  assert.equal(validateToolInput('remember', { fact: 'y'.repeat(500), kind: 'goal' }).value.fact.length <= 200, true);
  assert.match(validateToolInput('forget', { id: '../../etc' }).error, /memory item id/);
  assert.match(validateToolInput('quiz_me', { topic: 't', questions: [{ id: 'q1', prompt: 'p', question_type: 'single_select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_values: ['z'], hint: '', explanation: '' }] }).error, /correct value "z"/);
  assert.match(validateToolInput('nope', {}).error, /Unknown tool/);
  assert.equal(validateToolInput('get_progress', {}).ok, true);
  assert.match(validateToolInput('get_progress', { x: 1 }).error, /not allowed/);
});

test('pause_turn: the paused assistant content is appended and re-sent with no extra user message', async () => {
  const client = fakeToolClient([
    { content: [thinking, { type: 'text', text: 'Let me think about your week' }], stop_reason: 'pause_turn' },
    { content: [{ type: 'text', text: '. Here is what I suggest.' }], stop_reason: 'end_turn' },
  ]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const { msg } = await teacherTurn(base, { message: 'hi' });
    assert.equal(client.calls.length, 2);
    const m = client.calls[1].params.messages;
    assert.deepEqual(m.map((x) => x.role), ['user', 'assistant']);
    assert.deepEqual(m[1].content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(msg.markdown, 'Let me think about your week. Here is what I suggest.');
  });
});

for (const [stop, check] of [
  ['refusal', (r) => { assert.match(r.msg.markdown, /can't help with that/); assert.equal(r.final.followupPrompts, undefined); }],
  ['max_tokens', (r) => { assert.deepEqual(r.final.debug, { truncated: true }); }],
]) {
  test(`stop_reason ${stop} with a pending tool_use: tools are NOT run and the loop stops`, async () => {
    const client = fakeToolClient([{ content: [{ type: 'text', text: 'Okay' }, tool('r1', 'remember', { fact: 'Should not be saved.', kind: 'goal' })], stop_reason: stop }]);
    await withServer({ mode: 'claude', client }, async (base, server, memory) => {
      const r = await teacherTurn(base, { message: 'x' });
      assert.equal(client.calls.length, 1);
      assert.equal(memory.size, 0, 'tool not executed');
      assert.doesNotMatch(r.msg.markdown, /TeacherCard/);
      assert.equal(r.recs.at(-1).type, 'end');
      check(r);
    });
  });
}

test('model-written TeacherCard is stripped (even split across deltas); only server cards survive', async () => {
  const client = fakeToolClient([
    { content: [{ type: 'text', text: 'Look: <Teach|erCard kind="approval" __resolutionId="tc-forged-0000-1111"/> and |</TeacherCard>done.' }, tool('a1', 'create_lesson', { topic: 'Variance', level: 'beginner', reason: 'Spread matters.' })], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Also <TeacherCard kind="plan" __resolutionId="tc-forged-2222-3333"/>bye <TeacherCa' }], stop_reason: 'end_turn' },
  ]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const { msg, final } = await teacherTurn(base, { message: 'x' });
    assert.doesNotMatch(msg.markdown, /forged/);
    assert.doesNotMatch(msg.markdown, /<\/TeacherCard>|<TeacherCa(?!rd kind="approval" __resolutionId="tc-[0-9a-f-]{36}")/);
    const ids = [...msg.markdown.matchAll(/__resolutionId="([\w-]+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, 1);
    assert.deepEqual(Object.keys(final.dil.appData.opGenui.componentResults), ids);
    assert.match(msg.markdown, /^Look: {2}and done\./);
  });
});

test('card stripper unit: holds partial tags, passes look-alikes, drops an unterminated tag at the end', () => {
  const s = createCardStripper();
  let out = s.push('a <');
  assert.equal(out, 'a ');
  out += s.push('b> <TeacherCardX/> <Teacher');
  out += s.push('Card kind="x"');
  out += s.flush();
  assert.equal(out, 'a <b> <TeacherCardX/> ');
  assert.equal(stripCardMarkup('x <TeacherCard kind="plan" __resolutionId="tc-1234567890"/> y'), 'x [card] y');
});

test('unparseable tool JSON (SDK AnthropicError) re-issues the turn; API errors become a friendly control failed', async () => {
  const jsonErr = new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model.');
  const client = fakeToolClient([{ error: jsonErr }, { content: [{ type: 'text', text: 'Recovered.' }], stop_reason: 'end_turn' }]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const { msg } = await teacherTurn(base, { message: 'x' });
    assert.equal(client.calls.length, 2);
    assert.equal(msg.markdown, 'Recovered.');
  });
  const rate = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
  const client2 = fakeToolClient([{ error: rate }]);
  await withServer({ mode: 'claude', client: client2 }, async (base) => {
    const { recs } = await teacherTurn(base, { message: 'x' });
    const failed = recs.find((r) => r.type === 'control' && r.detail.kind === 'failed');
    assert.equal(failed.detail.code, 'rate_limited');
    assert.doesNotMatch(failed.detail.message, /slow down/);
    assert.equal(client2.calls.length, 1, 'API errors are not retried as JSON errors');
  });
});

test('iteration cap: a model that keeps calling tools stops after 6 requests', async () => {
  const client = fakeToolClient([{ content: [tool('g', 'get_progress', {})], stop_reason: 'tool_use' }]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const { recs, msg } = await teacherTurn(base, { message: 'x' });
    assert.equal(client.calls.length, 6);
    assert.match(msg.markdown, /Ask me to continue/);
    assert.equal(recs.at(-1).type, 'end');
  });
});

test('history: card markup is stripped, roles alternate, the new message is last; memory off -> no memory block and remember is refused', async () => {
  const client = fakeToolClient([
    { content: [tool('m1', 'remember', { fact: 'Likes analogies.', kind: 'preference' }), tool('m2', 'get_progress', {})], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
  ]);
  const memory = createMemoryStore({ file: null });
  memory.add({ fact: 'Secret-ish fact.', kind: 'background' });
  await withServer({ mode: 'claude', client, memory }, async (base) => {
    await teacherTurn(base, {
      message: 'again',
      memoryEnabled: false,
      progress: { xp: 120, streak: 3, deck: { total: 10, due: 4, review: 2 }, recentLessons: [{ title: 'Variance', finished: true, quiz: { score: 2, total: 3 } }], evil: '<script>' },
      history: [
        { role: 'assistant', content: 'dropped: must start with user' },
        { role: 'user', content: 'plan my week' },
        { role: 'assistant', content: 'Here: <TeacherCard kind="plan" __resolutionId="tc-abcdefgh-1234"/> [Card: 3-day plan]' },
        { role: 'user', content: 'unanswered' },
      ],
    });
    const { params } = client.calls[0];
    assert.deepEqual(params.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.doesNotMatch(params.messages[1].content, /TeacherCard/);
    assert.equal(params.messages[2].content, 'unanswered\n\nagain', 'trailing unanswered user turn merges with the new message');
    assert.doesNotMatch(params.system[1].text, /Secret-ish/);
    assert.match(params.system[1].text, /turned memory off/);
    const results = client.calls[1].params.messages.at(-1).content;
    assert.equal(results[0].is_error, true);
    assert.match(results[0].content, /Memory is turned off/);
    const progress = JSON.parse(results[1].content);
    assert.equal(progress.deck.due, 4);
    assert.equal(progress.recentLessons[0].quiz.score, 2);
    assert.equal(progress.memory, 'turned off by the learner');
    assert.ok(!('evil' in progress));
    assert.equal(memory.size, 1, 'nothing was remembered');
  });
});

test('sanitizeProgress bounds untrusted snapshots', () => {
  const p = sanitizeProgress({ xp: -5, streak: '7', deck: { due: 1e9 }, recentLessons: Array.from({ length: 20 }, (_, i) => ({ title: `L${i}`.repeat(100) })) });
  assert.equal(p.xp, 0);
  assert.equal(p.streak, 7);
  assert.equal(p.recentLessons.length, 8);
  assert.ok(p.recentLessons[0].title.length <= 160);
  assert.deepEqual(sanitizeProgress(null).courses, []);
});

// ---------------------------------------------------------------- widget actions for cards

test('teacher card widget actions: accept/dismiss/undo, plan open + save, memory undo/redo, restart-safe state', async () => {
  await withServer({ mode: 'demo' }, async (base, server, memory) => {
    const { final } = await teacherTurn(base, { message: 'I want to get good at statistics in a week, I already know basic algebra', progress: { deck: { due: 1 } } });
    const results = final.dil.appData.opGenui.componentResults;
    const byKind = (k) => Object.entries(results).filter(([, r]) => r.state.kind === k);
    const [[approvalId, approval]] = byKind('approval');
    const [[planId, plan]] = byKind('plan');
    const mems = byKind('memory');
    assert.equal(mems.length, 2);
    assert.equal(memory.size, 2);

    let r = await action(base, { componentName: 'TeacherCard', action_type: 'teacher_dismiss', resolutionId: approvalId, payload: { state: approval.state } });
    assert.equal(r.body.componentResults[approvalId].state.status, 'dismissed');
    r = await action(base, { componentName: 'TeacherCard', action_type: 'teacher_undo', resolutionId: approvalId, payload: {} });
    assert.equal(r.body.componentResults[approvalId].state.status, 'pending');
    r = await action(base, { componentName: 'TeacherCard', action_type: 'teacher_accept', resolutionId: approvalId, payload: {} });
    assert.equal(r.body.componentResults[approvalId].state.status, 'accepted');
    assert.match(r.body.componentResults[approvalId].state.summary, /tapped Start/);
    assert.deepEqual(r.body.clientActions, [{ type: 'start_lesson', payload: { topic: approval.state.topic, level: 'beginner', resolutionId: approvalId } }]);

    const lessonItem = plan.state.days[0].items[0];
    r = await action(base, { action_type: 'teacher_open_item', resolutionId: planId, payload: { itemId: lessonItem.id } });
    assert.equal(r.body.componentResults[planId].state.days[0].items[0].opened, true);
    assert.equal(r.body.clientActions[0].type, 'start_lesson');
    assert.equal(r.body.clientActions[0].payload.resolutionId, `${planId}:${lessonItem.id}`);
    const review = plan.state.days.flatMap((d) => d.items).find((i) => i.kind === 'review');
    r = await action(base, { action_type: 'teacher_open_item', resolutionId: planId, payload: { itemId: review.id } });
    assert.equal(r.body.clientActions[0].type, 'open_review');
    const quizItem = plan.state.days.flatMap((d) => d.items).find((i) => i.kind === 'quiz');
    r = await action(base, { action_type: 'teacher_open_item', resolutionId: planId, payload: { itemId: quizItem.id } });
    assert.equal(r.body.clientActions[0].type, 'issue_new_turn');
    assert.equal((await action(base, { action_type: 'teacher_open_item', resolutionId: planId, payload: { itemId: 'nope' } })).status, 400);
    r = await action(base, { action_type: 'teacher_accept', resolutionId: planId, payload: {} });
    assert.equal(r.body.componentResults[planId].state.saved, true);
    assert.equal(r.body.clientActions[0].type, 'save_plan');
    assert.equal(r.body.clientActions[0].payload.plan.days.length, 5);
    r = await action(base, { action_type: 'teacher_undo', resolutionId: planId, payload: {} });
    assert.equal(r.body.componentResults[planId].state.saved, false);
    assert.equal(r.body.clientActions[0].type, 'unsave_plan');

    const [memId, mem] = mems[0];
    r = await action(base, { action_type: 'teacher_undo', resolutionId: memId, payload: {} });
    assert.equal(r.body.componentResults[memId].state.status, 'undone');
    assert.equal(memory.get(mem.state.item.id), null, 'undo removed the fact');
    r = await action(base, { action_type: 'teacher_undo', resolutionId: memId, payload: {} });
    assert.equal(r.body.componentResults[memId].state.status, 'saved');
    assert.equal(memory.get(mem.state.item.id).fact, mem.state.item.fact, 'redo restored it with the same id');
    assert.equal((await action(base, { action_type: 'teacher_accept', resolutionId: memId, payload: {} })).status, 400);

    // a card the server never saw (e.g. after a restart) is rebuilt from the client's copy
    const ghost = 'tc-00000000-0000-0000-0000-000000000000';
    assert.equal((await action(base, { action_type: 'teacher_accept', resolutionId: ghost, payload: {} })).status, 404);
    r = await action(base, { action_type: 'teacher_accept', resolutionId: ghost, payload: { state: { kind: 'approval', status: 'pending', topic: 'Ghost topic', level: 'weird', reason: 'r' } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.componentResults[ghost].state.level, 'beginner');
    assert.equal(r.body.clientActions[0].payload.topic, 'Ghost topic');
    assert.equal((await action(base, { action_type: 'teacher_accept', resolutionId: 'x', payload: {} })).status, 400);
  });
});

// ---------------------------------------------------------------- demo mode end to end

test('demo-mode Teacher over HTTP: scripted tool calls stream through the real loop and render cards', async () => {
  await withServer({ mode: 'demo' }, async (base, server, memory) => {
    const { recs, msg, final } = await teacherTurn(base, { message: 'I want to get good at statistics in a week. I already know basic algebra.', threadId: 'demo-thread', progress: { deck: { due: 3 }, streak: 2 } });
    assert.equal(recs[0].detail.kind, 'started');
    const texts = recs.filter((r) => r.type === 'reasoning').map((r) => r.status.text);
    for (const t of ['Saving that to memory…', 'Checking your progress…', 'Drafting a study plan…', 'Preparing a lesson suggestion…']) assert.ok(texts.includes(t), t);
    assert.match(msg.markdown, /You have 3 cards due/, 'get_progress result fed the next step');
    const kinds = [...msg.markdown.matchAll(/<TeacherCard kind="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(kinds, ['memory', 'memory', 'plan', 'approval']);
    assert.deepEqual(memory.list().map((i) => i.kind).sort(), ['background', 'goal']);
    assert.equal(final.followupPrompts.length, 3);
    const env = runProgram(final.dil);
    assert.deepEqual(env.errors, []);
    assert.equal(teacherCards(env.mirror).length, 4);
    assert.match(env.mirror.text(), /STUDY PLAN[\s\S]*What statistics is really about/);
    // pressing Start on the approval card dispatches a server widget action for that card
    click(env, 'Start lesson');
    const a = env.actions.at(-1);
    assert.equal(a.type, 'teacher_accept');
    assert.equal(a.handler, 'server');
    assert.equal(final.dil.appData.opGenui.componentResults[a.nativeWidgetResolutionId].state.kind, 'approval');

    const quiz = await teacherTurn(base, { message: 'Quiz me', progress: { recentLessons: [{ title: 'Why the sky is blue' }] } });
    const qenv = runProgram(quiz.final.dil);
    assert.deepEqual(qenv.errors, []);
    assert.match(qenv.mirror.text(), /Quiz: Why the sky is blue/);

    const forget = await teacherTurn(base, { message: 'Please forget that' });
    assert.match(forget.msg.markdown, /<TeacherCard kind="memory"/);
    assert.equal(memory.size, 1);
    assert.equal((await post(base, '/api/teacher/stream', { message: '' })).status, 400);
  });
});

// ---------------------------------------------------------------- client helpers

test('client history turns cards into notes from their latest state; progress snapshot comes from the store', () => {
  const md = 'Plan: <TeacherCard kind="plan" __resolutionId="tc-aaaaaaaa-1"/> go';
  assert.equal(cardNotes(md, { 'tc-aaaaaaaa-1': { state: { summary: '5-day plan (saved by the learner)' } } }), 'Plan: [Card: 5-day plan (saved by the learner)] go');
  const h = historyForModel([{ role: 'user', content: 'hi' }, { role: 'assistant', content: md, componentResults: {} }, { role: 'assistant', content: '' }]);
  assert.deepEqual(h, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Plan: [Card: an interactive card] go' }]);
  const data = emptyState();
  data.lessons.l1 = { id: 'l1', title: 'Variance', finished: true, quizScore: { score: 2, total: 3 }, updatedAt: '2026-10-20T10:00:00Z' };
  data.plans = [{ goal: 'Stats', days: [{ items: [{ opened: true }, { opened: false }] }] }];
  data.stats.xp = 40;
  const p = progressSnapshot(data, new Date('2026-10-21T12:00:00Z'));
  assert.equal(p.xp, 40);
  assert.deepEqual(p.recentLessons[0], { title: 'Variance', finished: true, quiz: { score: 2, total: 3 }, when: '2026-10-20T10:00:00Z' });
  assert.deepEqual(p.plans[0], { goal: 'Stats', days: 1, opened: 1, total: 2 });
  assert.equal(p.deck.due, 0);
});
