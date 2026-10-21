import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWonder, preprocess, scanComponentTags } from '../server/compile.js';
import { parseLenientJSON, tryParseExpression } from '../server/lenient-json.js';
import { validateComponentProps, normalizeQuestion } from '../server/catalog-schema.js';
import { demo, DEMO_FILES, runProgram } from './helpers.js';

const constantsOf = (r) => Object.values(r.constants);

test('lenient JSON: strict JSON, unquoted keys, single quotes, trailing commas, comments', () => {
  assert.deepEqual(parseLenientJSON('{"a":[1,2,{"b":"c"}]}'), { a: [1, 2, { b: 'c' }] });
  assert.deepEqual(parseLenientJSON("{label: 'Hi', n: .5, m: +2, x: 0x10, list: [1, 2,],}"), { label: 'Hi', n: 0.5, m: 2, x: 16, list: [1, 2] });
  assert.deepEqual(parseLenientJSON('[/* note */ "a", // trailing\n "b"]'), ['a', 'b']);
  assert.deepEqual(parseLenientJSON('{q: "say \\"hi\\"", t: `back tick`, u: undefined}'), { q: 'say "hi"', t: 'back tick', u: null });
  assert.equal(parseLenientJSON("'don\\'t'"), "don't");
  assert.equal(parseLenientJSON('"\\u00e9\\u{1F600}"'), 'é😀');
});

test('lenient JSON never evaluates code', () => {
  for (const src of ['() => 1', 'foo', '{a: foo}', '[1, alert(1)]', '`${x}`', 'new Date()', '{a: 1} + 1']) {
    assert.equal(tryParseExpression(src).ok, false, src);
  }
});

test('JSON props become real values hoisted into constants', () => {
  const md = '# T\n\n<Quiz questions={[{"prompt":"2+2?","options":["3","4"],"correct":"4"}]}/>\n';
  const r = compileWonder(md, { salt: 's' });
  assert.deepEqual(r.requiredComponents, ['Quiz']);
  assert.match(r.code, /__dil\.jsx\(Quiz,\{"questions":__dilConstants\["\d+"\],"__resolutionId":__dilConstants\["\d+"\]\}\)/);
  const questions = constantsOf(r).find(Array.isArray);
  assert.equal(questions[0].prompt, '2+2?');
  assert.deepEqual(questions[0].options, [{ value: 'a', label: '3' }, { value: 'b', label: '4' }]);
  assert.deepEqual(questions[0].correct_values, ['b'], 'correct label normalized to its option value');
  assert.doesNotMatch(r.code, /__wonder_h/, 'placeholders replaced');
});

test('numbers and booleans stay inline literals; strings and objects are hoisted', () => {
  const r = compileWonder('<Celebration message="Yay"/>\n\n<row gap={2}><badge>x</badge></row>');
  assert.match(r.code, /"gap":2/);
  assert.ok(constantsOf(r).includes('Yay'));
  assert.doesNotMatch(r.code, /"Yay"/);
});

test('lenient props written by the model (unquoted keys, single quotes, trailing commas) validate', () => {
  const md = "<BarChart unit='%' bars={[{label: 'a', value: 1,}, {label: 'b', value: '2'},]}/>";
  const r = compileWonder(md);
  assert.deepEqual(r.requiredComponents, ['BarChart']);
  const bars = constantsOf(r).find(Array.isArray);
  assert.deepEqual(bars, [{ label: 'a', value: 1 }, { label: 'b', value: 2 }]);
});

test('invalid props are kept out of the program and replaced by fallback markdown', () => {
  const md = [
    'Intro.',
    '',
    '<Flowchart title="Too small" nodes={[{"id":"a","label":"Only node","type":"start"}]} connections={[]}/>',
    '',
    '<BarChart bars={[{"label":"x","value":1},{"label":"y","value":2}]}/>',
    '',
    '<Reveal items={() => [1]}/>',
    '',
    'Inline <KeyTerm term="orphan"/> term.',
  ].join('\n');
  const r = compileWonder(md);
  assert.deepEqual(r.requiredComponents, [], 'no invalid component reaches the program');
  assert.deepEqual(r.components.map((c) => c.status), ['invalid', 'invalid', 'invalid', 'invalid']);
  assert.match(r.components[1].error, /bar_chart/);
  assert.match(r.components[2].error, /Unparseable/);
  const text = constantsOf(r).filter((v) => typeof v === 'string').join(' | ');
  assert.match(text, /Too small/);
  assert.match(text, /Only node/);
  assert.match(text, /orphan/);
  const env = runProgram(r);
  assert.deepEqual(env.errors, []);
  assert.match(env.mirror.text(), /Only node/);
});

