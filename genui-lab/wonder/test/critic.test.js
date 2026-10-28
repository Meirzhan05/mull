// Phase 7: lesson quality. The deterministic lint, the critic call (structured output, fixes
// applied to Quiz props only when they still validate), the quality-report control and the
// replace record in /api/lesson/stream, and the eval harness (judge,
// summary, markdown report, an end-to-end demo and fake-Claude run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { lintLesson, lessonParts, applyQuizFixes, normalizeCritique, criticUserMessage, citesAsText, critiqueLesson, qualityReport, CRITIC_SYSTEM_PROMPT } from '../server/critic.js';
import { normalizeJudgement, summarizeRuns, reportMarkdown, RUBRIC_KEYS, JUDGE_SYSTEM_PROMPT } from '../server/judge.js';
import { componentsOf } from '../server/practice.js';
import { parseArgs, runEval, writeReport } from '../evals/run.js';
import { ConversationSourceParser, ConversationTurn } from '../../chatgpt-dil/src/stream.js';
import { fakeClient, demo, DEMO_FILES } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };

const QUIZ = (key = 'b') => `<Quiz title="Check" questions={[{"id":"q1","prompt":"2 + 2?","question_type":"single_select","options":[{"value":"a","label":"3"},{"value":"b","label":"4"}],"correct_values":["${key}"],"hint":"Count.","explanation":"Two and two make four.","concept":"Addition"}]}/>`;

