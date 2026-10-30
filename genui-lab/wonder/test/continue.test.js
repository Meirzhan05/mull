// Phase 4b: continueFrom (resume an interrupted lesson, steer after a reload, revise a finished
// lesson from page N), the steer-after-completion race, and the client-side helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { normalizeContinueFrom, createContinuationSources, steeringUserContent, trimToLastBlock } from '../server/steering.js';
import {
  trimToLastPage, trimBeforePage, sliceFromPage, pageCount, pageTitles, keptForContinue, citeRefsIn, resolutionIdsOf,
  carryOver, mergeContinuedAppData, sourcesFromAppData, lessonPhase, statusAfterStop, isResumableFailure, STEER_CHIPS,
} from '../public/steering-core.js';
import { ConversationSourceParser, ConversationTurn, validateRecord } from '../../chatgpt-dil/src/stream.js';
import { compileWonder, toWonderDil } from '../server/compile.js';
import { WEB_SEARCH_TOOL, stripGroundingTags } from '../server/grounding.js';
import { sampleLesson, runProgram, catalogNodes, fakeClient, fakeClientBy, lastUserText, groundedClient, citedBlocks } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
async function withServer(opts, fn) {
  const server = createWonderServer({ client: null, logger: quiet, memoryFile: null, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
    while (queue.length) { const rec = queue.shift(); await onRecord?.(rec, turn); }
  }
  parser.finish();
  return { recs, turn };
}

/** Every record valid, one messageId, revisions strictly increasing, appends chained. */
function assertWellFormed(recs) {
  for (const r of recs) validateRecord(r);
  const contents = recs.filter((r) => r.type === 'content');
  assert.equal(new Set(contents.map((r) => r.messageId)).size, 1);
  for (let i = 1; i < contents.length; i++) {
    assert.ok(contents[i].revision > contents[i - 1].revision, 'revisions increase');
    if (contents[i].mode === 'append') assert.equal(contents[i].baseRevision, contents[i - 1].revision);
  }
  assert.equal(recs[recs.length - 1].type, 'end');
}

const FULL = '# Steady lesson\n\nA hook sentence here.\n\n## Page one\n\nFirst page text.\n\n## Page two\n\nSecond page text.\n\n## Page three\n\nThird page text.\n\n## Check your understanding\n\nQuiz here.\n';
const PARTIAL = FULL.slice(0, FULL.indexOf('Third page') + 5);
const REST = '## Page three, again\n\nNew third page.\n\n## Check your understanding\n\nNew quiz.\n';

// ---------------------------------------------------------------- Claude path (fake client)

test('continueFrom resume (no instruction): complete blocks replace, no prefill, search + memory still applied', async () => {
  const TAIL = 'Third page text.\n\n## Check your understanding\n\nQuiz here.\n';
  const client = fakeClient({ text: TAIL });
  await withServer({ client }, async (base, server) => {
    server.memory.add({ fact: 'Learns best with cooking analogies.', kind: 'preference', source: 'user' });
    const res = await post(base, '/api/lesson/stream', { topic: 'steady', continueFrom: { markdown: PARTIAL } });
    assert.equal(res.status, 200);
    const { recs, turn } = await readStream(res);
    assertWellFormed(recs);
    const kept = trimToLastBlock(PARTIAL);
    assert.equal(kept, FULL.slice(0, FULL.indexOf('Third page')), 'mid-page: the "## Page three" heading block is kept, the half paragraph dropped');
    const status = recs.find((r) => r.detail?.kind === 'steering-status').detail;
    assert.deepEqual([status.status, status.resume], ['accepted', true]);
    assert.ok(!recs.some((r) => r.detail?.kind === 'steering-message'), 'no user message without an instruction');
    const replace = recs.find((r) => r.type === 'content' && r.mode === 'replace' && r.revision > 1);
    assert.equal(replace.markdown, kept);
    assert.ok(replace.dil);
    assert.equal(turn.primary.markdown, FULL, 'continued seamlessly mid-page');
    assert.equal(turn.primary.status, 'complete');
    assert.ok(recs.some((r) => r.type === 'reasoning' && /Resuming/.test(r.status.text)));

    const { params } = client.calls.stream[0];
    assert.equal(params.messages.length, 1, 'a single user turn, no assistant prefill');
    assert.equal(params.messages[0].role, 'user');
    const [req, ctx] = params.messages[0].content;
    assert.match(req.text, /Write a lesson about: steady/);
    assert.match(ctx.text, /<lesson_so_far>\n# Steady lesson[\s\S]*## Page two\n\nSecond page text\.\n\n## Page three\n<\/lesson_so_far>/);
    assert.doesNotMatch(ctx.text, /Third page/, 'the unfinished paragraph is dropped');
    assert.match(ctx.text, /continue from the very next sentence; do not repeat or rewrite anything above; keep the same page structure/i);
    assert.match(ctx.text, /partway through the page "## Page three"[\s\S]*without writing its "## " heading again/);
    assert.ok(params.tools.some((t) => t.name === WEB_SEARCH_TOOL.name), 'web search stays on');
    assert.ok(JSON.stringify(params.system).includes('cooking analogies'), 'memory still personalizes');
  });
});

test('continueFrom revise from page N with an instruction: earlier pages kept, steering records, prompt names the page', async () => {
  const client = fakeClient({ text: REST });
  await withServer({ client }, async (base) => {
    const res = await post(base, '/api/lesson/stream', { topic: 'steady', useWebSearch: false, memoryEnabled: false, continueFrom: { markdown: FULL, fromPage: 3, instruction: 'More examples' } });
    const { recs, turn } = await readStream(res);
    assertWellFormed(recs);
    const kept = trimBeforePage(FULL, 3);
    assert.equal(kept, FULL.slice(0, FULL.indexOf('## Page three')));
    const kinds = recs.filter((r) => r.type === 'control').map((r) => r.detail.kind);
    assert.ok(kinds.indexOf('steering-status') > 0 && kinds.indexOf('steering-message') > kinds.indexOf('steering-status'));
    assert.equal(recs.find((r) => r.detail?.kind === 'steering-message').detail.message.content, 'More examples');
    assert.equal(turn.primary.markdown, kept + REST);
    const { params } = client.calls.stream[0];
    assert.equal(params.messages.length, 1);
    const ctx = params.messages[0].content[1].text;
    assert.match(ctx, /rewrite it from page 3 on/);
    assert.match(ctx, /"More examples"/);
    assert.doesNotMatch(ctx, /Third page|Quiz here/);
    assert.ok(!params.tools?.some((t) => t.name === 'web_search'), 'useWebSearch:false honoured');
  });
});

test('continueFrom validation: sizes, fromPage range, messageId reuse', async () => {
  assert.equal(normalizeContinueFrom(undefined), null);
  assert.equal(normalizeContinueFrom('x').status, 400);
  assert.equal(normalizeContinueFrom({ markdown: 3 }).status, 400);
  assert.equal(normalizeContinueFrom({ markdown: 'a'.repeat(200001) }).status, 413);
  assert.equal(normalizeContinueFrom({ markdown: FULL, fromPage: 0 }).status, 400);
  assert.equal(normalizeContinueFrom({ markdown: FULL, fromPage: 6 }).status, 400);
  assert.equal(normalizeContinueFrom({ markdown: FULL, fromPage: 2.5 }).status, 400);
  const ok = normalizeContinueFrom({ markdown: FULL, fromPage: 4, instruction: `  ${'x'.repeat(400)} `, messageId: 'bad id!' });
  assert.equal(ok.kept, trimBeforePage(FULL, 4));
  assert.equal(ok.instruction.length, 300);
  assert.equal(ok.messageId, undefined);
  assert.equal(ok.mode, 'revise');
  await withServer({ client: fakeClient({ text: 'More text.\n' }) }, async (base) => {
    assert.equal((await post(base, '/api/lesson/stream', { topic: 'x', continueFrom: { markdown: FULL, fromPage: 9 } })).status, 400);
    const res = await post(base, '/api/lesson/stream', { topic: 'compound interest', continueFrom: { markdown: '# T\n\n## A\n\nx\n\n## B\n\ny', messageId: 'msg-continued-1234' } });
    const { recs } = await readStream(res);
    assert.ok(recs.filter((r) => r.type === 'content').every((r) => r.messageId === 'msg-continued-1234'), 'same message, so kept resolution ids stay stable');
  });
});

/** First stream: the whole lesson, then finalMessage waits for `gate` (the steer lands meanwhile). */
function finishingClient(first, rest, gate) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          const n = calls.push({ params: structuredClone(params), opts });
          const text = n === 1 ? first : rest;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
              for (const piece of text.match(/[\s\S]{1,16}/g)) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } };
              yield { type: 'content_block_stop', index: 0 };
            },
            async finalMessage() {
              if (n === 1) await gate.promise; // every event is out; the stream will not throw on abort any more
              return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
            },
          };
        },
      },
    },
    messages: { async create() { throw new Error('unused'); } },
  };
}

