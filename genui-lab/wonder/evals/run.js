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
//   --tag <name>       only topics with this tag (e.g. --tag media: the physical/spatial topics)
//   --out <dir>        report directory (default evals/reports)
//
// Learner memory is an in-memory empty store, so runs never read or write data/memory.json.
// Each lesson also reports its media: every <Diagram>/<Figure>, whether it validated, and for a
// Figure whether the server found an image (or the vision check dropped it), from the final record.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { loadUserEnv } from '../server/web.js'; // ~/.config/wonder/.env fallback, as for the Next app
import { MODEL } from '../server/claude.js';
import { judgeLesson, summarizeRuns, reportMarkdown } from '../server/judge.js';
import { lessonMedia } from '../server/critic.js';
import { figureRefs } from '../server/figures.js';
import { ConversationSourceParser, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { topics: path.join(here, 'topics.json'), limit: Infinity, concurrency: 2, demo: false, judge: true, verify: true, web: false, tag: null, out: path.join(here, 'reports') };
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
    else if (a === '--tag') o.tag = String(next() || '');
    else if (a === '--out') o.out = path.resolve(next());
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

/**
 * A lesson's Diagrams and Figures (critic.js lessonMedia) with each valid Figure joined to the
 * server's lookup result in the final `dil` (componentResults by resolution id): found (and the
 * image title), rejected by the vision check (and why), or neither (nothing found / timed out).
 */
export function lessonMediaReport(markdown, dil) {
  const media = lessonMedia(markdown);
  const refs = figureRefs(dil);
  const results = dil?.appData?.opGenui?.componentResults || {};
  const used = new Set();
  for (const f of media.figures) {
    if (f.status !== 'valid') continue;
    const ref = refs.find((r) => !used.has(r.rid) && (r.query || '') === f.query && (r.file || '') === (f.file || ''));
    if (!ref) { f.found = false; continue; }
    used.add(ref.rid);
    const r = results[ref.rid];
    const state = r?.status === 'resolved' ? r.state : null;
    f.found = state?.found === true;
    if (f.found) Object.assign(f, { image: state.title, ...(state.checked ? { checked: true } : {}) });
    else if (state?.rejected) f.rejected = state.rejected.problem || state.rejected.depicts || 'does not fit the caption';
    if (!state) f.pending = true;
  }
  return media;
}

/** POST one lesson request and read the NDJSON turn: {markdown, title, quality, failure, dil}. */
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
  return { markdown, title: /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || '', quality, failure, dil: turn.primary?.dil || null };
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
  const topics = JSON.parse(fs.readFileSync(opts.topics, 'utf8')).filter((t) => !opts.tag || t.tags?.includes(opts.tag)).slice(0, opts.limit);
  const server = createWonderServer({ memory: createMemoryStore({ file: null }), logger: { info() {}, warn() {}, error: console.error }, ...(opts.demo ? { mode: 'demo', demoDelayMs: 0 } : {}), ...serverOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mode = server.wonder.mode;
  const judging = opts.judge && mode === 'claude';
  const client = serverOpts.client || server.wonder.client;
  const startedAt = new Date().toISOString();
  log(`Eval: ${topics.length} topic(s) in ${mode} mode${mode === 'demo' ? ' (no API key found: lint and pipeline only)' : `, judge ${judging ? 'on' : 'off'}, critic ${opts.verify ? 'on' : 'off'}`}`);
  try {
    const runs = await pool(topics, opts.concurrency, async ({ topic, level = 'beginner' }, i) => {
      const t0 = Date.now();
      try {
        const g = await generateLesson(base, { topic, level, web: opts.web, verify: opts.verify });
        if (g.failure) throw new Error(g.failure.message || g.failure.code);
        const seconds = (Date.now() - t0) / 1000;
        const judge = judging ? await judgeLesson(client, { markdown: g.markdown, topic, level }).catch((e) => ({ error: e.message })) : null;
        const media = lessonMediaReport(g.markdown, g.dil);
        const mediaNote = [media.diagrams.length && `${media.diagrams.length} diagram`, media.figures.length && `${media.figures.length} figure (${media.figures.filter((f) => f.found).length} image)`].filter(Boolean).join(', ');
        log(`[${i + 1}/${topics.length}] ${topic}: lint ${g.quality?.lint?.score ?? '–'}${judge?.mean != null ? `, judge ${judge.mean}` : ''}${mediaNote ? `, ${mediaNote}` : ''} (${seconds.toFixed(1)}s)`);
        return { topic, level, title: g.title, seconds, chars: g.markdown.length, lint: g.quality?.lint || null, critic: g.quality?.critic || null, media, judge: judge?.error ? null : judge, ...(judge?.error ? { judgeError: judge.error } : {}) };
      } catch (e) {
        log(`[${i + 1}/${topics.length}] ${topic}: FAILED ${e.message}`);
        return { topic, level, error: e.message };
      }
    });
    return { meta: { startedAt, mode, model: MODEL, webSearch: opts.web, verify: opts.verify, judge: judging, topics: path.basename(opts.topics), ...(opts.tag ? { tag: opts.tag } : {}), figureCheck: server.wonder.figureCheck ?? null }, summary: summarizeRuns(runs), runs };
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
  loadUserEnv(); // same ~/.config/wonder/.env fallback as the app
  const opts = parseArgs(process.argv.slice(2));
  const report = await runEval(opts, { log: (line) => console.log(line) });
  const files = writeReport(report, opts.out);
  const m = report.summary.means;
  const md = report.summary.media;
  console.log(`\n${report.summary.ok}/${report.summary.runs} lessons · lint ${m.lint ?? '–'} · judge ${m.judge ?? '–'} · critic issues ${m.issues ?? '–'} · diagram in ${md.withDiagram}/${md.lessons} · figure in ${md.withFigure}/${md.lessons} (images ${md.figures.found}/${md.figures.valid})`);
  const rel = path.relative(process.cwd(), files.md);
  console.log(`Report: ${rel.startsWith('..') ? files.md : rel}`);
}
