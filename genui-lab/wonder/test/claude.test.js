// Claude path with an injected fake client: request shape, streaming, refusal and errors.
// No network: the fake implements only `.beta.messages.stream` and `.messages.create`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createWonderServer } from '../server/app.js';
import { buildStreamParams, buildStructuredParams, detectMode, isCredentialError, friendlyError } from '../server/claude.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../server/prompts.js';
import { parseConversationSource, ConversationTurn } from '../../chatgpt-dil/src/stream.js';
import { fakeClient, demo, runProgram, catalogNodes } from './helpers.js';
import { stripGroundingTags } from '../server/grounding.js';

const quiet = { warn() {}, error() {}, log() {} };

async function withServer(client, fn) {
  const server = createWonderServer({ mode: 'claude', client, demoDelayMs: 0, logger: quiet, memoryFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const records = async (res) => parseConversationSource(await res.text());
const fold = (recs) => { const t = new ConversationTurn(); for (const r of recs) t.apply(r); return t.primary; };

test('stream request: model, adaptive thinking, effort, fallbacks + beta, cached system prompt', () => {
  const p = buildStreamParams({ system: 'SYS', context: 'CTX', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.max_tokens, 64000);
  assert.deepEqual(p.thinking, { type: 'adaptive' });
  assert.deepEqual(p.output_config, { effort: 'medium' });
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.system[0], { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(p.system[1], { type: 'text', text: 'CTX' }, 'per-request context sits after the cache breakpoint');
  for (const banned of ['temperature', 'top_p', 'top_k']) assert.ok(!(banned in p), banned);
  assert.notEqual(p.messages.at(-1).role, 'assistant', 'no assistant prefill');
  const s = buildStructuredParams({ system: 'S', schema: { type: 'object' }, user: 'u' });
  assert.deepEqual(s.output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.notEqual(s.thinking?.type, 'disabled');
  assert.ok(!('budget_tokens' in (s.thinking || {})));
});

test('lesson stream via Claude: deltas flow through compile + NDJSON, params are correct', async () => {
  const md = demo('transformers.md');
  const client = fakeClient({ text: md });
  await withServer(client, async (base) => {
    const res = await post(base, '/api/lesson/stream', { topic: 'transformers', level: 'intermediate' });
    const recs = await records(res);
    const msg = fold(recs);
    assert.equal(msg.markdown, md);
    assert.equal(msg.status, 'complete');
    const env = runProgram(msg.dil);
    assert.deepEqual(env.errors, []);
    assert.ok(catalogNodes(env.mirror, 'Flowchart').length);
    const { params, opts } = client.calls.stream[0];
    assert.equal(params.model, 'claude-opus-5-5');
    assert.deepEqual(params.thinking, { type: 'adaptive' });
    assert.equal(params.output_config.effort, 'medium');
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.system[0].text, LESSON_SYSTEM_PROMPT);
    assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
    assert.match(params.messages[0].content, /transformers/);
    assert.match(params.messages[0].content, /intermediate/);
    assert.ok(opts?.signal, 'request is abortable when the client disconnects');
  });
});

test('tutor stream via Claude: lesson context + history, followups from <Followups/>', async () => {
  const reply = 'Short answer.\n\n<Reveal items={[{"label":"Why?","content":"Because."}]}/>\n\n<Followups items={["Next?","More?"]}/>\n';
  const client = fakeClient({ text: reply });
  await withServer(client, async (base) => {
    const recs = await records(await post(base, '/api/tutor/stream', {
      message: 'Why?',
      history: [{ role: 'assistant', content: 'dropped: history must start with user' }, { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'system', content: 'ignored' }],
      lessonContext: { title: 'Sky', markdown: '# Sky\n\nBlue.' },
    }));
    const final = recs.filter((r) => r.type === 'content').at(-1);
    assert.deepEqual(final.followupPrompts, ['Next?', 'More?']);
    const { params } = client.calls.stream[0];
    assert.equal(params.system[0].text, TUTOR_SYSTEM_PROMPT);
    assert.match(params.system[1].text, /<lesson title="Sky">/);
    assert.deepEqual(params.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(params.messages.at(-1).content, 'Why?');
  });
});

test('refusal: graceful message, stream completes', async () => {
  const client = fakeClient({ text: 'Partial', stopReason: 'refusal' });
  await withServer(client, async (base) => {
    const recs = await records(await post(base, '/api/lesson/stream', { topic: 'x' }));
    const msg = fold(recs);
    assert.equal(msg.status, 'complete');
    assert.match(msg.markdown, /can't help with that/);
    assert.equal(recs.at(-1).type, 'end');
  });
});

test('max_tokens: final record is marked truncated', async () => {
  const client = fakeClient({ text: '# T\n\nSome text', stopReason: 'max_tokens' });
  await withServer(client, async (base) => {
    const recs = await records(await post(base, '/api/lesson/stream', { topic: 'x' }));
    const final = recs.filter((r) => r.type === 'content').at(-1);
    assert.deepEqual(final.debug, { truncated: true });
    assert.equal(recs.find((r) => r.type === 'control' && r.detail.kind === 'message-stream-complete').detail.truncated, true);
  });
});

const apiError = (Cls, status, msg) => new Cls(status, { type: 'error', error: { type: 'x', message: msg } }, msg, new Headers());

for (const [name, err, code] of [
  ['RateLimitError', apiError(Anthropic.RateLimitError, 429, 'slow down'), 'rate_limited'],
  ['BadRequestError', apiError(Anthropic.BadRequestError, 400, 'bad'), 'bad_request'],
  ['InternalServerError (APIError)', apiError(Anthropic.InternalServerError, 500, 'boom'), 'api_error'],
]) {
  test(`${name} mid-stream -> control failed with a friendly message`, async () => {
    const client = fakeClient({ text: 'Hello there, this is a lesson that will fail midway.', error: err, errorAfter: 1 });
    await withServer(client, async (base) => {
      const recs = await records(await post(base, '/api/lesson/stream', { topic: 'x' }));
      const failed = recs.find((r) => r.type === 'control' && r.detail.kind === 'failed');
      assert.ok(failed, 'failed control record');
      assert.equal(failed.detail.code, code);
      assert.ok(!/slow down|boom/.test(failed.detail.message), 'raw API error text is not leaked');
      assert.equal(recs.at(-1).type, 'end');
    });
  });
}

test('AuthenticationError before any text -> switches to demo mode and streams demo content', async () => {
  const client = fakeClient({ error: apiError(Anthropic.AuthenticationError, 401, 'invalid x-api-key') });
  await withServer(client, async (base, server) => {
    const recs = await records(await post(base, '/api/lesson/stream', { topic: 'why is the sky blue' }));
    assert.equal(stripGroundingTags(fold(recs).markdown), demo('sky-blue.md')); // demo citations (Phase 3) stripped
    assert.equal(server.wonder.mode, 'demo');
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.mode, 'demo');
  });
});

test('missing credentials error (SDK, no HTTP status) is treated like auth failure', () => {
  assert.equal(isCredentialError(new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.')), true);
  assert.equal(isCredentialError(apiError(Anthropic.RateLimitError, 429, 'x')), false);
  assert.equal(friendlyError(apiError(Anthropic.AuthenticationError, 401, 'x')).code, 'auth_failed');
  // a refused request says Claude's own reason (what to change), not a guess
  const pdf = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Could not process PDF' } }, undefined, new Headers());
  assert.equal(friendlyError(pdf).message, 'Claude could not process this request: Could not process PDF.');
});

test('mode detection never needs key values', () => {
  assert.equal(detectMode({ WONDER_MODE: 'demo', ANTHROPIC_API_KEY: 'k' }), 'demo');
  assert.equal(detectMode({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_CONFIG_DIR: '/nonexistent' }), 'claude');
  assert.equal(detectMode({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_CONFIG_DIR: '/nonexistent' }), 'claude');
  assert.equal(detectMode({ ANTHROPIC_CONFIG_DIR: '/nonexistent' }), 'demo');
});

test('practice extract via Claude structured output (effort low, json_schema), validated', async () => {
  const structured = {
    cards: [{ term: 'Rayleigh scattering', definition: 'Scattering by tiny particles', example: 'Blue sky' }],
    items: [
      { type: 'mcq', prompt: 'Which scatters most?', choices: ['Red', 'Blue'], correct_index: 1, answer: '', statement: '', is_true: false, front: '', back: '', explanation: 'Short waves.' },
      { type: 'cloze', prompt: 'Short waves scatter ____.', choices: [], correct_index: 0, answer: 'more', statement: '', is_true: false, front: '', back: '', explanation: '' },
      { type: 'binary_choice', prompt: '', choices: [], correct_index: 0, answer: '', statement: 'Clouds are white.', is_true: true, front: '', back: '', explanation: '' },
      { type: 'mcq', prompt: 'broken', choices: ['only one'], correct_index: 5, answer: '', statement: '', is_true: false, front: '', back: '', explanation: '' },
    ],
  };
  const client = fakeClient({ structured });
  await withServer(client, async (base) => {
    const data = await (await post(base, '/api/practice/extract', { lessonMarkdown: demo('sky-blue.md') })).json();
    assert.equal(data.source, 'claude');
    assert.equal(data.items.length, 3, 'invalid items are dropped');
    assert.equal(data.items[0].choices[1].isCorrect, true);
    const params = client.calls.create[0];
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.output_config.effort, 'low');
    assert.equal(params.output_config.format.type, 'json_schema');
    assert.equal(params.output_config.format.schema.additionalProperties, false);
  });
});

test('practice extract falls back to lesson components when structured output fails', async () => {
  const client = fakeClient({ error: apiError(Anthropic.BadRequestError, 400, 'nope') });
  await withServer(client, async (base) => {
    const data = await (await post(base, '/api/practice/extract', { lessonMarkdown: demo('sky-blue.md') })).json();
    assert.equal(data.ok, true);
    assert.equal(data.source, 'lesson-components');
    assert.ok(data.items.length >= 4);
  });
});

test('course plan via Claude structured output', async () => {
  const plan = { title: 'Optics', description: 'Light!', sections: [{ title: 'Basics', lessons: [{ title: 'Why the sky is blue', summary: 'Scattering.' }] }] };
  const client = fakeClient({ structured: plan });
  await withServer(client, async (base) => {
    const data = await (await post(base, '/api/course/plan', { topic: 'optics' })).json();
    assert.equal(data.plan.title, 'Optics');
    assert.equal(data.plan.sections[0].lessons[0].title, 'Why the sky is blue');
    assert.equal(client.calls.create[0].output_config.format.type, 'json_schema');
  });
});