test('race: a steer that lands after Claude finished is applied as a continuation, not dropped', async () => {
  let open;
  const gate = { promise: new Promise((r) => { open = r; }) };
  const client = finishingClient(FULL, REST, gate);
  await withServer({ client }, async (base) => {
    const res = await post(base, '/api/lesson/stream', { topic: 'steady', useWebSearch: false });
    let op = null;
    let steered = null;
    const { recs, turn } = await readStream(res, async (rec, t) => {
      if (rec.type === 'control') op ??= rec.detail.operationId;
      if (!steered && rec.type === 'content' && t.primary.markdown === FULL) {
        steered = await (await post(base, '/api/lesson/steer', { operationId: op, instruction: 'Shorter' })).json();
        open();
      }
    });
    assert.equal(steered.status, 'accepted');
    assertWellFormed(recs);
    assert.equal(client.calls.length, 2, 'the steer produced a continuation request');
    const kept = trimToLastPage(FULL);
    assert.equal(turn.primary.markdown, kept + REST, 'the last page was replaced by the steered continuation');
    assert.equal(turn.primary.status, 'complete');
    assert.match(client.calls[1].params.messages[0].content[1].text, /"Shorter"/);
    assert.equal(recs.filter((r) => r.type === 'content' && r.status === 'complete').length, 1, 'one completion, after the steer');
    // once the turn is over, the operation is closed: a late steer is rejected (client falls back to continueFrom)
    const late = await post(base, '/api/lesson/steer', { operationId: op, instruction: 'Simpler' });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).reason, 'not_streaming');
  });
});

