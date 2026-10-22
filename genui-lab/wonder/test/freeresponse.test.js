// Phase 8: free-response answers and the Socratic tutor. ExplainBack validation and fallback,
// the grader (Claude structured output, keyword fallback), the explain_grade and practice_grade
// widget actions, the ExplainBack widget in the sandbox (typing via the text-input primitive,
// grading, retry), explain practice items, mastery evidence, and "Guide me" tutor mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { compileWonder } from '../server/compile.js';
import { validateComponentProps, fallbackMarkdownFor } from '../server/catalog-schema.js';
import { validateExplainBack, gradeDeterministic, gradeWithClaude, normalizeGrade, graderUserMessage, gradeRating, createGrader, GRADER_SYSTEM_PROMPT } from '../server/grader.js';
import { createWidgetActionHandler } from '../server/widget-actions.js';
import { extractPracticeDeterministic, itemsFromStructured } from '../server/practice.js';
import { TUTOR_SYSTEM_PROMPT, LESSON_SYSTEM_PROMPT } from '../server/prompts.js';
import { SOCRATIC_TUTOR_MODE } from '../server/prompts-extra.js';
import { buildDemoTutorReply } from '../server/demo.js';
import { normalizePracticeItem, gradePracticeItem } from '../public/practice-core.js';
import { explainEvidence, recordEvidence, estimateConcept } from '../public/mastery-core.js';
import { fakeClient, demo, runProgram, catalogNodes, click } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const SKY = {
  prompt: 'Why is the sky blue?',
  concept: 'Rayleigh scattering',
  rubric: ['Says air molecules scatter short blue wavelengths more than red', 'Explains scattered blue light reaches your eyes from every direction'],
  sampleAnswer: 'Air scatters blue more, so blue comes from all over the sky.',
};
const GOOD = 'Tiny air molecules scatter the short blue wavelengths much more than the red ones, so the scattered blue light reaches your eyes from every direction of the sky.';
const POOR = 'Because the ocean reflects onto the clouds and paints them.';

