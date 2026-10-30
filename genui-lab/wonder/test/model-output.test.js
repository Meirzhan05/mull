// Robustness against the kinds of markup a real model produces (not just the hand-written sample lessons).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWonder } from '../server/compile.js';
import { runProgram, catalogNodes } from './helpers.js';

const QUIZ = `<Quiz questions={[{"id":"q1","prompt":"Which is larger, 3 > 2 or {curly}?","question_type":"single_select","options":[{"value":"a","label":"It's \\"a\\""},{"value":"b","label":"b > a"}],"correct_values":["a"],"hint":"Look at the </Quiz> text","explanation":"Because."}]}/>`;

const SAMPLES = {
  fencedWholeAnswer: '```markdown\n# Title\n\nSome text.\n\n<Callout title="Tip">Use **bold** here</Callout>\n```',
  trickyJsonStrings: `## Quiz\n\n${QUIZ}\n\nAfter the quiz.`,
  multilineProps: `## Steps\n\n<LessonStepper\n  title="Make tea"\n  steps={[\n    {"label": "Boil", "text": "Heat water to 100 °C."},\n    {"label": "Steep", "text": "Wait 3–5 minutes."},\n  ]}\n/>\n\nDone.`,
  lenientJs: `<InputOutputSlider inputLabel='Rate' outputLabel="Growth" unit="%" stops={[{value: 1, label: 'Low', output: 'slow'}, {value: 5, label: 'Mid', output: 'steady',}, {value: 10, label: 'High', output: 'fast'},]} />`,
  inListAndQuote: `- First point with <KeyTerm term="entropy" definition="Disorder measure"/> inline\n- Second point\n\n> Quoted <KeyTerm term="energy" definition="Ability to do work"/> here`,
  unknownComponent: `Intro.\n\n<Diagram nodes={[1,2,3]}/>\n\n<Widget>child text</Widget>\n\nOutro text survives.`,
  htmlishTags: `Line one<br>line two with <b>bold</b> and <details><summary>More</summary>hidden</details>.`,
  comparisons: `If x < 3 and y > 2 then x<y is often true; also 5 <= 7 and a->b.`,
  codeFenceWithDil: "Here is code:\n\n```jsx\n<box padding={4}><Quiz questions={[]}/></box>\n```\n\nAfter code.",
  math: `Inline $a^2 + b^2 = c^2$ and display:\n\n$$\\frac{1}{\\lambda^4}$$\n\nDone.`,
  jsExpressionProps: `<box onClick={() => fetch('https://evil.example')} padding={globalThis.x}>Safe text</box>`,
  mixedAttrsExpression: `<box border radius="xl" gap={2} onClick={() => fetch('https://evil.example')} padding={4}>Still safe</box>`,
  nestedLayout: `<box border radius="xl" padding={4} gap={3}>\n  <row gap={2}>\n    <icon name="sun" size="xl"/>\n    <title size="lg">Sunny</title>\n  </row>\n  <BarChart unit="mm" bars={[{"label":"Mon","value":3},{"label":"Tue","value":7}]}/>\n</box>`,
};

for (const [name, src] of Object.entries(SAMPLES)) {
  test(`model output: ${name} compiles and runs`, () => {
    const out = compileWonder(src, { salt: name });
    assert.equal(typeof out.code, 'string');
    assert.doesNotMatch(out.code, /fetch\(|globalThis|evil\.example/, 'expressions must never become code');
    const env = runProgram(out);
    assert.deepEqual(env.errors, [], `runtime errors: ${JSON.stringify(env.errors)}`);
  });

  test(`model output: ${name} survives every streamed prefix`, () => {
    const cuts = new Set();
    for (let i = 0; i <= src.length; i += Math.max(1, Math.floor(src.length / 60))) cuts.add(i);
    cuts.add(src.length);
    for (const i of cuts) {
      const out = compileWonder(src.slice(0, i), { partial: true, salt: name });
      const env = runProgram(out);
      assert.deepEqual(env.errors, [], `prefix ${i}: ${JSON.stringify(env.errors)}`);
    }
  });
}

test('tricky JSON strings keep their content and the quiz renders', () => {
  const env = runProgram(compileWonder(SAMPLES.trickyJsonStrings));
  assert.equal(catalogNodes(env.mirror, 'Quiz').length, 1);
  const text = env.mirror.text(env.mirror.root);
  assert.match(text, /Which is larger, 3 > 2 or \{curly\}\?/);
  assert.match(text, /After the quiz\./);
});

test('multi-line props with trailing commas render the stepper', () => {
  const env = runProgram(compileWonder(SAMPLES.multilineProps));
  assert.equal(catalogNodes(env.mirror, 'LessonStepper').length, 1);
  assert.match(env.mirror.text(env.mirror.root), /Boil/);
});

test('unknown components do not swallow surrounding text', () => {
  const env = runProgram(compileWonder(SAMPLES.unknownComponent));
  assert.match(env.mirror.text(env.mirror.root), /Outro text survives\./);
});

test('comparison operators in prose stay as text', () => {
  const env = runProgram(compileWonder(SAMPLES.comparisons));
  assert.match(env.mirror.text(env.mirror.root), /x < 3 and y > 2/);
});

test('DIL inside a code fence is shown as code, not executed', () => {
  const out = compileWonder(SAMPLES.codeFenceWithDil);
  assert.ok(!out.requiredComponents.includes('Quiz'), 'Quiz inside a fence must not be required');
  const env = runProgram(out);
  assert.equal(catalogNodes(env.mirror, 'Quiz').length, 0);
  assert.match(env.mirror.text(env.mirror.root), /After code\./);
});

test('primitive tags keep JSON scalars and drop JS expressions', () => {
  const out = compileWonder(SAMPLES.mixedAttrsExpression);
  assert.match(out.code, /"border":true/);
  assert.match(out.code, /"radius":"xl"/);
  assert.match(out.code, /"gap":2/);
  assert.match(out.code, /"padding":4/);
  assert.doesNotMatch(out.code, /onClick/);
});