test('bounds come from Wondering voice-visual validators', () => {
  const nodes = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
  assert.equal(validateComponentProps('Flowchart', { nodes: nodes(2) }).ok, false, 'flowchart needs >= 3 nodes');
  assert.equal(validateComponentProps('Flowchart', { nodes: nodes(3) }).ok, true, 'sequential connections are generated');
  assert.equal(validateComponentProps('Flowchart', { nodes: nodes(12) }).ok, false, 'connections to nodes beyond the 8-node bound are rejected');
  assert.equal(validateComponentProps('Timeline', { events: [{ date: '1', label: 'a' }, { date: '2', label: 'b' }] }).ok, false);
  assert.equal(validateComponentProps('BarChart', { unit: 'kg', bars: [{ label: 'a', value: 1 }] }).ok, false, 'bar chart needs >= 2 bars');
  assert.equal(validateComponentProps('InputOutputSlider', { inputLabel: 'x', outputLabel: 'y', stops: [{ value: 1, output: 'a' }, { value: 2, output: 'b' }] }).ok, false);
  const hl = validateComponentProps('BarChart', { unit: 'u', bars: [{ label: 'a', value: 1, highlighted: true }, { label: 'b', value: 2, highlighted: true }] });
  assert.equal(hl.props.bars.filter((b) => b.highlighted).length, 1, 'keepSingleHighlight');
  assert.equal(validateComponentProps('Cycle', { stages: ['a', 'b', 'c'] }).props.stages[0].label, 'a');
});

test('quiz question normalization: true_false defaults, label answers, invalid answers', () => {
  const tf = normalizeQuestion({ prompt: 'Sky is blue', question_type: 'true_false', correct: true });
  assert.deepEqual(tf.props.options.map((o) => o.value), ['true', 'false']);
  assert.deepEqual(tf.props.correct_values, ['true']);
  assert.equal(normalizeQuestion({ prompt: 'x', options: ['a', 'b'], correct_values: ['zzz'] }).ok, false);
  assert.equal(normalizeQuestion({ prompt: 'x', options: ['a', 'b'], correct_values: ['a', 'b'] }).ok, false, 'single_select needs exactly one');
  assert.equal(normalizeQuestion({ prompt: 'x', question_type: 'multi_select', options: ['a', 'b', 'c'], correct_values: ['a', 'c'] }).ok, true);
});

test('Followups are lifted out of the program', () => {
  const r = compileWonder('Answer.\n\n<Followups items={["One?","Two?"]}/>\n');
  assert.deepEqual(r.followups, ['One?', 'Two?']);
  assert.ok(!constantsOf(r).includes('One?'));
  assert.deepEqual(r.requiredComponents, []);
});

test('tags inside code fences and code spans are not components', () => {
  const r = compileWonder('```\n<Quiz questions={[]}/>\n```\n\nUse `<KeyTerm/>` inline.');
  assert.deepEqual(r.requiredComponents, []);
  assert.equal(scanComponentTags('`<Quiz/>`').length, 0);
});

test('Callout keeps markdown children', () => {
  const r = compileWonder('<Callout title="Note" tone="tip">\nSome **bold** words.\n</Callout>');
  assert.deepEqual(r.requiredComponents, ['Callout']);
  const env = runProgram(r);
  assert.match(env.mirror.text(), /Some bold words/);
  assert.match(env.mirror.text(), /TIP/);
});

for (const file of DEMO_FILES) {
  test(`demo ${file}: every streamed prefix compiles to valid, runnable code`, () => {
    const md = demo(file);
    let lastIds = null;
    for (let n = 0; n <= md.length; n++) {
      const prefix = md.slice(0, n);
      let r;
      try { r = compileWonder(prefix, { partial: true, salt: 'm', fallback: false }); } catch (e) { assert.fail(`prefix ${n} threw: ${e.message}`); }
      assert.doesNotMatch(r.code, /__wonder_h/, `prefix ${n}`);
      try { new Function('DIL', '__dil', 'GenUI', r.code); } catch (e) { assert.fail(`prefix ${n} produced invalid JS: ${e.message}`); }
      if (n % 97 === 0 || n === md.length) {
        const env = runProgram(r);
        assert.deepEqual(env.errors, [], `prefix ${n} runtime errors`);
        // resolution ids are stable as the message grows
        const ids = Object.fromEntries(r.components.filter((c) => c.status === 'valid').map((c, i) => [i, c.name]));
        if (lastIds) for (const k of Object.keys(lastIds)) assert.equal(ids[k], lastIds[k], `component order stable at ${n}`);
        lastIds = ids;
      }
    }
    const full = compileWonder(md, { salt: 'm' });
    assert.ok(full.components.length >= 8, 'demo lesson uses the catalog');
    assert.deepEqual(full.components.filter((c) => c.status !== 'valid'), [], 'every demo component validates');
    assert.ok(full.fallbackMarkdown.length > 500, 'fallback markdown rendition exists');
  });
}

test('half-written tag at the tail is cut, never shown as raw text', () => {
  const md = 'Hello world\n\n<Quiz questions={[{"prompt":"Is it';
  const r = compileWonder(md, { partial: true });
  assert.deepEqual(r.requiredComponents, []);
  const text = constantsOf(r).filter((v) => typeof v === 'string').join('');
  assert.ok(!text.includes('<Quiz') && !text.includes('prompt'));
  assert.ok(text.includes('Hello world'));
  assert.equal(preprocess(md).components[0].status, 'streaming');
});