test('ExplainBack props validate, are bounded, and fall back to a thinking prompt', () => {
  const ok = validateComponentProps('ExplainBack', { ...SKY, rubric: [...SKY.rubric, { criterion: 'Object form works' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.props.rubric.length, 3);
  assert.equal(validateExplainBack({ prompt: 'p' }).ok, false, 'needs a rubric');
  assert.equal(validateExplainBack({ rubric: ['a'] }).ok, false, 'needs a prompt');
  assert.equal(validateExplainBack({ prompt: 'p', rubric: ['1', '2', '3', '4', '5', '6'] }).ok, false);
  assert.equal(fallbackMarkdownFor('ExplainBack', { prompt: 'Why <x>?' }), '**Explain it back:** Why ‹x>?');
  const r = compileWonder('# T\n\n<ExplainBack prompt="Why?" rubric={["a"]}/>\n');
  assert.equal(r.components.find((c) => c.name === 'ExplainBack').status, 'valid');
});

test('keyword grader: a complete answer scores 3, an off-topic one 0; criteria line up with the rubric', () => {
  const g = gradeDeterministic({ ...SKY, answer: GOOD });
  assert.equal(g.score, 3);
  assert.deepEqual(g.criteria.map((c) => c.met), [true, true]);
  assert.equal(g.source, 'keywords');
  const p = gradeDeterministic({ ...SKY, answer: POOR });
  assert.equal(p.score, 0);
  assert.match(p.feedback, /Try to include: Says air molecules/);
  const n = normalizeGrade({ score: 7, criteria: [{ met: true, evidence: 'e'.repeat(300) }] }, SKY.rubric, 'claude');
  assert.equal(n.score, 2, 'an invalid score is derived from the criteria');
  assert.deepEqual(n.criteria.map((c) => [c.criterion, c.met, c.evidence.length]), [[SKY.rubric[0], true, 200], [SKY.rubric[1], false, 0]]);
  assert.deepEqual([0, 1, 2, 3].map(gradeRating), [1, 2, 3, 4]);
});

test('Claude grader: structured call with the answer fenced as data; failure falls back to keywords', async () => {
  const client = fakeClient({ structured: { score: 2, criteria: [{ criterion: 'x', met: true, evidence: 'scatter' }, { criterion: 'y', met: false, evidence: '' }], feedback: 'Good start.', misconception: '', followup: 'Why not violet?' } });
  const g = await gradeWithClaude(client, { ...SKY, answer: GOOD });
  assert.equal(g.score, 2);
  assert.equal(g.criteria[0].criterion, SKY.rubric[0], 'criteria text comes from the rubric, not the model');
  const p = client.calls.create[0];
  assert.equal(p.system[0].text, GRADER_SYSTEM_PROMPT);
  assert.equal(p.output_config.effort, 'low');
  assert.match(p.messages[0].content, /<learner_answer>\nTiny air molecules[\s\S]*<\/learner_answer>/);
  assert.match(graderUserMessage({ ...SKY, answer: 'a' }), /Model answer: Air scatters/);
  const broken = fakeClient({});
  broken.messages.create = async () => { throw new Error('down'); };
  const grade = createGrader({ getClient: () => broken, getMode: () => 'claude', logger: quiet });
  assert.equal((await grade({ ...SKY, answer: GOOD })).grade.source, 'keywords');
  assert.deepEqual(await grade({ ...SKY, answer: 'too short' }), { ok: false, error: 'Write a sentence or two first.' });
});

test('widget actions: explain_grade resolves the widget state; practice_grade grades explain items', async () => {
  const handle = createWidgetActionHandler();
  const r = await handle({ componentName: 'ExplainBack', action_type: 'explain_grade', resolutionId: 'rid-1', payload: { attempt: 1, answer: GOOD, item: SKY } });
  assert.equal(r.status, 200);
  const st = r.body.componentResults['rid-1'].state;
  assert.equal(st.attempt, 1);
  assert.equal(st.grade.score, 3);
  assert.equal(st.answer, GOOD);
  const short = await handle({ action_type: 'explain_grade', resolutionId: 'rid-1', payload: { answer: 'hm', item: SKY } });
  assert.match(short.body.componentResults['rid-1'].state.error, /sentence or two/);
  assert.equal((await handle({ action_type: 'explain_grade', resolutionId: 'rid-1', payload: { answer: GOOD, item: { prompt: 'p' } } })).status, 400);
  assert.equal((await handle({ action_type: 'explain_grade', payload: { answer: GOOD, item: SKY } })).status, 400, 'needs a resolution id');
  const item = normalizePracticeItem({ type: 'explain', ...SKY });
  const pg = await handle({ action_type: 'practice_grade', payload: { item, answer: POOR } });
  assert.deepEqual([pg.body.result.correct, pg.body.result.rating, pg.body.result.grade.score], [false, 1, 0]);
  const sync = handle({ action_type: 'quiz_restart', resolutionId: 'q', payload: {} });
  assert.equal(sync.status, 200, 'other actions stay synchronous');
});

test('explain practice items: normalized, graded from a server grade, extracted from lessons', () => {
  const item = normalizePracticeItem({ type: 'explain', prompt: SKY.prompt, rubric: ['', ...SKY.rubric], sample_answer: 'S', concept: 'Rayleigh scattering' });
  assert.deepEqual([item.type, item.rubric.length, item.sampleAnswer, item.concept], ['explain', 2, 'S', 'Rayleigh scattering']);
  assert.equal(normalizePracticeItem({ type: 'explain', prompt: 'p', rubric: [] }), null);
  assert.deepEqual(gradePracticeItem(item, { score: 2 }), { correct: true, rating: 3, expected: 'S' });
  assert.deepEqual(gradePracticeItem(item, { score: 0 }).rating, 1);
  const det = extractPracticeDeterministic(demo('sky-blue.md'));
  const ex = det.items.find((i) => i.type === 'explain');
  assert.equal(ex.concept, 'Rayleigh scattering');
  assert.equal(ex.rubric.length, 3);
  const st = itemsFromStructured({ items: [{ type: 'explain', concept: 'C', prompt: 'Why?', rubric: ['a', 'b'], sample_answer: 'S', choices: [], correct_index: 0, answer: '', statement: '', is_true: false, front: '', back: '', explanation: '' }] });
  assert.deepEqual([st[0].type, st[0].sampleAnswer, st[0].concept], ['explain', 'S', 'C']);
});

test('ExplainBack widget: type, check, show the grade, report once, retry', () => {
  const md = `<ExplainBack prompt="${SKY.prompt}" concept="${SKY.concept}" rubric={${JSON.stringify(SKY.rubric)}} sampleAnswer="${SKY.sampleAnswer}"/>`;
  const r = compileWonder(md, { salt: 'explain' });
  const env = runProgram(r);
  assert.deepEqual(env.errors, []);
  assert.equal(catalogNodes(env.mirror, 'ExplainBack').length, 1);
  const field = () => env.mirror.findAll((n) => n.type === 'text-input')[0];
  assert.ok(field(), 'renders the text-input primitive');
  assert.match(env.mirror.text(), /Write a sentence or two/);
  env.rt.invokeFunction(field().props.onChange.__fn, [GOOD]);
  assert.equal(field().props.value, GOOD);
  click(env, 'Check my answer');
  const act = env.actions.find((a) => a.type === 'explain_grade');
  assert.equal(act.handler, 'server');
  assert.equal(act.payload.answer, GOOD);
  assert.deepEqual(act.payload.item.rubric, SKY.rubric);
  assert.equal(field().props.disabled, true, 'locked while grading');
  const rid = act.nativeWidgetResolutionId;
  const grade = gradeDeterministic({ ...SKY, answer: GOOD });
  const appData = { opGenui: { componentResults: { [rid]: { status: 'resolved', state: { attempt: 0, answer: GOOD, grade: { ...grade, score: 2, feedback: 'Close. Add why not violet.' } } } } } };
  env.rt.render({ source: r.code, constants: r.constants, appData });
  assert.match(env.mirror.text(), /Nearly there/);
  assert.match(env.mirror.text(), /Close\. Add why not violet/);
  const reports = env.actions.filter((a) => a.type === 'explain_graded');
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].payload.score, reports[0].payload.concept, reports[0].payload.attempt], [2, 'Rayleigh scattering', 0]);
  click(env, 'Show a model answer');
  assert.match(env.mirror.text(), /Air scatters blue more/);
  env.rt.render({ source: r.code, constants: r.constants, appData });
  assert.equal(env.actions.filter((a) => a.type === 'explain_graded').length, 1, 'a re-render does not report again');
  click(env, 'Try again');
  assert.equal(field().props.value, GOOD, 'the draft is kept for the retry');
  assert.doesNotMatch(env.mirror.text(), /Nearly there/);
});

