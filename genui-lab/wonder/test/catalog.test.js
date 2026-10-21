import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWonder } from '../server/compile.js';
import { LEARNING_COMPONENT_NAMES as SERVER_NAMES } from '../server/catalog-schema.js';
import { LEARNING_COMPONENT_NAMES, LEARNING_PRELUDE } from '../public/learning-catalog.js';
import { demo, DEMO_FILES, runProgram, catalogNodes, click } from './helpers.js';

test('client catalog and server schema cover the same components', () => {
  assert.deepEqual([...LEARNING_COMPONENT_NAMES].sort(), [...SERVER_NAMES].sort());
  assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', LEARNING_PRELUDE));
});

for (const file of DEMO_FILES) {
  test(`demo ${file} renders every component through the sandbox runtime`, () => {
    const r = compileWonder(demo(file), { salt: file });
    const env = runProgram(r);
    assert.deepEqual(env.errors, []);
    for (const name of r.requiredComponents) {
      if (name === 'KeyTerm') continue; // inline pressable, tagged below
      assert.ok(catalogNodes(env.mirror, name).length > 0, `${name} rendered`);
    }
    assert.ok(catalogNodes(env.mirror, 'KeyTerm').length > 0, 'KeyTerm rendered');
    assert.equal(catalogNodes(env.mirror, 'Quiz').length, 1);
  });
}

test('LessonStepper steps forward and back', () => {
  const env = runProgram(compileWonder('<LessonStepper title="S" steps={[{"label":"One","text":"first"},{"label":"Two","text":"second"}]}/>'));
  assert.match(env.mirror.text(), /One.*first/);
  assert.match(env.mirror.text(), /1 \/ 2/);
  click(env, 'Next step');
  assert.match(env.mirror.text(), /Two.*second/);
  assert.match(env.mirror.text(), /Start over/);
  click(env, 'Back');
  assert.match(env.mirror.text(), /One/);
});

test('Quiz: answer, feedback, server action, hint, results with celebration', () => {
  const md = '<Quiz questions={[{"id":"q1","prompt":"2+2?","options":[{"value":"a","label":"Three"},{"value":"b","label":"Four"}],"correct_values":["b"],"hint":"Count","explanation":"Because math."},{"id":"q2","prompt":"Sky blue?","question_type":"true_false","correct_values":["true"]}]}/>';
  const r = compileWonder(md, { salt: 'quiz' });
  const env = runProgram(r);
  assert.match(env.mirror.text(), /1 of 2/);
  click(env, 'Hint');
  assert.match(env.mirror.text(), /Count/);
  click(env, 'Four');
  assert.match(env.mirror.text(), /Correct!/);
  assert.match(env.mirror.text(), /Because math/);
  const answer = env.actions.find((a) => a.type === 'quiz_answer');
  assert.equal(answer.handler, 'server');
  assert.equal(answer.componentName, 'Quiz');
  assert.ok(answer.nativeWidgetResolutionId, 'widget-scoped resolution id');
  assert.deepEqual(answer.payload.selected_values, ['b']);
  click(env, 'Next question');
  click(env, 'False');
  assert.match(env.mirror.text(), /Not quite/);
  assert.ok(env.mirror.text().includes('Explain this'));
  click(env, 'Explain this');
  const turn = env.actions.find((a) => a.type === 'issue_new_turn');
  assert.match(turn.payload.query, /Sky blue\?/);
  click(env, 'See results');
  assert.match(env.mirror.text(), /1 \/ 2/);
  const done = env.actions.filter((a) => a.type === 'quiz_complete');
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].payload.score, 1);
  assert.equal(env.mirror.findAll((n) => n.type === 'celebration').length, 1);
  click(env, 'Try again');
  assert.ok(env.actions.some((a) => a.type === 'quiz_restart'));
  assert.match(env.mirror.text(), /1 of 2/);
});

test('Quiz restores answers from server componentResults', () => {
  const md = '<Quiz questions={[{"id":"q1","prompt":"2+2?","options":["3","4"],"correct":"4"}]}/>';
  const r = compileWonder(md, { salt: 'restore' });
  const rid = r.constants[Object.keys(r.constants).find((k) => /^[0-9a-f-]{36}$/.test(String(r.constants[k])))];
  const appData = { opGenui: { componentResults: { [rid]: { status: 'resolved', state: { attempt: 0, answers: { q1: { selected_values: ['b'], is_correct: true } } } } } } };
  const env = runProgram({ ...r, appData });
  assert.match(env.mirror.text(), /1 \/ 1/, 'opens on the results view');
  assert.equal(env.actions.filter((a) => a.type === 'quiz_complete').length, 0, 'restored completion does not award XP again');
});