test('lint: the demo lessons follow the format; a broken lesson fails the right checks', () => {
  for (const f of DEMO_FILES) {
    const r = lintLesson(demo(f));
    assert.ok(r.score >= 0.9, `${f}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
    assert.equal(r.stats.questions, 3);
  }
  const bad = lintLesson('# T\n\nShort hook.\n\n## One\n\nText only.\n\n## Check your understanding\n\n' + QUIZ());
  const failed = bad.checks.filter((c) => !c.ok).map((c) => c.id);
  for (const id of ['hook', 'pages', 'visual_per_page', 'quiz_questions', 'key_terms', 'worked_example']) assert.ok(failed.includes(id), id);
  assert.ok(!failed.includes('title') && !failed.includes('check_page') && !failed.includes('quiz_concepts'));
  assert.ok(bad.score < 0.6);
  assert.deepEqual(lessonParts('# A\n\nhook\n\n## P1\nx\n## P2\ny').pages.map((p) => p.heading), ['P1', 'P2']);
});

test('applyQuizFixes: rewrites only the named question, keeps it valid, rejects impossible keys', () => {
  const md = `# T\n\nIntro.\n\n## Check your understanding\n\n${QUIZ('a')}\n\nBye.`;
  const r = applyQuizFixes(md, [{ question_id: 'q1', correct_values: ['b'], explanation: 'It is four.' }]);
  assert.deepEqual(r.applied, [{ question_id: 'q1', from: ['a'], to: ['b'] }]);
  const q = componentsOf(r.markdown, 'Quiz')[0].questions[0];
  assert.deepEqual(q.correct_values, ['b']);
  assert.equal(q.explanation, 'It is four.');
  assert.equal(q.concept, 'Addition', 'other fields survive');
  assert.ok(r.markdown.startsWith('# T\n\nIntro.') && r.markdown.endsWith('\n\nBye.'));
  assert.match(r.markdown, /<Quiz title="Check" questions=\{/);
  const bad = applyQuizFixes(md, [{ question_id: 'q1', correct_values: ['z'], explanation: '' }, { question_id: 'q9', correct_values: ['a'], explanation: '' }]);
  assert.equal(bad.markdown, md);
  assert.deepEqual(bad.rejected.map((x) => x.question_id), ['q1', 'q9']);
  assert.equal(applyQuizFixes(md, []).markdown, md);
});

test('critic: response is bounded and cleaned; the user message carries level, lesson and cited text', async () => {
  const n = normalizeCritique({ verdict: 'weird', issues: [{ severity: 'major', kind: 'math', page: 2, problem: 'x'.repeat(900), suggestion: 's' }, { problem: '' }], quizFixes: [{ question_id: 'q1', correct_values: [] }] });
  assert.equal(n.verdict, 'pass');
  assert.equal(n.issues.length, 1);
  assert.equal(n.issues[0].problem.length, 400);
  assert.deepEqual(n.quizFixes, []);
  assert.equal(citesAsText('Blue light scatters.<Cite refs={["turn0search1","turn0search2"]}/>\n\n<Sources/>\n'), 'Blue light scatters. [turn0search1, turn0search2]\n');
  const u = criticUserMessage({ markdown: '# L', topic: 'sky', level: 'advanced', sources: [{ ref: 'turn0search1', title: 'NASA', url: 'https://nasa.gov', snippet: 'Rayleigh' }] });
  assert.match(u, /Learner level: advanced[\s\S]*<lesson>\n# L\n<\/lesson>[\s\S]*turn0search1: NASA \(https:\/\/nasa.gov\)\n {2}"Rayleigh"/);
  const client = fakeClient({ structured: { verdict: 'minor_issues', summary: 's', issues: [], quizFixes: [] } });
  const c = await critiqueLesson(client, { markdown: '# L', topic: 't', level: 'beginner' });
  assert.equal(c.verdict, 'minor_issues');
  const p = client.calls.create[0];
  assert.equal(p.system[0].text, CRITIC_SYSTEM_PROMPT);
  assert.equal(p.output_config.format.type, 'json_schema');
  const slow = { messages: { create: () => new Promise(() => {}) } };
  await assert.rejects(critiqueLesson(slow, { markdown: '# L', timeoutMs: 20 }), /timed out/);
});

async function withServer(opts, fn) {
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null }), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
async function lessonTurn(base, body) {
  const res = await fetch(`${base}/api/lesson/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const turn = new ConversationTurn();
  const records = [];
  const parser = new ConversationSourceParser((rec) => { records.push(rec); turn.apply(rec); });
  parser.push(await res.text());
  parser.finish();
  return { records, turn, report: records.find((r) => r.type === 'control' && r.detail?.kind === 'quality-report')?.detail.report };
}

test('lesson stream: the critic fixes a wrong answer key with one replace record, then reports', async () => {
  const lesson = `${demo('sky-blue.md').replace(/<Quiz[\s\S]*?\/>/, QUIZ('a'))}`;
  const critique = { verdict: 'major_issues', summary: 'Wrong key.', issues: [{ severity: 'major', kind: 'quiz_key', page: 5, problem: 'q1 key is 3', suggestion: 'use 4' }], quizFixes: [{ question_id: 'q1', correct_values: ['b'], explanation: 'Two and two make four.' }] };
  const client = fakeClient({ text: lesson, structured: critique });
  await withServer({ mode: 'claude', client }, async (base) => {
    const { records, turn, report } = await lessonTurn(base, { topic: 'sky', useWebSearch: false });
    assert.equal(client.calls.create.length, 1, 'one critic call');
    const replaces = records.filter((r) => r.type === 'content' && r.mode === 'replace' && r.markdown);
    assert.equal(replaces.length, 1);
    assert.deepEqual(componentsOf(turn.primary.markdown, 'Quiz')[0].questions[0].correct_values, ['b']);
    assert.equal(report.critic.verdict, 'major_issues');
    assert.deepEqual(report.critic.fixed, [{ question_id: 'q1', from: ['a'], to: ['b'] }]);
    const order = records.map((r) => r.detail?.kind || r.type);
    assert.ok(order.indexOf('quality-report') < order.indexOf('message-stream-complete'));
  });
});

test('lesson stream: demo mode lints only; verify:false skips the check; a failing critic still completes', async () => {
  await withServer({ mode: 'demo' }, async (base) => {
    const { report } = await lessonTurn(base, { topic: 'Why the sky is blue' });
    assert.equal(report.critic.skipped, true);
    assert.equal(report.lint.total, 12);
    const off = await lessonTurn(base, { topic: 'Why the sky is blue', verify: false });
    assert.equal(off.report, undefined);
    assert.equal(off.turn.primary.status, 'complete');
  });
  const failing = fakeClient({ text: demo('sky-blue.md') });
  failing.messages.create = async () => { throw new Error('boom'); };
  await withServer({ mode: 'claude', client: failing }, async (base) => {
    const { report, turn } = await lessonTurn(base, { topic: 'sky', useWebSearch: false });
    assert.equal(turn.primary.status, 'complete');
    assert.equal(report.critic.skipped, true);
    assert.equal(report.critic.reason, 'internal');
  });
});

test('judge: scores are bounded, the mean skips missing ones; runs summarize into a markdown report', () => {
  const j = normalizeJudgement({ scores: { accuracy: { score: 5, rationale: 'ok' }, clarity: { score: 4 }, level_fit: { score: 9 }, interactivity: { score: 3 }, quiz_quality: { score: 4 } }, overall: 'Good.' });
  assert.equal(j.scores.level_fit.score, null);
  assert.equal(j.mean, 4);
  assert.match(JUDGE_SYSTEM_PROMPT, /quiz_quality/);
  const runs = [
    { topic: 'A', level: 'beginner', title: 'A t', seconds: 10, lint: { score: 1, failed: [] }, critic: { verdict: 'pass', issues: [], fixed: [] }, judge: j },
    { topic: 'B|x', level: 'advanced', title: 'B', seconds: 20, lint: { score: 0.8, failed: [{ id: 'pages', detail: '5 pages' }] }, critic: { skipped: true }, judge: null },
    { topic: 'C', level: 'beginner', error: 'HTTP 500' },
  ];
  const s = summarizeRuns(runs);
  assert.equal(s.ok, 2);
  assert.equal(s.means.lint, 0.9);
  assert.equal(s.means.judge, 4);
  assert.equal(s.means.issues, 0);
  assert.deepEqual(s.failedChecks, { pages: 1 });
  for (const k of RUBRIC_KEYS) assert.ok(k in s.means);
  const md = reportMarkdown({ meta: { startedAt: 'now', mode: 'claude', model: 'm', webSearch: false, verify: true, judge: true }, summary: s, runs });
  assert.match(md, /\| 0\.9 \| 4 \|/);
  assert.match(md, /B\\\|x/);
  assert.match(md, /error: HTTP 500/);
  assert.match(md, /`pages` ×1/);
});

test('eval harness: args, a demo run end to end, and a fake-Claude run with critic + judge', async () => {
  assert.deepEqual((({ limit, demo: d, judge, web }) => ({ limit, d, judge, web }))(parseArgs(['--limit', '2', '--demo', '--no-judge', '--web'])), { limit: 2, d: true, judge: false, web: true });
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonder-eval-'));
  const topics = path.join(dir, 'topics.json');
  fs.writeFileSync(topics, JSON.stringify([{ topic: 'Why the sky is blue' }, { topic: 'Compound interest', level: 'intermediate' }]));
  const demoReport = await runEval({ ...parseArgs(['--demo']), topics }, { log() {} });
  assert.equal(demoReport.meta.mode, 'demo');
  assert.equal(demoReport.summary.ok, 2);
  assert.equal(demoReport.meta.judge, false);
  assert.ok(demoReport.runs.every((r) => r.lint && r.critic.skipped));
  const files = writeReport(demoReport, path.join(dir, 'out'));
  assert.match(fs.readFileSync(files.md, 'utf8'), /# Wonder lesson eval/);

  const structured = { verdict: 'pass', summary: 'fine', issues: [], quizFixes: [], scores: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, { score: 4, rationale: 'r' }])), overall: 'Solid.' };
  const client = fakeClient({ text: demo('transformers.md'), structured });
  const r = await runEval({ ...parseArgs([]), topics, limit: 1 }, { serverOpts: { mode: 'claude', client, demoDelayMs: 0 }, log() {} });
  assert.equal(r.meta.judge, true);
  assert.equal(r.runs[0].judge.mean, 4);
  assert.equal(r.runs[0].critic.verdict, 'pass');
  assert.equal(client.calls.create.length, 2, 'one critic call + one judge call');
  assert.equal(client.calls.stream[0].params.tools, undefined, 'web search off by default in evals');
});
