// Phase 6: the adaptive learner model. The estimator (Beta posterior with time decay), evidence
// from quizzes and reviews, the request summary and its server-side sanitizing, prompt
// injection after the cache breakpoint (lesson, tutor, Teacher), get_progress, concept tags on
// quiz and practice items, the multi-tab merge, and the "Strengthen" up-next item.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { LESSON_SYSTEM_PROMPT, TEACHER_SYSTEM_PROMPT } from '../server/prompts.js';
import { sanitizeMastery, masteryPromptBlock, masteryContext } from '../server/learner-model.js';
import { createTeacherToolkit, validateToolInput } from '../server/teacher.js';
import { validateComponentProps } from '../server/catalog-schema.js';
import { extractPracticeDeterministic, itemsFromStructured } from '../server/practice.js';
import {
  conceptKey, cleanConcept, recordEvidence, estimateConcept, masteryList, masterySummary, weakestConcepts,
  quizEvidence, ratingScore, requestMastery, forgetConcept, HALF_LIFE_DAYS, MAX_EVENTS, MAX_CONCEPTS,
} from '../public/mastery-core.js';
import { normalizePracticeItem } from '../public/practice-core.js';
import { upNext } from '../public/progress-core.js';
import { mergeStates, emptyState } from '../public/store.js';
import { fakeClient, sampleLesson } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const NOW = new Date('2026-10-21T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

test('concept keys: case, punctuation and leading articles collapse; labels stay readable', () => {
  assert.equal(conceptKey('The Mean'), 'mean');
  assert.equal(conceptKey('  standard   deviation. '), 'standard deviation');
  assert.equal(conceptKey('Bayes’ theorem'), conceptKey("Bayes' theorem"));
  assert.equal(cleanConcept('x'.repeat(80)).length, 60);
  assert.equal(conceptKey(''), '');
});

test('estimate: prior 50%, right answers raise it, wrong answers lower it, statuses follow evidence', () => {
  assert.equal(estimateConcept({ events: [] }, NOW).mastery, 0.5);
  const right3 = recordEvidence({}, [1, 2, 3].map(() => ({ concept: 'Median', correct: true })), NOW);
  const e = estimateConcept(right3.median, NOW);
  assert.equal(e.mastery, 0.8); // Beta(1+3, 1)
  assert.equal(e.status, 'mastered');
  const wrong2 = recordEvidence({}, [{ concept: 'Variance', correct: false }, { concept: 'Variance', correct: false }], NOW);
  assert.equal(estimateConcept(wrong2.variance, NOW).status, 'shaky');
  const one = recordEvidence({}, [{ concept: 'Mode', correct: true }], NOW);
  assert.equal(estimateConcept(one.mode, NOW).status, 'learning', 'one answer is not enough to call it mastered');
});

test('estimate: evidence decays with a 21-day half-life, so old mastery fades', () => {
  const fresh = recordEvidence({}, [1, 2, 3, 4].map(() => ({ concept: 'Entropy', correct: true, at: NOW })), NOW);
  const old = recordEvidence({}, [1, 2, 3, 4].map(() => ({ concept: 'Entropy', correct: true, at: daysAgo(HALF_LIFE_DAYS * 3) })), NOW);
  const f = estimateConcept(fresh.entropy, NOW);
  const o = estimateConcept(old.entropy, NOW);
  assert.equal(f.status, 'mastered');
  assert.ok(o.mastery < f.mastery);
  assert.ok(Math.abs(o.evidence - 4 / 8) < 0.01, 'three half-lives leave an eighth of the weight');
  assert.equal(o.status, 'fading');
});

test('evidence: scores, sources and weights; bad events are skipped; caps hold', () => {
  let m = recordEvidence({}, [
    { concept: 'Attention', score: 0.5, source: 'explain' },
    { concept: '', correct: true },
    { concept: 'Attention' }, // no score
    { concept: 'Attention', correct: true, source: 'bogus' },
  ], NOW);
  assert.equal(m.attention.events.length, 2);
  assert.deepEqual(m.attention.events.map((e) => [e.source, e.weight, e.score]), [['explain', 1.5, 0.5], ['quiz', 1, 1]]);
  for (let i = 0; i < MAX_EVENTS + 10; i++) m = recordEvidence(m, [{ concept: 'Attention', correct: i % 2 === 0 }], NOW);
  assert.equal(m.attention.events.length, MAX_EVENTS);
  const many = recordEvidence({}, Array.from({ length: MAX_CONCEPTS + 5 }, (_, i) => ({ concept: `c${i}`, correct: true, at: daysAgo(MAX_CONCEPTS + 5 - i) })), NOW);
  assert.equal(Object.keys(many).length, MAX_CONCEPTS);
  assert.ok(!many.c0 && many[`c${MAX_CONCEPTS + 4}`], 'least recently seen concepts are dropped first');
  assert.deepEqual(Object.keys(forgetConcept(m, 'attention')), []);
});

test('quiz and review evidence: only tagged results count; FSRS ratings map to scores', () => {
  const ev = quizEvidence([{ prompt: 'a', correct: true, concept: 'Median' }, { prompt: 'b', correct: false }, { prompt: 'c', correct: false, concept: 'Mode' }], { topic: 'Averages' });
  assert.deepEqual(ev.map((e) => [e.concept, e.correct, e.source, e.topic]), [['Median', true, 'quiz', 'Averages'], ['Mode', false, 'quiz', 'Averages']]);
  assert.deepEqual([1, 2, 3, 4].map(ratingScore), [0, 0.6, 1, 1]);
});

test('summary: weakest first per status, mastered strongest first; off or empty -> undefined', () => {
  let m = {};
  m = recordEvidence(m, [{ concept: 'A', correct: false }, { concept: 'A', correct: false }, { concept: 'A', correct: false }], NOW);
  m = recordEvidence(m, [{ concept: 'B', correct: false }, { concept: 'B', correct: false }], NOW);
  m = recordEvidence(m, [1, 2, 3].map(() => ({ concept: 'C', correct: true })), NOW);
  m = recordEvidence(m, [1, 2, 3, 4, 5].map(() => ({ concept: 'D', correct: true })), NOW);
  const s = masterySummary(m, NOW);
  assert.deepEqual(s.shaky.map((c) => c.concept), ['A', 'B']);
  assert.deepEqual(s.mastered.map((c) => c.concept), ['D', 'C']);
  assert.equal(s.total, 4);
  assert.deepEqual(weakestConcepts(m, NOW, 1), ['A']);
  assert.deepEqual(masteryList(m, NOW).map((c) => c.label), ['A', 'B', 'C', 'D']);
  assert.equal(requestMastery({ mastery: m, settings: { memoryEnabled: false } }, NOW), undefined);
  assert.equal(requestMastery({ mastery: {} }, NOW), undefined);
  assert.equal(requestMastery({ mastery: m }, NOW).shaky.length, 2);
});

test('server sanitizes the untrusted summary and builds the prompt block', () => {
  assert.equal(sanitizeMastery(null), null);
  assert.equal(sanitizeMastery({ shaky: [{ concept: '', mastery: 0.2 }] }), null);
  const s = sanitizeMastery({ shaky: [{ concept: 'Var\niance', mastery: 7 }, { concept: 'x', mastery: 'nope' }], mastered: Array.from({ length: 20 }, (_, i) => ({ concept: `m${i}`, mastery: 0.9 })), extra: [1] });
  assert.deepEqual(s.shaky, [{ concept: 'Var iance', mastery: 1 }]);
  assert.equal(s.mastered.length, 8);
  assert.ok(!('extra' in s));
  const block = masteryPromptBlock({ shaky: [{ concept: 'Variance', mastery: 0.31 }], mastered: [{ concept: 'Mean', mastery: 0.9 }] });
  assert.match(block, /Shaky[^\n]*Variance \(31%\)/);
  assert.match(block, /Mastered: Mean \(90%\)/);
  assert.doesNotMatch(block, /Fading/);
  assert.match(masteryContext({ shaky: [{ concept: 'V', mastery: 0.3 }] }, 'lesson'), /recap/);
  assert.equal(masteryContext(undefined, 'lesson'), '');
});

async function withServer(opts, fn) {
  const server = createWonderServer({ client: null, logger: quiet, memory: createMemoryStore({ file: null }), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('mastery goes into lesson, tutor and Teacher prompts after the cache breakpoint; memoryEnabled:false omits it', async () => {
  const mastery = { shaky: [{ concept: 'Variance', mastery: 0.3 }], learning: [], fading: [], mastered: [{ concept: 'Mean', mastery: 0.92 }] };
  const client = fakeClient({ text: '# T\n\nBody.' });
  await withServer({ client }, async (base) => {
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
    await post('/api/lesson/stream', { topic: 'standard deviation', mastery, useWebSearch: false });
    await post('/api/lesson/stream', { topic: 'standard deviation', mastery, memoryEnabled: false, useWebSearch: false });
    await post('/api/tutor/stream', { message: 'why?', lessonContext: { title: 'SD', markdown: '# SD' }, mastery });
    await post('/api/teacher/stream', { message: 'what next?', mastery });
    const [on, off, tutor, teacher] = client.calls.stream.map((c) => c.params);
    assert.equal(on.system[0].text, LESSON_SYSTEM_PROMPT);
    assert.match(on.system[1].text, /What this learner knows[\s\S]*Variance \(30%\)[\s\S]*Mastered: Mean \(92%\)[\s\S]*recap/);
    assert.ok(!on.system[1].cache_control);
    assert.equal(off.system.length, 1);
    assert.match(tutor.system[1].text, /<lesson title="SD">[\s\S]*Variance \(30%\)/);
    assert.equal(teacher.system[0].text, TEACHER_SYSTEM_PROMPT);
    assert.match(teacher.system[1].text, /Variance \(30%\)[\s\S]*quiz_me/);
  });
});

test('Teacher get_progress reports mastery (or why it is missing); quiz_me requires a concept tag', async () => {
  const memory = createMemoryStore({ file: null });
  const exec = createTeacherToolkit({ memory, progress: {}, mastery: { shaky: [{ concept: 'Variance', mastery: 0.3 }] } });
  const out = JSON.parse((await exec('get_progress', {})).content);
  assert.deepEqual(out.mastery.shaky, [{ concept: 'Variance', mastery: 0.3 }]);
  const none = JSON.parse((await createTeacherToolkit({ memory, progress: {} })('get_progress', {})).content);
  assert.equal(none.mastery, 'no graded answers yet');
  const off = JSON.parse((await createTeacherToolkit({ memory, progress: {}, mastery: { shaky: [{ concept: 'V', mastery: 0.3 }] }, memoryEnabled: false })('get_progress', {})).content);
  assert.equal(off.mastery, 'turned off by the learner');
  const q = { id: 'q1', prompt: 'p', question_type: 'true_false', options: [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }], correct_values: ['true'], hint: 'h', explanation: 'e' };
  assert.match(validateToolInput('quiz_me', { topic: 't', questions: [q] }).error, /concept is required/);
  const ok = validateToolInput('quiz_me', { topic: 't', questions: [{ ...q, concept: 'Variance' }] });
  assert.equal(ok.value.questions[0].concept, 'Variance');
});

test('concept tags survive Quiz validation and practice extraction (structured and from lesson components)', () => {
  const r = validateComponentProps('Quiz', { questions: [{ prompt: 'p', question_type: 'true_false', correct_values: ['true'], concept: '  Rayleigh   scattering ' }] });
  assert.equal(r.props.questions[0].concept, 'Rayleigh scattering');
  const det = extractPracticeDeterministic(sampleLesson('sky-blue.md'));
  assert.ok(det.items.every((i) => i.concept), 'every deterministic item carries a concept');
  assert.ok(det.items.some((i) => i.concept === 'Mie scattering'));
  const items = itemsFromStructured({ items: [{ type: 'flashcard', concept: 'Median', front: 'f', back: 'b', prompt: '', choices: [], correct_index: 0, answer: '', statement: '', is_true: false, explanation: '' }] });
  assert.equal(items[0].concept, 'Median');
  assert.equal(normalizePracticeItem({ type: 'flashcard', front: 'f', back: 'b' }).id, normalizePracticeItem({ type: 'flashcard', front: 'f', back: 'b', concept: 'X' }).id, 'the tag is not part of the id');
});

test('store: mastery merges per concept across tabs; Up next offers Strengthen for shaky concepts', () => {
  const base = { ...emptyState(), mastery: {} };
  const ours = { ...base, mastery: recordEvidence({}, [{ concept: 'A', correct: false }], NOW) };
  const theirs = { ...base, mastery: recordEvidence({}, [{ concept: 'B', correct: true }], NOW) };
  assert.deepEqual(Object.keys(mergeStates(base, ours, theirs).mastery).sort(), ['a', 'b']);
  const data = { ...emptyState(), mastery: recordEvidence({}, [{ concept: 'Variance', correct: false }, { concept: 'Variance', correct: false }], NOW) };
  const next = upNext(data, NOW);
  assert.deepEqual(next.find((n) => n.kind === 'strengthen'), { kind: 'strengthen', concepts: ['Variance'] });
  assert.ok(!upNext({ ...data, settings: { memoryEnabled: false } }, NOW).some((n) => n.kind === 'strengthen'));
});