test('KeyTerm toggles its definition; Reveal/CompareToggle/Slider/Flashcards respond', () => {
  const md = [
    'A <KeyTerm term="token" definition="a piece of text"/> here.',
    '<Reveal items={[{"label":"Guess?","content":"Answer!"}]}/>',
    '<CompareToggle left={{"label":"Left side","points":["L1"]}} right={{"label":"Right side","points":["R1"]}}/>',
    '<InputOutputSlider inputLabel="Rate" outputLabel="Years" stops={[{"value":2,"label":"2%","output":"36 years"},{"value":6,"label":"6%","output":"12 years"},{"value":9,"label":"9%","output":"8 years"}]}/>',
    '<Flashcards cards={[{"front":"Front A","back":"Back A"},{"front":"Front B","back":"Back B"}]}/>',
  ].join('\n\n');
  const env = runProgram(compileWonder(md));
  assert.doesNotMatch(env.mirror.text(), /a piece of text/);
  click(env, 'token');
  assert.match(env.mirror.text(), /a piece of text/);
  click(env, 'Explain more');
  const more = env.actions.find((a) => a.type === 'explain_more');
  assert.equal(more.handler, 'server');
  assert.equal(more.componentName, 'KeyTerm');
  assert.match(more.payload.query, /token/);
  assert.doesNotMatch(env.mirror.text(), /Answer!/);
  click(env, 'Guess?');
  assert.match(env.mirror.text(), /Answer!/);
  assert.match(env.mirror.text(), /L1/);
  click(env, 'Right side');
  assert.match(env.mirror.text(), /R1/);
  assert.match(env.mirror.text(), /36 years/);
  click(env, '9%');
  assert.match(env.mirror.text(), /8 years/);
  click(env, 'Tap to flip');
  assert.match(env.mirror.text(), /Back A/);
  click(env, 'Save to review deck');
  assert.ok(env.actions.some((a) => a.type === 'save_flashcards' && a.payload.cards.length === 2));
});

test('mobile viewport changes layout (CompareToggle hides side-by-side, ConceptMap single column)', () => {
  const md = '<CompareToggle left={{"label":"A","points":["a"]}} right={{"label":"B","points":["b"]}}/>\n\n<ConceptMap centerConcept="C" nodes={[{"id":"n1","label":"X"},{"id":"n2","label":"Y"},{"id":"n3","label":"Z"}]} connections={[{"from":"center","to":"n1","relationship":"has"},{"from":"center","to":"n2","relationship":"has"}]}/>';
  const desktop = runProgram(compileWonder(md), { viewportWidth: 900 });
  const mobile = runProgram(compileWonder(md), { viewportWidth: 390 });
  assert.match(desktop.mirror.text(), /Side by side/);
  assert.doesNotMatch(mobile.mirror.text(), /Side by side/);
  const grid = (env) => env.mirror.findAll((n) => n.type === 'grid')[0].props.columns;
  assert.equal(grid(desktop), 2);
  assert.equal(grid(mobile), 1);
});

test('component state survives a streamed recompile (same component, new program)', () => {
  // (a lone top-level block compiles without a Fragment, so realistic streams start with prose)
  const base = '# Title\n\nIntro paragraph.\n\n<LessonStepper steps={[{"text":"one"},{"text":"two"}]}/>';
  const r1 = compileWonder(base, { salt: 'x' });
  const env = runProgram(r1);
  click(env, 'Next step');
  assert.match(env.mirror.text(), /two/);
  const r2 = compileWonder(`${base}\n\nMore text arrives.`, { salt: 'x' });
  env.rt.render({ source: r2.code, constants: r2.constants, appData: {} });
  assert.match(env.mirror.text(), /two/);
  assert.match(env.mirror.text(), /More text arrives/);
});

test('widget text renders inline markdown as primitives and keeps dollar amounts intact', () => {
  const env = runProgram(compileWonder('<LessonStepper steps={[{"text":"Interest: $1,000 × 10% = **$100**, then *more* and `code`"},{"text":"x"}]}/>'));
  const bold = env.mirror.findAll((n) => n.type === 'bold');
  assert.deepEqual(bold.map((n) => env.mirror.text(n)), ['$100']);
  assert.equal(env.mirror.findAll((n) => n.type === 'italic').length, 1);
  assert.equal(env.mirror.findAll((n) => n.type === 'code').length, 1);
  assert.match(env.mirror.text(), /Interest: \$1,000 × 10% = \$100, then more and code/);
});
