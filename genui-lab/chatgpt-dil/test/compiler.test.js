import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, parseMarkup, resolutionIdsFromProgram, defaultResolutionId, toDilPayload } from '../src/compiler.js';
import { validateDil } from '../src/stream.js';
import { finalDil, finalMarkdown, streamText } from './helpers.js';

const assertCompiles = (code) => assert.doesNotThrow(() => new Function('DIL', '__dil', 'GenUI', 'Date', '"use strict";\n' + code));

test('golden: final markdown compiles byte-for-byte to the server dil.code and constants', () => {
  const dil = finalDil();
  const ids = resolutionIdsFromProgram(dil.code, dil.constants);
  const r = compile(finalMarkdown(), { resolutionIdFor: ids });
  assert.equal(r.code, dil.code);
  assert.deepEqual(r.constants, dil.constants);
  assert.deepEqual(r.requiredComponents, dil.requiredComponents);
});

test('golden: every streamed revision recompiles to the server program (partial mode)', () => {
  let md = '';
  let checked = 0;
  for (const line of streamText().split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.type !== 'content') continue;
    md = rec.mode === 'append' ? md + rec.markdown : rec.markdown;
    if (!rec.dil) continue;
    const ids = resolutionIdsFromProgram(rec.dil.code, rec.dil.constants);
    const r = compile(md, { partial: rec.status !== 'complete', resolutionIdFor: ids });
    assert.equal(r.code, rec.dil.code, `revision ${rec.revision} code`);
    assert.deepEqual(r.constants, rec.dil.constants, `revision ${rec.revision} constants`);
    assert.deepEqual(r.requiredComponents, rec.dil.requiredComponents ?? [], `revision ${rec.revision} requiredComponents`);
    checked++;
  }
  assert.equal(checked, 44);
});

test('structure: headings, paragraphs, components and hoisting rules', () => {
  const r = compile(finalMarkdown());
  assert.ok(r.code.startsWith('function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}\n\nDIL.render(__dil.jsx(()=>{const __dilConstants=DIL.useConstants();'));
  assert.ok(r.code.endsWith(';},{"key":"body:0"}));'));
  assert.match(r.code, /return __dil\.jsx\(__dil\.Fragment,null,__dil\.jsx\("title",\{"size":"xl"\},__dilConstants\["0"\]\)/);
  assert.equal(r.constants['0'], 'Tokyo weather this week & Apple stock');
  assert.deepEqual(r.requiredComponents, ['AsyncImage', 'Cite', 'Entity', 'StockChart']);
  for (const name of r.requiredComponents) assert.match(r.code, new RegExp(`__dilSafe\\(\\(\\)=>\\(__dil\\.jsx\\(${name},`));
  // Entity.value and Cite.refs are hoisted; StockChart props are inline
  assert.match(r.code, /__dil\.jsx\(Entity,\{"value":__dilConstants\["\d+"\],"category":"stock"/);
  assert.match(r.code, /__dil\.jsx\(Cite,\{"refs":__dilConstants\["\d+"\]/);
  assert.match(r.code, /__dil\.jsx\(StockChart,\{"ticker":"AAPL","asset_type":"equity","market":"USA","__resolutionId":__dilConstants\["\d+"\]\}/);
  assert.ok(Object.values(r.constants).some((v) => Array.isArray(v) && v[0] === 'turn555745search23'));
  // bare text inside a box becomes a text element
  assert.ok(Object.values(r.constants).includes('Mostly cloudy, warm and humid'));
  // default resolution ids are deterministic UUID-shaped strings
  const ids = Object.values(r.constants).filter((v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v));
  assert.equal(ids.length, 6);
  assert.equal(compile(finalMarkdown()).code, r.code);
  assertCompiles(r.code);
});

test('partial input: ~50 cut points of the final markdown always compile', () => {
  const md = finalMarkdown();
  const cuts = new Set();
  for (let i = 0; i <= 50; i++) cuts.add(Math.round((md.length * i) / 50));
  // also cut inside tags, attribute values and expressions
  for (const needle of ['<box border', 'query="partly', 'refs={["turn', '</grid-it', '<Entity value="Ap', '**What to', '</', '<']) {
    const at = md.indexOf(needle);
    if (at >= 0) cuts.add(at + needle.length);
  }
  for (const n of cuts) {
    const prefix = md.slice(0, n);
    let r;
    assert.doesNotThrow(() => { r = compile(prefix, { partial: true }); }, `cut at ${n}`);
    assertCompiles(r.code);
    for (const v of Object.values(r.constants)) assert.ok(typeof v !== 'string' || !/<(box|row|AsyncImage|Entity|Cite)\b/.test(v), `no raw tag text leaked at cut ${n}: ${v}`);
  }
});

test('partial input: incomplete trailing tag is dropped and empty auto-closed elements are pruned', () => {
  const r = compile('Hello\n\n<box gap={2}>\n  <text size="sm">Wett', { partial: true });
  assert.match(r.code, /__dil\.jsx\("box",\{"gap":2\},__dil\.jsx\("text",\{"size":"sm"\},__dilConstants\["1"\]\)\)/);
  assert.equal(r.constants['1'], 'Wett');
  const r2 = compile('Hi\n\n<grid columns={3}>\n<grid-item>\n<text color="secondary" size="xs', { partial: true });
  assert.doesNotMatch(r2.code, /grid/);
  const r3 = compile('Price is $5. <Cite refs={["turn1sea', { partial: true });
  assert.equal(r3.constants['0'], 'Price is $5. ');
  assert.deepEqual(r3.requiredComponents, []);
});

test('markdown blocks: lists, rules, code fences, links, emphasis', () => {
  const r = compile('# T\n\n- one **b**\n- two\n  - nested\n\n1. first\n\n---\n\nSee [docs](https://example.com) and `x<y`.\n\n```js\nconst a = "<box>";\n```');
  assert.match(r.code, /__dil\.jsx\("list",\{"marker":"bullet"\},__dil\.jsx\("list-item",null,__dilConstants\["1"\],__dil\.jsx\("bold"/);
  assert.match(r.code, /"list",\{"marker":"number"\}/);
  assert.match(r.code, /__dil\.jsx\("divider",null\)/);
  assert.match(r.code, /__dil\.jsx\("link",\{"href":"https:\/\/example.com"\}/);
  assert.match(r.code, /__dil\.jsx\("code",null,__dilConstants/);
  assert.ok(Object.values(r.constants).some((v) => typeof v === 'string' && v.startsWith('```js') && v.includes('"<box>"')));
  assert.doesNotMatch(r.code, /"box"/);
  assertCompiles(r.code);
});

test('empty input and dil payload shape', () => {
  const r = compile('');
  assert.match(r.code, /return null;/);
  assert.doesNotMatch(r.code, /__dilSafe/);
  const dil = toDilPayload(compile(finalMarkdown()));
  assert.doesNotThrow(() => validateDil(dil));
  assert.equal(dil.renderer, 'dil-v2');
});

test('parseMarkup ignores unknown lowercase tags and comparisons', () => {
  const t = parseMarkup('a < b and <div>x</div> <text>y</text>');
  const els = t.children.filter((c) => typeof c !== 'string');
  assert.equal(els.length, 1);
  assert.equal(els[0].name, 'text');
  assert.equal(defaultResolutionId('A', {}, 0), defaultResolutionId('A', {}, 0));
  assert.notEqual(defaultResolutionId('A', {}, 0), defaultResolutionId('A', {}, 1));
});
