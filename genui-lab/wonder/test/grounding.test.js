// Phase 3: web search + citations -> <Cite/> pills, componentResults, <Sources/>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import {
  WEB_SEARCH_TOOL, withWebSearch, createSourceRegistry, createCiteAssembler, isSafeInsertionPoint, citeComponentResults,
  stripGroundingTags, streamGrounded,
} from '../server/grounding.js';
import { buildStreamParams } from '../server/claude.js';
import { compileWonder } from '../server/compile.js';
import { parseConversationSource, ConversationTurn } from '../../chatgpt-dil/src/stream.js';
import { fakeClient, demo, runProgram, catalogNodes } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {} };
async function withServer(opts, fn) {
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const records = async (res) => parseConversationSource(await res.text());
const fold = (recs) => { const t = new ConversationTurn(); for (const r of recs) t.apply(r); return t.primary; };

const RAYLEIGH = { type: 'web_search_result_location', url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering', title: 'Rayleigh scattering - Wikipedia', encrypted_index: 'x', cited_text: 'The intensity of Rayleigh scattering is inversely proportional to the fourth power of wavelength.' };
const NASA = { type: 'web_search_result_location', url: 'https://www.nasa.gov/sky', title: 'Why is the sky blue', encrypted_index: 'y', cited_text: 'Blue light is scattered more.' };

/**
 * Fake client for server-tool turns: each element of `turns` is one API response, a list of
 * content blocks ({type:'text', text, citations?} | {type:'server_tool_use', id, name, input} |
 * {type:'web_search_tool_result', tool_use_id, content}) streamed as SDK events, plus stop_reason.
 */
function groundedClient(turns) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          const turn = turns[Math.min(calls.length, turns.length - 1)];
          calls.push({ params: structuredClone(params), opts });
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { id: `msg_${calls.length}` } };
              for (const [index, b] of turn.blocks.entries()) {
                if (b.type === 'text') {
                  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } };
                  for (const c of b.citations || []) yield { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: c } };
                  for (const piece of b.text.match(/[\s\S]{1,7}/g) || []) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } };
                } else if (b.type === 'server_tool_use') {
                  yield { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id: b.id, name: b.name, input: {} } };
                  const json = JSON.stringify(b.input);
                  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } };
                  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } };
                } else {
                  yield { type: 'content_block_start', index, content_block: b };
                }
                yield { type: 'content_block_stop', index };
              }
              yield { type: 'message_delta', delta: { stop_reason: turn.stop_reason } };
            },
            async finalMessage() { return { id: `msg_${calls.length}`, stop_reason: turn.stop_reason, content: turn.blocks }; },
          };
        },
      },
    },
    messages: { async create() { throw new Error('unused'); } },
  };
}

const SEARCH_TURN = {
  stop_reason: 'pause_turn',
  blocks: [
    { type: 'text', text: '# Why the sky is blue\n\nYou look up. ' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'rayleigh scattering wavelength' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: RAYLEIGH.url, title: 'Rayleigh scattering - Wikipedia', encrypted_content: 'e', page_age: 'May 2026' }] },
  ],
};
const ANSWER_TURN = {
  stop_reason: 'end_turn',
  blocks: [
    { type: 'text', text: '## Scattering\n\nShort waves scatter far more: ' },
    { type: 'text', text: 'scattering grows as one over the wavelength to the fourth power', citations: [RAYLEIGH] },
    { type: 'text', text: '. That is why ' },
    { type: 'text', text: 'the sky looks blue\n\n', citations: [NASA, RAYLEIGH] },
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'mars sunset' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: '<KeyTerm term="wavelength" definition="Distance between crests."/> matters.\n' },
  ],
};

test('web_search tool is added only when enabled (and never code_execution)', () => {
  const base = buildStreamParams({ system: 'S', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(withWebSearch(base, false).tools, undefined);
  const p = withWebSearch(base, true);
  assert.deepEqual(p.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] }]);
  assert.deepEqual(WEB_SEARCH_TOOL, p.tools[0]);
  assert.ok(!JSON.stringify(p.tools).includes('code_execution'));
  assert.equal(withWebSearch(p, true).tools.length, 1, 'idempotent');
});