// ---------------------------------------------------------------- sources across a continuation

test('continuation sources: kept refs seeded, new refs never collide, re-cited URLs keep their number', () => {
  const kept = 'A<Cite refs={["turn0search0"]}/> B<Cite refs={["turn0search2","turn0search1"]}/>';
  const seed = normalizeContinueFrom({
    markdown: `# T\n\n## P\n\n${kept}\n\n## Q\n\nunfinished`,
    sources: [
      { ref: 'turn0search0', url: 'https://a.example/x', title: 'A', snippet: 'a' },
      { ref: 'turn0search2', url: 'https://c.example/z', title: 'C' },
      { ref: 'turn0search7', url: 'https://not-kept.example', title: 'dropped: not cited in the kept pages' },
      { ref: 'evil', url: 'javascript:alert(1)' },
    ],
  }).sources;
  assert.deepEqual(seed.map((s) => [s.ref, s.index]), [['turn0search0', 1], ['turn0search2', 3]]);
  const reg = createContinuationSources({ kept, seed });
  assert.equal(reg.get('turn0search0').url, 'https://a.example/x');
  assert.equal(reg.cite({ url: 'https://c.example/z', cited_text: 'again' }), 'turn0search2', 'same URL, same pill');
  const fresh = reg.cite({ url: 'https://d.example/new', title: 'D', cited_text: 'new' });
  assert.equal(fresh, 'turn0search3', 'after the highest kept ref (search2), even the unseeded search1');
  assert.equal(reg.get(fresh).index, 4);
  assert.equal(reg.cite({ url: 'https://e.example/', title: 'E' }), 'turn0search4');
  assert.deepEqual(reg.list().map((s) => s.index), [1, 3, 4, 5]);
  assert.ok(!citeRefsIn(kept).has(fresh));
});