test('mastery: only the first attempt of an explanation is evidence, weighted 1.5', () => {
  assert.deepEqual(explainEvidence({ concept: 'C', score: 2, attempt: 0 }), [{ concept: 'C', score: 2 / 3, source: 'explain', topic: '' }]);
  assert.deepEqual(explainEvidence({ concept: 'C', score: 3, attempt: 1 }), []);
  assert.deepEqual(explainEvidence({ concept: '', score: 3 }), []);
  const m = recordEvidence({}, explainEvidence({ concept: 'C', score: 3, attempt: 0 }));
  assert.equal(estimateConcept(m.c).evidence, 1.5);
});

test('prompts teach ExplainBack; Guide me adds the Socratic block after the cache breakpoint', async () => {
  assert.match(LESSON_SYSTEM_PROMPT, /<ExplainBack prompt=/);
  assert.match(LESSON_SYSTEM_PROMPT, /exactly one <ExplainBack>/);
  assert.match(TUTOR_SYSTEM_PROMPT, /<ExplainBack>/);
  const client = fakeClient({ text: 'What do you think?' });
  const server = createWonderServer({ mode: 'claude', client, demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body) => fetch(`${base}/api/tutor/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.text());
    await post({ message: 'why?', lessonContext: { title: 'Sky', markdown: '# Sky' }, mode: 'socratic' });
    await post({ message: 'why?', lessonContext: { title: 'Sky', markdown: '# Sky' } });
    const [guided, direct] = client.calls.stream.map((c) => c.params);
    assert.equal(guided.system[0].text, TUTOR_SYSTEM_PROMPT);
    assert.deepEqual(guided.system[0], direct.system[0], 'same cached prefix in both modes');
    assert.ok(guided.system[1].text.endsWith(SOCRATIC_TUTOR_MODE));
    assert.doesNotMatch(direct.system[1].text, /Guide me/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('demo Guide me: a guiding question about a lesson term, the answer only when asked outright', () => {
  const lessonContext = { title: 'Sky', markdown: demo('sky-blue.md') };
  const q = buildDemoTutorReply({ lessonContext, message: 'Why is Rayleigh scattering stronger for blue?', mode: 'socratic' });
  assert.match(q, /Think about \*\*Rayleigh scattering\*\*/);
  assert.match(q, /<Followups items=\{\["Give me a hint"/);
  const tell = buildDemoTutorReply({ lessonContext, message: 'just tell me about Mie scattering', mode: 'socratic' });
  assert.match(tell, /\*\*Mie scattering\*\*: /);
  const direct = buildDemoTutorReply({ lessonContext, message: 'Why is Rayleigh scattering stronger for blue?' });
  assert.doesNotMatch(direct, /Before I answer/);
  const compiled = compileWonder(q, { salt: 's' });
  assert.deepEqual(compiled.followups, ['Give me a hint', "I think it's because…", 'Just tell me']);
});
