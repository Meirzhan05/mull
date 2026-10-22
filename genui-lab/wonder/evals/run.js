// Phase 7: lesson eval harness. `npm run eval -- [options]`
//
// Generates a lesson per topic through the real HTTP pipeline (an in-process Wonder server:
// prompts, compile, NDJSON, the lint and the critic), then scores each one with the LLM judge
// (server/judge.js) and writes evals/reports/<timestamp>.json and .md.
//
//   --topics <file>    topic list (default evals/topics.json): [{topic, level}]
//   --limit <n>        first n topics only
//   --concurrency <n>  lessons generated in parallel (default 2)
//   --demo             demo mode: no API calls, lint + pipeline only (no critic, no judge)
//   --no-judge         skip the judge          --no-verify   skip the critic
//   --web              let lessons use web search (off by default: faster, comparable runs)
//   --out <dir>        report directory (default evals/reports)
//
// Learner memory is an in-memory empty store, so runs never read or write data/memory.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { MODEL } from '../server/claude.js';
import { judgeLesson, summarizeRuns, reportMarkdown } from '../server/judge.js';
import { ConversationSourceParser, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { topics: path.join(here, 'topics.json'), limit: Infinity, concurrency: 2, demo: false, judge: true, verify: true, web: false, out: path.join(here, 'reports') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--topics') o.topics = path.resolve(next());
    else if (a === '--limit') o.limit = Math.max(1, Number(next()) || 1);
    else if (a === '--concurrency') o.concurrency = Math.max(1, Math.min(8, Number(next()) || 1));
    else if (a === '--demo') o.demo = true;
    else if (a === '--no-judge') o.judge = false;
    else if (a === '--no-verify') o.verify = false;
    else if (a === '--web') o.web = true;
    else if (a === '--out') o.out = path.resolve(next());
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

/** POST one lesson request and read the NDJSON turn: {markdown, title, quality, failure}. */
export async function generateLesson(base, { topic, level, web, verify }) {
  const res = await fetch(`${base}/api/lesson/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: CONTENT_TYPE },
    body: JSON.stringify({ topic, level, useWebSearch: web, verify, memoryEnabled: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const turn = new ConversationTurn();
  let quality = null;
  let failure = null;
  const parser = new ConversationSourceParser((rec) => {
    turn.apply(rec);
    if (rec.type === 'control' && rec.detail?.kind === 'quality-report') quality = rec.detail.report;
    if (rec.type === 'control' && rec.detail?.kind === 'failed') failure = rec.detail;
  });
  parser.push(await res.text());
  parser.finish();
  const markdown = turn.primary?.markdown || '';
  return { markdown, title: /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || '', quality, failure };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Run the eval. `serverOpts` lets tests inject a client / mode. Returns the report object. */
export async function runEval(opts, { serverOpts = {}, log = console.log } = {}) {
  const topics = JSON.parse(fs.readFileSync(opts.topics, 'utf8')).slice(0, opts.limit);
  const server = createWonderServer({ memory: createMemoryStore({ file: null }), logger: { info() {}, warn() {}, error: console.error }, ...(opts.demo ? { mode: 'demo', demoDelayMs: 0 } : {}), ...serverOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mode = server.wonder.mode;
  const judging = opts.judge && mode === 'claude';
  const client = serverOpts.client || server.wonder.client;
  const startedAt = new Date().toISOString();
  try {
    const runs = await pool(topics, opts.concurrency, async ({ topic, level = 'beginner' }, i) => {
      const t0 = Date.now();
      try {
        const g = await generateLesson(base, { topic, level, web: opts.web, verify: opts.verify });
        if (g.failure) throw new Error(g.failure.message || g.failure.code);
        const seconds = (Date.now() - t0) / 1000;
        const judge = judging ? await judgeLesson(client, { markdown: g.markdown, topic, level }).catch((e) => ({ error: e.message })) : null;
        log(`[${i + 1}/${topics.length}] ${topic}: lint ${g.quality?.lint?.score ?? '–'}${judge?.mean != null ? `, judge ${judge.mean}` : ''} (${seconds.toFixed(1)}s)`);
        return { topic, level, title: g.title, seconds, chars: g.markdown.length, lint: g.quality?.lint || null, critic: g.quality?.critic || null, judge: judge?.error ? null : judge, ...(judge?.error ? { judgeError: judge.error } : {}) };
      } catch (e) {
        log(`[${i + 1}/${topics.length}] ${topic}: FAILED ${e.message}`);
        return { topic, level, error: e.message };
      }
    });
    return { meta: { startedAt, mode, model: MODEL, webSearch: opts.web, verify: opts.verify, judge: judging, topics: path.basename(opts.topics) }, summary: summarizeRuns(runs), runs };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

export function writeReport(report, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.meta.startedAt.replace(/[:.]/g, '-');
  const json = path.join(dir, `${stamp}.json`);
  const md = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  fs.writeFileSync(md, reportMarkdown(report));
  return { json, md };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runEval(opts);
  const files = writeReport(report, opts.out);
  const m = report.summary.means;
  console.log(`\n${report.summary.ok}/${report.summary.runs} lessons · lint ${m.lint ?? '–'} · judge ${m.judge ?? '–'} · critic issues ${m.issues ?? '–'}`);
  const rel = path.relative(process.cwd(), files.md);
  console.log(`Report: ${rel.startsWith('..') ? files.md : rel}`);
}
