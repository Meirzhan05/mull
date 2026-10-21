import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWonder } from '../server/compile.js';
import { LEARNING_COMPONENT_NAMES as SERVER_NAMES } from '../server/catalog-schema.js';
import { LEARNING_COMPONENT_NAMES, LEARNING_PRELUDE } from '../public/learning-catalog.js';
import { EXTRA_SCHEMA_NAMES, EXTRAS_PRELUDE } from '../public/catalog-extras.js';
import { demo, DEMO_FILES, runProgram, catalogNodes, click } from './helpers.js';

test('client catalog and server schema cover the same components', () => {
  assert.deepEqual([...LEARNING_COMPONENT_NAMES, ...EXTRA_SCHEMA_NAMES].sort(), [...SERVER_NAMES].sort());
  assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', 'Cite', LEARNING_PRELUDE + EXTRAS_PRELUDE));
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

// ---------------------------------------------------------------- TeacherCard (server-resolved)

const teacherAppData = (entries) => ({ opGenui: { componentResults: Object.fromEntries(entries.map(([rid, state]) => [rid, { status: 'resolved', state }])) } });

test('TeacherCard: binds to componentResults by the server-assigned __resolutionId and renders each kind', () => {
  const md = [
    'Intro.',
    '<TeacherCard kind="memory" __resolutionId="tc-mem-00000001"/>',
    '<TeacherCard kind="plan" __resolutionId="tc-plan-0000001"/>',
    '<TeacherCard kind="approval" __resolutionId="tc-appr-0000001"/>',
    '<TeacherCard kind="approval" __resolutionId="tc-missing-00001"/>',
  ].join('\n\n');
  const r = compileWonder(md, { salt: 'tc' });
  assert.deepEqual(r.components.map((c) => [c.name, c.status, c.resolutionId]), [
    ['TeacherCard', 'valid', 'tc-mem-00000001'], ['TeacherCard', 'valid', 'tc-plan-0000001'], ['TeacherCard', 'valid', 'tc-appr-0000001'], ['TeacherCard', 'valid', 'tc-missing-00001'],
  ]);
  for (const id of ['tc-mem-00000001', 'tc-plan-0000001', 'tc-appr-0000001']) assert.ok(Object.values(r.constants).includes(id), `${id} hoisted as the resolution id`);
  const plan = { kind: 'plan', goal: 'Stats in a week', saved: false, days: [
    { day: 1, focus: 'Averages', items: [{ id: 'd1i1', kind: 'lesson', title: 'Mean and median', topic: 'mean', opened: true }] },
    { day: 2, focus: 'Spread', items: [{ id: 'd2i1', kind: 'review', title: 'Review cards', topic: '', opened: false }, { id: 'd2i2', kind: 'quiz', title: 'Quick check', topic: 'spread', opened: false }] },
    { day: 3, focus: 'Practice', items: [{ id: 'd3i1', kind: 'lesson', title: 'Variance', topic: 'variance', opened: false }] },
  ] };
  const appData = teacherAppData([
    ['tc-mem-00000001', { kind: 'memory', op: 'remember', status: 'saved', item: { id: 'mem-1', fact: 'Knows basic algebra.', kind: 'background' } }],
    ['tc-plan-0000001', plan],
    ['tc-appr-0000001', { kind: 'approval', status: 'pending', topic: 'Mean, median and mode', level: 'beginner', reason: 'Averages first.' }],
  ]);
  const env = runProgram({ ...r, appData });
  assert.deepEqual(env.errors, []);
  const cards = catalogNodes(env.mirror, 'TeacherCard');
  assert.equal(cards.length, 4);
  const text = env.mirror.text();
  assert.match(text, /Remembered: Knows basic algebra\.[\s\S]*Undo/);
  assert.match(text, /STUDY PLAN[\s\S]*3 days · 1\/4 done[\s\S]*Stats in a week[\s\S]*Averages[\s\S]*Mean and median[\s\S]*Save plan/);
  assert.match(text, /SUGGESTED LESSON[\s\S]*beginner[\s\S]*Mean, median and mode[\s\S]*Averages first\.[\s\S]*Start lesson[\s\S]*Not now/);
  assert.doesNotMatch(env.mirror.text(cards[3]), /\w/, 'unresolved card shows a skeleton, not text');

  // buttons dispatch server widget actions scoped to the card, carrying its state
  click(env, 'Start lesson');
  click(env, 'Not now');
  click(env, 'Quick check');
  click(env, 'Save plan');
  click(env, 'Undo', cards[0]);
  const acts = env.actions.map((a) => [a.type, a.handler, a.componentName, a.nativeWidgetResolutionId, a.payload.itemId]);
  assert.deepEqual(acts, [
    ['teacher_accept', 'server', 'TeacherCard', 'tc-appr-0000001', undefined],
    ['teacher_dismiss', 'server', 'TeacherCard', 'tc-appr-0000001', undefined],
    ['teacher_open_item', 'server', 'TeacherCard', 'tc-plan-0000001', 'd2i2'],
    ['teacher_accept', 'server', 'TeacherCard', 'tc-plan-0000001', undefined],
    ['teacher_undo', 'server', 'TeacherCard', 'tc-mem-00000001', undefined],
  ]);
  assert.equal(env.actions[0].payload.state.topic, 'Mean, median and mode', 'the card state travels with the action (restart-safe)');

  // new componentResults (the server's answer) re-render the same cards
  const next = teacherAppData([
    ['tc-mem-00000001', { kind: 'memory', op: 'remember', status: 'undone', item: { id: 'mem-1', fact: 'Knows basic algebra.', kind: 'background' } }],
    ['tc-plan-0000001', { ...plan, saved: true }],
    ['tc-appr-0000001', { kind: 'approval', status: 'accepted', topic: 'Mean, median and mode', level: 'beginner', reason: '' }],
  ]);
  env.rt.render({ source: r.code, constants: r.constants, appData: next });
  const t2 = env.mirror.text();
  assert.match(t2, /Not remembered: Knows basic algebra\.[\s\S]*Redo/);
  assert.match(t2, /Saved to your home screen[\s\S]*Unsave/);
  assert.match(t2, /Started[\s\S]*Open lesson/);
  assert.doesNotMatch(t2, /Not now/);
  assert.deepEqual(env.errors, []);
});

test('TeacherCard without a valid server id is dropped by the compiler; mobile layout renders without errors', () => {
  const bad = compileWonder('<TeacherCard kind="approval"/>\n\n<TeacherCard kind="weird" __resolutionId="tc-12345678"/>');
  assert.deepEqual(bad.components.map((c) => c.status), ['invalid', 'invalid']);
  assert.deepEqual(bad.requiredComponents, []);
  const r = compileWonder('Hi\n\n<TeacherCard kind="approval" __resolutionId="tc-appr-0000001"/>');
  const env = runProgram({ ...r, appData: teacherAppData([['tc-appr-0000001', { kind: 'approval', status: 'dismissed', topic: 'T', level: 'advanced', reason: '' }]]) }, { viewportWidth: 390 });
  assert.deepEqual(env.errors, []);
  assert.match(env.mirror.text(), /Skipped for now[\s\S]*Undo/);
});