test('lesson requests search by default; useWebSearch:false and the tutor (unless asked) do not', async () => {
  const client = fakeClient({ text: '# T\n\nHello.\n' });
  await withServer({ mode: 'claude', client }, async (base) => {
    await records(await post(base, '/api/lesson/stream', { topic: 'sky' }));
    await records(await post(base, '/api/lesson/stream', { topic: 'sky', useWebSearch: false }));
    await records(await post(base, '/api/tutor/stream', { message: 'why?', lessonContext: { title: 'T', markdown: '# T <Cite refs={["turn0search0"]}/>' } }));
    await records(await post(base, '/api/tutor/stream', { message: 'latest data?', useWebSearch: true, lessonContext: { title: 'T', markdown: '# T' } }));
  });
  const tools = client.calls.stream.map((c) => (c.params.tools || []).map((t) => t.type));
  assert.deepEqual(tools, [['web_search_20260209'], [], [], ['web_search_20260209']]);
  assert.doesNotMatch(client.calls.stream[2].params.system[1].text, /<Cite/, 'server-inserted cites are stripped from tutor context');
  for (const c of client.calls.stream) {
    assert.notEqual(c.params.messages.at(-1).role, 'assistant', 'no prefill');
    assert.deepEqual(c.params.thinking, { type: 'adaptive' });
    assert.ok(c.params.output_config.effort);
  }
});

test('citations become <Cite/> after the cited span; pause_turn continues with the paused content', async () => {
  const client = groundedClient([SEARCH_TURN, ANSWER_TURN]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const recs = await records(await post(base, '/api/lesson/stream', { topic: 'why is the sky blue' }));
    const msg = fold(recs);
    assert.equal(msg.status, 'complete');
    // cited spans get pills right after them, before the held-back punctuation/whitespace
    assert.match(msg.markdown, /fourth power<Cite refs=\{\["turn0search0"\]\}\/>\. That is why the sky looks blue<Cite refs=\{\["turn0search1","turn0search0"\]\}\/>\n\n/);
    assert.match(msg.markdown, /\n<Sources\/>\n$/, 'Sources list appended at the end');
    assert.equal(stripGroundingTags(msg.markdown), '# Why the sky is blue\n\nYou look up. \n\n## Scattering\n\nShort waves scatter far more: scattering grows as one over the wavelength to the fourth power. That is why the sky looks blue\n\n<KeyTerm term="wavelength" definition="Distance between crests."/> matters.\n');

    // pause_turn: second request = same messages + the paused assistant content, no extra user turn
    assert.equal(client.calls.length, 2);
    const second = client.calls[1].params.messages;
    assert.equal(second.length, 2);
    assert.equal(second[0].role, 'user');
    assert.equal(second[1].role, 'assistant');
    assert.deepEqual(second[1].content, SEARCH_TURN.blocks);
    assert.deepEqual(client.calls[1].params.tools, [WEB_SEARCH_TOOL]);

    // reasoning narrates searches (query from server_tool_use input) and the server-tool error
    const texts = recs.filter((r) => r.type === 'reasoning').map((r) => r.status.text);
    assert.ok(texts.includes('Searching the web: “rayleigh scattering wavelength”'));
    assert.ok(texts.includes('Searching the web: “mars sunset”'));
    assert.ok(texts.some((t) => /Search is unavailable/.test(t)));

    // componentResults: resolved Cite state (ChatGPT shape) + Sources
    const results = msg.dil.appData.opGenui.componentResults;
    const states = Object.values(results).map((r) => r.state);
    const cites = states.filter((s) => s.active_index === 0);
    assert.equal(cites.length, 2);
    assert.deepEqual(cites[0].items[0], {
      ref: 'turn0search0', ref_id: 'turn0search0', index: 1, url: RAYLEIGH.url, title: 'Rayleigh scattering - Wikipedia', domain: 'en.wikipedia.org',
      source_label: 'en.wikipedia.org', snippet: RAYLEIGH.cited_text, page_age: 'May 2026',
    });
    assert.equal(cites[1].sources_title, '2 sources');
    assert.deepEqual(cites[1].items.map((i) => i.domain), ['nasa.gov', 'en.wikipedia.org']);
    const sources = states.find((s) => /^Sources/.test(s.sources_title));
    assert.deepEqual(sources.items.map((i) => i.index), [1, 2]);

    // the program renders numbered pills and the list in the sandbox
    const env = runProgram(msg.dil);
    assert.deepEqual(env.errors, []);
    assert.deepEqual(catalogNodes(env.mirror, 'Cite').map((n) => env.mirror.text(n)), ['1', '2,1']);
    assert.match(env.mirror.text(catalogNodes(env.mirror, 'Sources')[0]), /Sources \(2\).*Rayleigh scattering - Wikipedia.*en\.wikipedia\.org.*Why is the sky blue.*nasa\.gov/);
    assert.ok(catalogNodes(env.mirror, 'KeyTerm').length, 'KeyTerm after the cites still renders');
  });
});