test('steeringUserContent modes: steer, resume, resume with an instruction, revise', () => {
  const kept = '# T\n\n## P\n\nx<Cite refs={["turn0search0"]}/>\n\n';
  assert.match(steeringUserContent('req', kept, 'Simpler')[1].text, /While it was streaming[\s\S]*Continue the lesson from here/);
  const resume = steeringUserContent('req', kept, '', { mode: 'resume' })[1].text;
  assert.match(resume, /connection dropped[\s\S]*Continue from the very next sentence; do not repeat or rewrite anything above; keep the same page structure/);
  assert.doesNotMatch(resume, /Cite|""/);
  const withChange = steeringUserContent('req', kept, 'Go deeper', { mode: 'resume' })[1].text;
  assert.match(withChange, /asked you to change course for the rest: "Go deeper"[\s\S]*Continue from the very next sentence/);
  assert.match(withChange, /partway through the page "## P"/);
  assert.match(steeringUserContent('req', kept, 'Shorter', { mode: 'revise', fromPage: 2 })[1].text, /from page 2 on[\s\S]*"Shorter"[\s\S]*Write page 2 and every page after it/);
});

// ---------------------------------------------------------------- whole lessons over HTTP

async function lessonOver(base, topic, body = {}) {
  const res = await post(base, '/api/lesson/stream', { topic, verify: false, ...body });
  assert.equal(res.status, 200);
  return readStream(res);
}
const citeResults = (appData) => Object.values(appData?.opGenui?.componentResults || {}).filter((r) => r?.state?.items);

test('continueFrom over HTTP: resume an interrupted cited lesson, old Cite pills keep resolving', async () => {
  const sky = sampleLesson('sky-blue.md');
  const first = await withServer({ client: groundedClient([{ stop_reason: 'end_turn', blocks: citedBlocks(sky) }]) }, (base) => lessonOver(base, 'Why the sky is blue'));
  const full = first.turn.primary;
  assert.equal(full.status, 'complete');
  const md = full.markdown;
  // interrupted inside page 4 ("Sunsets"): pages 1-3 hold two cites, the rest two more
  const partial = md.slice(0, md.indexOf('## Sunsets') + 40);
  const kept = normalizeContinueFrom({ markdown: partial }).kept;
  assert.deepEqual([...citeRefsIn(kept)], ['turn0search0', 'turn0search1']);
  const sources = sourcesFromAppData(full.dil.appData);
  assert.equal(sources.length, 4);

  // Claude continues from the next sentence, citing the last two sources again
  const client = groundedClient([{ stop_reason: 'end_turn', blocks: citedBlocks(sky.slice(stripGroundingTags(kept).length)) }]);
  const { recs, turn } = await withServer({ client }, (base) => lessonOver(base, 'Why the sky is blue', { continueFrom: { markdown: partial, messageId: first.recs.find((r) => r.type === 'content').messageId, sources } }));
  assertWellFormed(recs);
  const out = turn.primary;
  assert.equal(out.status, 'complete');
  assert.ok(out.markdown.startsWith(kept));
  assert.equal(out.markdown, md, 'the kept pages and the continuation join into the same lesson');
  // ids: kept refs reused, the new cites numbered after them, Sources lists old + new
  assert.deepEqual([...citeRefsIn(out.markdown)].sort(), ['turn0search0', 'turn0search1', 'turn0search2', 'turn0search3']);
  const sourcesList = citeResults(out.dil.appData).find((r) => /^Sources/.test(r.state.sources_title));
  assert.equal(sourcesList.state.items.length, 4);
  // the kept program has the same resolution ids as the original (same messageId)
  const replace = recs.find((r) => r.type === 'content' && r.mode === 'replace' && r.revision > 1);
  const origIds = resolutionIdsOf(full.dil);
  for (const id of resolutionIdsOf(replace.dil)) assert.ok(origIds.has(id), `kept id ${id} is stable`);
  // every Cite in the result resolves and renders
  const env = runProgram(out.dil);
  assert.deepEqual(env.errors, []);
  assert.equal(catalogNodes(env.mirror, 'Quiz').length, 1);
});

