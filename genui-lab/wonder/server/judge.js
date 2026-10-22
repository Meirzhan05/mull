// Phase 7: the eval harness's LLM judge and report building (evals/run.js drives it).
// The judge scores one finished lesson on a fixed rubric with structured output; the report
// helpers are pure, so they are tested under node:test.

import { buildStructuredParams, createStructured } from './claude.js';
import { citesAsText } from './critic.js';

export const RUBRIC = Object.freeze([
  ['accuracy', 'Every claim, number and worked example is correct; quiz answer keys are right.'],
  ['clarity', 'One idea per page, concrete examples and analogies, no padding; a newcomer could follow it.'],
  ['level_fit', 'Pitched at the stated level: beginners get plain words and KeyTerms, advanced learners get precision.'],
  ['interactivity', 'Visuals fit their ideas (process -> stepper/flowchart, quantities -> chart, ...) and teach rather than decorate.'],
  ['quiz_quality', 'The questions test understanding of different pages, distractors are plausible misconceptions, explanations teach.'],
]);
export const RUBRIC_KEYS = RUBRIC.map(([k]) => k);

export const JUDGE_SYSTEM_PROMPT = `
You grade lessons written by an AI tutor app, for an evaluation report that compares prompt and model changes. Score the lesson on each rubric dimension from 1 to 5:
5 = excellent, nothing to improve; 4 = good, small flaws; 3 = acceptable, clear weaknesses; 2 = poor; 1 = wrong or unusable.
Rubric:
${RUBRIC.map(([k, d]) => `- ${k}: ${d}`).join('\n')}
The lesson is markdown with inline UI tags whose props are JSON (for example <Quiz questions={[...]}/>); judge what the learner would see and do. Be calibrated and strict: reserve 5 for lessons you would not change. Give each score a one-sentence rationale, then a one-sentence overall comment.
`.trim();

export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'overall'],
  properties: {
    scores: {
      type: 'object',
      additionalProperties: false,
      required: RUBRIC_KEYS,
      properties: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, {
        type: 'object', additionalProperties: false, required: ['score', 'rationale'],
        properties: { score: { type: 'integer', enum: [1, 2, 3, 4, 5] }, rationale: { type: 'string' } },
      }])),
    },
    overall: { type: 'string' },
  },
};

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function normalizeJudgement(raw) {
  const scores = {};
  for (const k of RUBRIC_KEYS) {
    const s = Number(raw?.scores?.[k]?.score);
    scores[k] = { score: Number.isInteger(s) && s >= 1 && s <= 5 ? s : null, rationale: clip(raw?.scores?.[k]?.rationale, 300) };
  }
  const vals = RUBRIC_KEYS.map((k) => scores[k].score).filter((v) => v != null);
  return { scores, mean: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null, overall: clip(raw?.overall, 400) };
}

export async function judgeLesson(client, { markdown, topic, level, effort = 'medium' }) {
  const user = `Topic: ${clip(topic, 300)}\nLearner level: ${level || 'beginner'}\n\n<lesson>\n${citesAsText(markdown).slice(0, 60000)}\n</lesson>`;
  return normalizeJudgement(await createStructured(client, buildStructuredParams({ system: JUDGE_SYSTEM_PROMPT, schema: JUDGE_SCHEMA, user, effort })));
}

// ---------------------------------------------------------------- report

const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };

/** Aggregate per-run results: {runs, ok, failed, means:{lint, judge, <rubric keys>, seconds, issues, fixes}}. */
export function summarizeRuns(runs) {
  const ok = runs.filter((r) => !r.error);
  const means = {
    lint: mean(ok.map((r) => r.lint?.score)),
    judge: mean(ok.map((r) => r.judge?.mean)),
    seconds: mean(ok.map((r) => r.seconds)),
    issues: mean(ok.filter((r) => r.critic && !r.critic.skipped).map((r) => r.critic.issues.length)),
    fixes: mean(ok.filter((r) => r.critic && !r.critic.skipped).map((r) => r.critic.fixed.length)),
  };
  for (const k of RUBRIC_KEYS) means[k] = mean(ok.map((r) => r.judge?.scores?.[k]?.score));
  const failedChecks = {};
  for (const r of ok) for (const f of r.lint?.failed || []) failedChecks[f.id] = (failedChecks[f.id] || 0) + 1;
  return { runs: runs.length, ok: ok.length, failed: runs.length - ok.length, means, failedChecks };
}

const cell = (v, digits = 2) => (v == null ? '–' : typeof v === 'number' ? String(Math.round(v * 10 ** digits) / 10 ** digits) : String(v).replace(/\|/g, '\\|'));

/** Markdown report for one eval run. */
export function reportMarkdown(report) {
  const { meta, summary, runs } = report;
  const lines = [
    `# Wonder lesson eval · ${meta.startedAt}`,
    '',
    `Mode: **${meta.mode}** · model \`${meta.model}\` · ${summary.ok}/${summary.runs} lessons generated · web search ${meta.webSearch ? 'on' : 'off'} · critic ${meta.verify ? 'on' : 'off'} · judge ${meta.judge ? 'on' : 'off'}`,
    '',
    '## Means',
    '',
    '| Lint | Judge | ' + RUBRIC_KEYS.join(' | ') + ' | Critic issues | Quiz fixes | Seconds |',
    '|' + ' --- |'.repeat(RUBRIC_KEYS.length + 5),
    `| ${cell(summary.means.lint)} | ${cell(summary.means.judge)} | ${RUBRIC_KEYS.map((k) => cell(summary.means[k])).join(' | ')} | ${cell(summary.means.issues)} | ${cell(summary.means.fixes)} | ${cell(summary.means.seconds, 1)} |`,
  ];
  const fc = Object.entries(summary.failedChecks).sort((a, b) => b[1] - a[1]);
  if (fc.length) lines.push('', `Most failed format checks: ${fc.map(([id, n]) => `\`${id}\` ×${n}`).join(', ')}`);
  lines.push('', '## Lessons', '', '| Topic | Level | Lint | Judge | Critic | Fixes | Seconds | Title |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of runs) {
    if (r.error) { lines.push(`| ${cell(r.topic)} | ${r.level} | error: ${cell(r.error)} | | | | | |`); continue; }
    const critic = !r.critic || r.critic.skipped ? 'skipped' : `${r.critic.verdict} (${r.critic.issues.length})`;
    lines.push(`| ${cell(r.topic)} | ${r.level} | ${cell(r.lint?.score)} | ${cell(r.judge?.mean)} | ${critic} | ${r.critic?.fixed?.length ?? 0} | ${cell(r.seconds, 1)} | ${cell(r.title)} |`);
  }
  const notes = runs.filter((r) => !r.error && (r.judge?.overall || r.critic?.issues?.length || r.lint?.failed?.length));
  if (notes.length) {
    lines.push('', '## Notes');
    for (const r of notes) {
      lines.push('', `### ${r.title || r.topic}`);
      if (r.judge?.overall) lines.push('', `Judge: ${r.judge.overall}`);
      for (const f of r.lint?.failed || []) lines.push(`- Format \`${f.id}\`: ${f.detail}`);
      for (const i of r.critic?.issues || []) lines.push(`- Critic (${i.severity}, ${i.kind}, page ${i.page}): ${i.problem}`);
    }
  }
  return lines.join('\n') + '\n';
}