test('a streamed partial dil already carries the resolved cite (no unresolved flash)', async () => {
  const client = groundedClient([ANSWER_TURN]);
  await withServer({ mode: 'claude', client }, async (base) => {
    const recs = await records(await post(base, '/api/lesson/stream', { topic: 'sky' }));
    const withCite = recs.filter((r) => r.type === 'content' && r.dil && /Cite/.test(r.dil.code));
    assert.ok(withCite.length >= 1);
    for (const r of withCite) assert.ok(Object.keys(r.dil.appData.opGenui.componentResults).length >= 1);
  });
});

test('cites are never inserted inside a tag, code or math: they wait for a safe point', () => {
  assert.equal(isSafeInsertionPoint('Plain text'), true);
  assert.equal(isSafeInsertionPoint('A <KeyTerm term="x" definition="the 1905'), false);
  assert.equal(isSafeInsertionPoint('<Timeline events={[{"date":"1905","label":"a > b'), false);
  assert.equal(isSafeInsertionPoint('<box padding={4'), false);
  assert.equal(isSafeInsertionPoint('```js\nconst a = 1'), false);
  assert.equal(isSafeInsertionPoint('Use `npm run'), false);
  assert.equal(isSafeInsertionPoint('<math>E = mc^2'), false);
  assert.equal(isSafeInsertionPoint('Formula \\( a^2'), false);
  assert.equal(isSafeInsertionPoint('<KeyTerm term="x" definition="y"/> done'), true);

  const reg = createSourceRegistry();
  let out = '';
  const asm = createCiteAssembler({ emit: (s) => { out += s; }, registry: reg });
  asm.text('Einstein published it in ');
  asm.blockStart();
  asm.citation(RAYLEIGH);
  asm.text('<KeyTerm term="relativity" definition="Published in 1905');
  asm.blockStop(); // unsafe: inside the tag's attribute
  assert.doesNotMatch(out, /Cite/);
  asm.text('."/> and it changed physics');
  asm.text(' forever.');
  asm.flush();
  assert.equal(out, 'Einstein published it in <KeyTerm term="relativity" definition="Published in 1905."/><Cite refs={["turn0search0"]}/> and it changed physics forever.');
  assert.deepEqual(compileWonder(out).components.map((c) => c.status), ['valid']);
});

test('source registry: stable refs per URL, turn index, non-http URLs ignored', () => {
  const reg = createSourceRegistry({ turnIndex: 3 });
  assert.equal(reg.cite(RAYLEIGH), 'turn3search0');
  assert.equal(reg.cite(NASA), 'turn3search1');
  assert.equal(reg.cite({ ...RAYLEIGH, cited_text: 'other' }), 'turn3search0');
  assert.equal(reg.cite({ url: 'javascript:alert(1)', title: 'x' }), null);
  assert.equal(reg.size, 2);
  assert.equal(reg.get('turn3search1').domain, 'nasa.gov');
  assert.deepEqual(citeComponentResults(compileWonder('Hi'), reg), {});
});