test('continueFrom over HTTP: revise a finished lesson from page 3 with "Simpler"', async () => {
  const md = sampleLesson('compound-interest.md');
  const simpler = `## The simple version\n\n<Callout title="Steered: Simpler" tone="tip">Money grows on money.</Callout>\n\n${sliceFromPage(md, pageCount(md))}`;
  const client = fakeClientBy((params) => ({ text: /<lesson_so_far>/.test(lastUserText(params)) ? simpler : md }));
  await withServer({ client }, async (base) => {
    assert.equal((await lessonOver(base, 'compound interest')).turn.primary.markdown, md);
    const { recs, turn } = await lessonOver(base, 'compound interest', { continueFrom: { markdown: md, fromPage: 3, instruction: STEER_CHIPS[0].instruction } });
    assertWellFormed(recs);
    const out = turn.primary.markdown;
    const kept = trimBeforePage(md, 3);
    assert.equal(out, kept + simpler, 'pages 1-2 untouched, the rest rewritten');
    assert.match(lastUserText(client.calls.stream[1].params), /rewrite it from page 3 on/);
    assert.ok(recs.some((r) => r.detail?.kind === 'steering-message'));
    const env = runProgram(turn.primary.dil);
    assert.deepEqual(env.errors, []);
    assert.equal(compileWonder(out).components.filter((c) => c.status !== 'valid').length, 0);
  });
});

// ---------------------------------------------------------------- client helpers (steering-core)

test('client tail replacement + componentResults merge: kept pills survive, rewritten widgets reset', () => {
  const salt = 'msg-client-merge';
  const lesson = '# T\n\nHook.\n\n## One\n\nFact<Cite refs={["turn0search0"]}/>.\n\n## Two\n\nOther<Cite refs={["turn0search1"]}/>.\n\n<Quiz questions={[{"question":"Q?","options":["a","b"],"answer":0}]}/>\n';
  const full = toWonderDil(compileWonder(lesson, { salt }), {});
  const ids = [...resolutionIdsOf(full)];
  assert.ok(ids.length >= 3);
  const item = (n) => ({ ref: `turn0search${n}`, ref_id: `turn0search${n}`, index: n + 1, url: `https://s${n}.example/`, title: `S${n}`, domain: `s${n}.example`, snippet: null });
  const [citeA, citeB, quizId] = ids; // program order: Cite (page One), Cite (page Two), Quiz
  const oldDilAppData = { opGenui: { componentResults: { [citeA]: { status: 'resolved', state: { items: [item(0)] } }, [citeB]: { status: 'resolved', state: { items: [item(1)] } } } } };
  const widget = { opGenui: { componentResults: { [quizId]: { status: 'resolved', state: { answers: [1] } } } } };
  // the continuation's first program: page One kept
  const kept = trimToLastPage(lesson.slice(0, lesson.indexOf('Other')));
  const keptDil = toWonderDil(compileWonder(kept, { salt, partial: true }), {});
  const c = carryOver({ dilAppData: oldDilAppData, widgetAppData: widget }, keptDil);
  assert.deepEqual(Object.keys(c.carried), [citeA], 'only the kept page keeps its citation result');
  assert.deepEqual(c.widgetAppData.opGenui.componentResults, {}, 'the rewritten quiz starts fresh');
  // the new stream resolves its own cites; carried ones fill the gaps
  const merged = mergeContinuedAppData(c.carried, { opGenui: { componentResults: { [citeB]: { status: 'resolved', state: { items: [item(5)] } } } } });
  assert.equal(merged.opGenui.componentResults[citeA].state.items[0].ref, 'turn0search0');
  assert.equal(merged.opGenui.componentResults[citeB].state.items[0].ref, 'turn0search5', 'new wins');
  assert.deepEqual(merged.opGenui.modelDataBindings, {});
  // ConversationTurn applies the continuation stream: empty start, kept replace, new tail
  const turn = new ConversationTurn();
  for (const r of [
    { version: 2, type: 'content', messageId: salt, revision: 1, mode: 'replace', markdown: '', status: 'streaming' },
    { version: 2, type: 'content', messageId: salt, revision: 2, mode: 'replace', markdown: kept, status: 'streaming', dil: keptDil },
    { version: 2, type: 'content', messageId: salt, revision: 3, mode: 'append', baseRevision: 2, markdown: '## Two, again\n\nNew.\n', status: 'complete' },
  ]) turn.apply(validateRecord(r));
  assert.equal(turn.primary.markdown, `${kept}## Two, again\n\nNew.\n`);
  // sources sent back to the server: unique refs in pill order
  assert.deepEqual(sourcesFromAppData(merged).map((s) => s.ref), ['turn0search0', 'turn0search5']);
});

