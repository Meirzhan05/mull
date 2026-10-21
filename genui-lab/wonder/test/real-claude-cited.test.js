// Regression: a real claude-opus-5-5 lesson streamed through /api/lesson/stream with web search
// ("What the James Webb Space Telescope has discovered so far"), steered mid-stream with the
// "Simpler" chip. The fixture is the NDJSON exactly as sent to the browser, except that the
// intermediate `dil` payloads (full recompiles, ~2 MB) were dropped; the steering replace and
// the final record keep theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseConversationSource, ConversationTurn } from '../../chatgpt-dil/src/stream.js';
import { compileWonder } from '../server/compile.js';
import { validateFunctionGraph } from '../server/function-graph.js';
import { trimToLastPage } from '../public/steering-core.js';
import { runProgram, catalogNodes } from './helpers.js';

const records = parseConversationSource(fs.readFileSync(new URL('./fixtures/claude-lesson-cited.ndjson', import.meta.url), 'utf8'));
const turn = new ConversationTurn();
for (const r of records) turn.apply(r);
const msg = turn.primary;
const cites = (msg.markdown.match(/<Cite refs=/g) || []).length;

test('real cited lesson: stream replays, steering replaced the tail, cites + Sources present', () => {
  assert.equal(msg.status, 'complete');
  assert.ok(cites >= 5, `${cites} cites`);
  assert.match(msg.markdown, /\n<Sources\/>\n$/);
  const kinds = records.filter((r) => r.type === 'control').map((r) => r.detail.kind);
  assert.ok(kinds.includes('steering-status') && kinds.includes('steering-message'));
  const replace = records.find((r) => r.type === 'content' && r.mode === 'replace' && r.revision > 1);
  assert.ok(msg.markdown.startsWith(replace.markdown));
  const tail = msg.markdown.slice(replace.markdown.length);
  assert.match(tail, /^## /, 'the continuation starts with the next page heading');
  assert.equal(trimToLastPage(replace.markdown + '## next'), replace.markdown, 'kept text ends at a page boundary');
  const searches = records.filter((r) => r.type === 'reasoning' && /^Searching the web: “/.test(r.status.text));
  assert.ok(searches.length >= 2);
  // the client never sees raw search payloads or model internals
  const raw = JSON.stringify(records);
  for (const banned of ['encrypted_content', 'encrypted_index', 'signature', 'srvtoolu_']) assert.ok(!raw.includes(banned), banned);
});

test('real cited lesson: every Cite resolves and renders as a numbered pill; Sources lists them', () => {
  const env = runProgram(msg.dil);
  assert.deepEqual(env.errors, []);
  const pills = catalogNodes(env.mirror, 'Cite');
  assert.equal(pills.length, cites, 'every inserted Cite has resolved componentResults');
  for (const p of pills) assert.match(env.mirror.text(p), /^\d+(,\d+)*$/);
  const sources = msg.dil.appData.opGenui.componentResults;
  const list = Object.values(sources).find((r) => /^Sources/.test(r.state.sources_title)).state.items;
  assert.ok(list.length >= 3);
  for (const s of list) {
    assert.match(s.url, /^https:\/\//);
    assert.ok(s.title && s.domain && s.ref.startsWith('turn0search'));
  }
  assert.equal(catalogNodes(env.mirror, 'Sources').length, 1);
  for (const name of ['Quiz', 'KeyTerm']) assert.ok(catalogNodes(env.mirror, name).length >= 1, name);
});

test('real cited lesson: recompiling the final markdown reproduces the final program', () => {
  const out = compileWonder(msg.markdown, { salt: msg.messageId });
  assert.deepEqual(out.components.filter((c) => c.status !== 'valid'), []);
  assert.equal(out.code, msg.dil.code);
});

test('real cited lesson: every streamed prefix compiles and runs', () => {
  const md = msg.markdown;
  const step = Math.max(1, Math.floor(md.length / 80));
  for (let i = 0; i <= md.length; i += step) {
    const env = runProgram({ ...compileWonder(md.slice(0, i), { partial: true, salt: msg.messageId }), appData: msg.dil.appData });
    assert.deepEqual(env.errors, [], `prefix ${i}`);
  }
});

// Written by claude-opus-5-5 for "Understanding sine waves" during the same live check.
const REAL_GRAPH = '<FunctionGraph title="Play with a sine wave" fn="a*sin(b*x)" params={[{"name":"a","min":0.5,"max":3,"step":0.1,"value":1,"label":"amplitude"},{"name":"b","min":0.5,"max":4,"step":0.1,"value":1,"label":"frequency"}]} xRange={[0,12.57]} yRange={[-3.5,3.5]} caption="y = a · sin(b · x). At the start, one full wave is about 6.28 wide (that\'s 2π, one full turn of the wheel)." points={[{"x":1.571,"y":1,"label":"peak"},{"x":4.712,"y":-1,"label":"trough"}]}/>';

test('real Claude FunctionGraph validates, renders and responds to its sliders', () => {
  const out = compileWonder(`## Sine waves\n\n${REAL_GRAPH}\n`);
  assert.equal(out.components[0].status, 'valid');
  assert.ok(validateFunctionGraph(out.components[0].props).ok);
  const env = runProgram(out);
  assert.deepEqual(env.errors, []);
  const curve = () => env.mirror.findAll((n) => n.props?.__component === 'GraphCurve')[0].props.d;
  const before = curve();
  const plus = env.mirror.findAll((n) => n.props?.ariaLabel === 'Increase b')[0];
  env.rt.invokeFunction(plus.props.onClick.__fn, []);
  assert.notEqual(curve(), before);
  assert.match(env.mirror.text(), /b = 1\.1/);
});