test('streamGrounded caps pause_turn continuations', async () => {
  const client = groundedClient([SEARCH_TURN]);
  const r = await streamGrounded(client, { model: 'm', messages: [{ role: 'user', content: 'q' }] }, { onText() {}, maxContinuations: 2 });
  assert.equal(r.stopReason, 'pause_turn');
  assert.equal(client.calls.length, 3);
  const last = client.calls[2].params.messages;
  assert.equal(last.length, 2, 'paused content is merged into one assistant turn');
  assert.equal(last[1].content.length, SEARCH_TURN.blocks.length * 2);
});

test('Cite pill opens a card with title/domain/snippet and an open_url action; Sources list', () => {
  const reg = createSourceRegistry();
  const r1 = reg.cite(RAYLEIGH);
  const md = `Short waves scatter more<Cite refs={["${r1}"]}/>.\n\n<Sources/>\n`;
  const out = compileWonder(md);
  const env = runProgram({ ...out, appData: { opGenui: { componentResults: citeComponentResults(out, reg) } } });
  assert.deepEqual(env.errors, []);
  const pill = catalogNodes(env.mirror, 'Cite')[0];
  assert.equal(env.mirror.text(pill), '1');
  assert.match(pill.props.ariaLabel, /Source 1: Rayleigh scattering/);
  assert.equal(catalogNodes(env.mirror, 'CiteCard').length, 0);
  env.rt.invokeFunction(pill.props.onClick.__fn, []);
  const card = catalogNodes(env.mirror, 'CiteCard')[0];
  assert.match(env.mirror.text(card), /en\.wikipedia\.org.*Rayleigh scattering - Wikipedia.*inversely proportional/);
  const open = env.mirror.findAll((n) => n.props?.ariaLabel === 'Open Rayleigh scattering - Wikipedia', card)[0];
  env.rt.invokeFunction(open.props.onClick.__fn, []);
  assert.deepEqual(env.actions.at(-1), { handler: 'client', type: 'open_url', payload: { url: RAYLEIGH.url } });
  const src = catalogNodes(env.mirror, 'Sources')[0];
  env.rt.invokeFunction(env.mirror.findAll((n) => n.props?.variant === 'source', src)[0].props.onClick.__fn, []);
  assert.equal(env.actions.at(-1).payload.url, RAYLEIGH.url);
  // unresolved cites (e.g. written by the model with unknown refs) render nothing
  const bare = runProgram(compileWonder('Text<Cite refs={["turn9search9"]}/> more.'));
  assert.deepEqual(bare.errors, []);
  assert.equal(catalogNodes(bare.mirror, 'Cite').length, 0);
  assert.match(bare.mirror.text(), /Text more\./);
});

test('demo mode: the sky lesson streams deterministic citations; useWebSearch:false turns them off', async () => {
  await withServer({ mode: 'demo' }, async (base) => {
    const msg = fold(await records(await post(base, '/api/lesson/stream', { topic: 'why is the sky blue?' })));
    assert.equal((msg.markdown.match(/<Cite /g) || []).length, 4);
    assert.equal(stripGroundingTags(msg.markdown), demo('sky-blue.md'));
    const env = runProgram(msg.dil);
    assert.deepEqual(env.errors, []);
    assert.deepEqual(catalogNodes(env.mirror, 'Cite').map((n) => env.mirror.text(n)), ['1', '2', '3', '4']);
    assert.match(env.mirror.text(catalogNodes(env.mirror, 'Sources')[0]), /Sources \(4\).*spaceplace\.nasa\.gov/);

    const off = fold(await records(await post(base, '/api/lesson/stream', { topic: 'why is the sky blue?', useWebSearch: false })));
    assert.equal(off.markdown, demo('sky-blue.md'));
  });
});