test('page helpers: trimBeforePage / sliceFromPage / pageTitles / keptForContinue (fence-aware)', () => {
  assert.equal(trimBeforePage(FULL, 1), '# Steady lesson\n\nA hook sentence here.\n\n');
  assert.equal(trimBeforePage(FULL, 2) + sliceFromPage(FULL, 2), FULL);
  assert.equal(sliceFromPage(FULL, 9), '');
  assert.deepEqual(pageTitles(FULL), ['Page one', 'Page two', 'Page three', 'Check your understanding']);
  assert.deepEqual(pageTitles('# T\n\n## A\n\n```\n## no\n```\n'), ['A']);
  assert.equal(keptForContinue(FULL), trimToLastPage(FULL));
  assert.equal(keptForContinue(FULL, 2), trimBeforePage(FULL, 2));
});

test('persistence states: streaming / interrupted / complete detection after a reload; failure mapping', () => {
  const dil = { code: 'x' };
  assert.equal(lessonPhase({ status: 'complete', dil, markdown: FULL }), 'complete');
  assert.equal(lessonPhase({ status: 'streaming', streamOwner: 'page-a', markdown: PARTIAL }, { pageId: 'page-a' }), 'streaming');
  assert.equal(lessonPhase({ status: 'streaming', streamOwner: 'page-a', markdown: PARTIAL }, { pageId: 'page-b' }), 'interrupted', 'reloaded page: another owner');
  assert.equal(lessonPhase({ status: 'interrupted', markdown: PARTIAL }, { pageId: 'page-b' }), 'interrupted');
  assert.equal(lessonPhase({ status: 'streaming', streamOwner: 'page-a', markdown: '' }, { pageId: 'page-b' }), 'new', 'nothing written yet: start over');
  assert.equal(lessonPhase({ status: 'failed', markdown: PARTIAL }), 'new');
  assert.equal(lessonPhase({ status: 'new', markdown: '' }), 'new');
  // control failed codes from the stream: stalled / network are resumable interruptions
  assert.ok(isResumableFailure('stalled') && isResumableFailure('network'));
  assert.ok(isResumableFailure('rate_limited') && isResumableFailure('overloaded') && isResumableFailure('api_error'), 'try-again-later failures keep the pages too');
  assert.ok(!isResumableFailure('bad_request') && !isResumableFailure('auth_failed') && !isResumableFailure(undefined));
  assert.equal(statusAfterStop({ markdown: PARTIAL, failureCode: 'stalled' }), 'interrupted');
  assert.equal(statusAfterStop({ markdown: PARTIAL, failureCode: 'network' }), 'interrupted');
  assert.equal(statusAfterStop({ markdown: PARTIAL }), 'interrupted', 'client-side drop (fetch threw)');
  assert.equal(statusAfterStop({ markdown: PARTIAL, failureCode: 'rate_limited' }), 'interrupted', 'a 429 keeps the pages: retry from there');
  assert.equal(statusAfterStop({ markdown: PARTIAL, failureCode: 'bad_request' }), 'failed', 'a bad request keeps the error display');
  assert.equal(statusAfterStop({ markdown: PARTIAL, failureCode: 'http', retryable: true }), 'interrupted');
  assert.equal(statusAfterStop({ markdown: '', failureCode: 'stalled' }), 'failed', 'nothing to resume');
  assert.equal(statusAfterStop({ markdown: PARTIAL, aborted: true }), 'interrupted');
});
