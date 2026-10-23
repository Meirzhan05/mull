// Wonder's API, as a transport-agnostic core (createWonderCore) with two front ends:
// Next.js route handlers (server/web.js, app/api/[...route]/route.js) and a small node:http
// server (createWonderServer) that the test suite drives.
//
//   GET  /api/status            -> {mode:"claude"|"demo", model}
//   POST /api/lesson/stream     -> conversation-source NDJSON (lesson in markdown + DIL); continueFrom resumes/revises
//   POST /api/tutor/stream      -> conversation-source NDJSON (tutor reply + followupPrompts)
//   POST /api/lesson/steer      -> JSON {ok, status: accepted|rejected} (Phase 4 mid-turn steering)
//   POST /api/course/plan       -> JSON course outline
//   POST /api/widget_action     -> JSON (componentResults / issueTurn / grading result)
//   POST /api/practice/extract  -> JSON knowledge cards + practice items
//   POST /api/teacher/stream    -> conversation-source NDJSON (Teacher turn: tool loop, cards in componentResults)
//   GET/POST/DELETE /api/memory -> learner memory items
//   POST /api/memory/extract    -> 0-3 new memory facts from a finished lesson
//   GET  /                      -> public/ ; /chatgpt-dil/src/* and /wondering-genui/src/* (read-only modules)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WONDER_ROOT, LAB_ROOT } from './paths.js';
import { CONTENT_TYPE, createTurnWriter } from './ndjson.js';
import {
  MODEL, detectMode, createClaudeClient, buildStreamParams, buildStructuredParams, streamText, createStructured,
  isCredentialError, friendlyError, REFUSAL_MESSAGE,
} from './claude.js';
import { createMaterialStore, DEFAULT_MATERIALS_DIR, MATERIAL_BODY_LIMIT, documentBlock, materialCitation, demoMaterialLesson, demoMaterialCourse } from './materials.js'; // Phase 10
import { TEACHER_OPENER } from '../public/teacher-core.js'; // Phase 10
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT, TEACHER_SYSTEM_PROMPT, COURSE_SYSTEM_PROMPT, COURSE_PLAN_SCHEMA, lessonUserMessage, tutorLessonContext, joinContext, insightsContext } from './prompts.js';
import { pickDemoLesson, streamDemoText, buildDemoTutorReply, demoCoursePlan } from './demo.js';
import { extractPracticeDeterministic, extractPracticeWithClaude } from './practice.js';
import { createWidgetActionHandler } from './widget-actions.js';
import { createMemoryStore, DEFAULT_MEMORY_FILE } from './memory.js';
import { normalizeExtractInput, extractMemoryDeterministic, extractMemoryWithClaude, filterNewFacts } from './memory-extract.js';
import { TEACHER_TOOLS, createCardStore, createTeacherToolkit, runTeacherLoop, newResolutionId, resolved, stripCardMarkup } from './teacher.js';
import { createDemoTeacherClient } from './teacher-demo.js';
// Phase 3 (grounded lessons) + Phase 4 (steering)
import { withWebSearch, streamGrounded, createSourceRegistry, citationAppData, stripGroundingTags, SOURCES_TAG } from './grounding.js';
import { createSteeringRegistry, cleanInstruction, steeringUserContent, steerDemoRemainder, trimToLastPage, normalizeContinueFrom, createContinuationSources, demoContinuation, createContinuationGuard } from './steering.js';
import { groundDemoLesson } from './demo-grounding.js';
import { masteryContext } from './learner-model.js'; // Phase 6
import { lintLesson, critiqueLesson, applyQuizFixes, qualityReport } from './critic.js'; // Phase 7
import { createGrader } from './grader.js'; // Phase 8
import { SOCRATIC_TUTOR_MODE } from './prompts-extra.js'; // Phase 8
import { pageCount } from '../public/steering-core.js';
import { createCommonsLookup, createFigureResolver, withFigures, FIGURE_SETTLE_MS } from './figures.js'; // media: <Figure/> images
import { createInflight, createTurnLedger, cleanKey, retryNote } from './retry.js'; // recoverable streams

export const STATIC_ROOTS = [
  { prefix: '/chatgpt-dil/src/', dir: path.join(LAB_ROOT, 'chatgpt-dil', 'src'), exts: new Set(['.js', '.css']) },
  { prefix: '/wondering-genui/src/', dir: path.join(LAB_ROOT, 'wondering-genui', 'src'), exts: new Set(['.js']) },
  // KaTeX's dist (math typesetting, public/math.js): read-only, scripts/styles/fonts only
  { prefix: '/vendor/katex/', dir: path.join(WONDER_ROOT, 'node_modules', 'katex', 'dist'), exts: new Set(['.js', '.mjs', '.css', '.woff2', '.woff', '.ttf']) },
  { prefix: '/', dir: path.join(WONDER_ROOT, 'public'), exts: new Set(['.js', '.css', '.html', '.svg', '.png', '.ico', '.json', '.webmanifest']) },
];
export const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
export const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TUTOR_FOLLOWUPS = ['Quiz me on this lesson', 'Give me a real-world example', 'What should I learn next?'];
const DEFAULT_TEACHER_FOLLOWUPS = ['What should I study today?', 'Make me a study plan', 'Quiz me'];
const MEMORY_OFF_CONTEXT = 'The learner turned memory off for this conversation: do not save or forget memory items, and do not assume anything about them beyond this conversation.';

/** History from the client: user/assistant strings, starting with a user turn. */
function cleanHistory(raw, { max = 12, chars = 8000, map = (s) => s } = {}) {
  const history = (Array.isArray(raw) ? raw : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-max)
    .map((m) => ({ role: m.role, content: map(m.content).slice(0, chars) }));
  while (history.length && history[0].role !== 'user') history.shift();
  // the API needs alternating roles: merge accidental repeats
  const out = [];
  for (const m of history) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

/** Append the new learner message (merged into a trailing user turn left by a failed reply). */
function withMessage(history, message) {
  const out = history.map((m) => ({ ...m }));
  if (out.length && out[out.length - 1].role === 'user') out[out.length - 1].content += `\n\n${message}`;
  else out.push({ role: 'user', content: message });
  return out;
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

/** Largest JSON body a path accepts: material uploads (Phase 10) carry a PDF as base64. */
export function bodyLimit(pathname) {
  return pathname === '/api/materials' ? MATERIAL_BODY_LIMIT : MAX_BODY;
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Body must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** A file under one of the read-only static roots for this URL path, or null. */
export function resolveStatic(pathname, roots = STATIC_ROOTS) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel === '/' || rel === '') rel = '/index.html';
  for (const root of roots) {
    if (!rel.startsWith(root.prefix)) continue;
    const file = path.resolve(root.dir, '.' + rel.slice(root.prefix.length - 1));
    if (!file.startsWith(root.dir + path.sep)) break;
    const ext = path.extname(file);
    if (!root.exts.has(ext)) continue;
    let stat;
    try { stat = fs.statSync(/* turbopackIgnore: true */ file); } catch { continue; }
    if (!stat.isFile()) continue;
    return { file, type: MIME[ext] || 'application/octet-stream', size: stat.size };
  }
  return null;
}

function serveStatic(req, res, pathname) {
  const hit = resolveStatic(pathname);
  if (!hit) return false;
  res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(/* turbopackIgnore: true */ hit.file).pipe(res);
  return true;
}

/** Follow '## ' headings as they stream and narrate progress like ChatGPT's reasoning line. */
function progressNarrator(writer, { first = 'Writing the introduction…', pages: initialPages = 0 } = {}) {
  let started = false;
  let pages = initialPages; // a continuation starts after the kept pages
  return () => {
    if (!started) { started = true; writer.reasoning(first); }
    const n = (('\n' + writer.markdown).match(/\n## /g) || []).length;
    if (n < pages) pages = n; // a steering replace dropped the unfinished page
    for (; pages < n; ) writer.reasoning(`Writing page ${++pages}…`);
  };
}

/**
 * The API without a transport. Each request is handed a transport `t`:
 *   t.url                     the request URL (path + query)
 *   t.json(status, body)      send a JSON response
 *   t.openStream(headers)  -> {write(string), signal, onClose(fn)}: start a streamed response
 *   t.send(status, headers, bytes)  send a raw response (a stored material file, Phase 10)
 *   t.end()                   finish the response
 * @param {{client?:object, mode?:'claude'|'demo', env?:object, demoDelayMs?:number, logger?:Console}} [opts]
 */
export function createWonderCore(opts = {}) {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;
  const state = {
    mode: opts.mode ?? detectMode(env),
    client: opts.client ?? null,
    demoReason: null,
    demoDelayMs: opts.demoDelayMs ?? 22,
  };
  if (state.mode === 'claude' && !state.client) state.client = createClaudeClient();
  if (state.mode === 'claude' && !state.client) { state.mode = 'demo'; state.demoReason = 'no-credentials'; }
  if (state.mode === 'demo' && !state.demoReason) state.demoReason = 'no-credentials';
  const memory = opts.memory ?? createMemoryStore({ file: opts.memoryFile === undefined ? (env.WONDER_MEMORY_FILE || DEFAULT_MEMORY_FILE) : opts.memoryFile, logger });
  const teacherCards = createCardStore();
  const grade = createGrader({ getClient: () => state.client, getMode: () => state.mode, logger }); // Phase 8
  const widgetAction = createWidgetActionHandler({ cards: teacherCards, memory, grade });
  const demoTeacher = opts.demoTeacherClient ?? createDemoTeacherClient({ delayMs: state.demoDelayMs });
  const recordDir = opts.recordDir ?? env.WONDER_RECORD_DIR ?? null;
  const memoryContext = (body, { withIds = false } = {}) => (body?.memoryEnabled === false ? '' : memory.promptBlock({ withIds }));
  // Phase 6: the client's mastery summary (personalization, so it follows the memory switch)
  const learnerKnows = (body, surface) => (body?.memoryEnabled === false ? '' : masteryContext(body?.mastery, surface));
  const steering = createSteeringRegistry(); // Phase 4: in-flight lesson operations
  // recoverable streams (server/retry.js): one live request per streamKey; Teacher tool calls per turnId
  const inflight = createInflight();
  const teacherTurns = createTurnLedger();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  // Phase 10: the learner's own material. Tests that keep memory in-process (memoryFile: null)
  // keep materials in-process too unless they pass materialsDir.
  const materials = opts.materials ?? createMaterialStore({ dir: 'materialsDir' in opts ? opts.materialsDir : opts.memoryFile === null ? null : (env.WONDER_MATERIALS_DIR || DEFAULT_MATERIALS_DIR) });
  /** {meta, data} for a client-sent material id, or null. */
  const loadMaterial = (id) => {
    if (id == null || id === '') return null;
    const meta = materials.meta(id);
    const data = meta ? materials.read(id) : null;
    return meta && data != null ? { meta, data } : { missing: true };
  };

  // <Figure/> images come from Wikimedia Commons; WONDER_FIGURES=off (or figureLookup: null) skips the network
  const figureLookup = opts.figureLookup !== undefined ? opts.figureLookup : env.WONDER_FIGURES === 'off' ? null : createCommonsLookup();
  const figureSettleMs = opts.figureSettleMs ?? FIGURE_SETTLE_MS;
  const figureCache = new Map(); // shared by this core's streams (server/figures.js)

  function switchToDemo(reason) {
    state.mode = 'demo';
    state.demoReason = reason;
    logger.warn?.(`[wonder] switching to demo mode (${reason})`);
  }

  /**
   * Open an NDJSON response. `retryKey` (scope + the client's streamKey) supersedes an older
   * request with the same key: it is aborted before this one starts. A blank line every
   * `heartbeatMs` keeps the connection visibly alive (parsers skip blank lines), so the
   * client's idle watchdog only fires on a dead connection.
   *
   * Every DIL stream (lesson, tutor, Teacher) resolves its <Figure/>s: a lookup that lands
   * mid-stream re-sends the program (writer.refresh), and settleFigures runs before complete.
   */
  function startNdjson(t, { record, retryKey, appData, appDataFor, ...writerOpts } = {}) {
    const claim = retryKey ? inflight.claim(retryKey) : null;
    const io = t.openStream({ 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const signal = claim ? AbortSignal.any([io.signal, claim.signal]) : io.signal;
    let writer = null;
    const beat = heartbeatMs > 0 ? setInterval(() => { if (!writer?.finished && !signal.aborted) io.write('\n'); }, heartbeatMs) : null;
    beat?.unref?.();
    io.onClose(() => { clearInterval(beat); claim?.release(); });
    // WONDER_RECORD_DIR: tee the NDJSON of each stream to a file (fixture capture; records hold no credentials)
    let tee = null;
    if (recordDir && record) {
      try { fs.mkdirSync(recordDir, { recursive: true }); tee = fs.createWriteStream(path.join(recordDir, `${record}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)); io.onClose(() => tee.end()); } catch { tee = null; }
    }
    const figures = createFigureResolver({ lookup: figureLookup, logger, cache: figureCache, signal });
    writer = createTurnWriter({ write: (s) => { io.write(s); tee?.write(s); }, ...writerOpts, appDataFor: withFigures(appDataFor || (() => appData), figures) });
    let queued = false;
    figures.onUpdate(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (writer.finished || signal.aborted) return;
        try { writer.refresh(); } catch (err) { logger.warn?.(`[wonder] figure refresh failed: ${err?.message || err}`); }
      });
    });
    return { writer, signal, figures };
  }
  /** Before the final record: wait briefly for image lookups, then report the rest as not found. */
  async function settleFigures(writer, figures, signal) {
    if (figures.pending && !signal.aborted) {
      writer.reasoning('Finding images…', { icon: 'image' });
      await figures.settle(figureSettleMs);
    }
    figures.finalize();
  }

  /** Run Claude, falling back to demo on missing credentials. Returns 'done' | 'demo' | 'failed'. */
  async function runClaude(writer, params, onText, signal, stream = (p, o) => streamText(state.client, p, o)) {
    try {
      const { stopReason } = await stream(params, { onText, signal });
      if (stopReason === 'refusal') {
        onText(REFUSAL_MESSAGE);
        return { status: 'done', truncated: false, refused: true };
      }
      return { status: 'done', truncated: stopReason === 'max_tokens' };
    } catch (err) {
      if (signal.aborted) return { status: 'aborted' };
      if (!writer.markdown && isCredentialError(err)) {
        switchToDemo('credentials-failed');
        writer.reasoning('Claude credentials were not accepted. Showing demo content…');
        return { status: 'demo' };
      }
      const f = friendlyError(err);
      // The API error body (type + message) never contains credentials; log it for diagnosis.
      const detail = err?.status ? ` (HTTP ${err.status}: ${err?.error?.error?.message || err.message})` : '';
      logger.error?.(`[wonder] Claude request failed: ${f.code}${detail}`);
      writer.fail(f.message, f.code, f);
      return { status: 'failed' };
    }
  }

  // ---- Phase 3: web search with citations -> Cite pills + Sources (server/grounding.js)
  function groundedStream(writer, sources, mapCitation) {
    return (p, o) => streamGrounded(state.client, p, {
      ...o,
      registry: sources,
      mapCitation,
      onSearch: (q) => writer.reasoning(q ? `Searching the web: “${String(q).slice(0, 80)}”` : 'Searching the web…', { icon: 'globe' }),
      onSearchError: (code) => { logger.warn?.(`[wonder] web search error: ${code}`); writer.reasoning('Search is unavailable, writing from what I know…'); },
    });
  }
  function finishGrounded(writer, sources) {
    if (sources.size) writer.append(`${writer.markdown.endsWith('\n') ? '\n' : '\n\n'}${SOURCES_TAG}\n`);
  }
  // ---- Phase 4: steering. Keep the complete pages, replace the tail, continue.
  function applySteer(writer, instruction, kept = trimToLastPage(writer.markdown)) {
    writer.control('steering-status', { status: 'accepted', instruction });
    writer.control('steering-message', { message: { role: 'user', content: instruction } });
    writer.reasoning(`Steering: ${instruction}`);
    writer.replace(kept);
    return kept;
  }
  // continueFrom (no live stream): resume an interrupted lesson, steer it after a reload, or
  // revise a finished one from page N. Same records as a live steer; a resume has no instruction.
  function applyContinue(writer, cont) {
    if (cont.instruction) return applySteer(writer, cont.instruction, cont.kept);
    writer.control('steering-status', { status: 'accepted', instruction: '', resume: true });
    writer.reasoning('Resuming where the lesson stopped…');
    writer.replace(cont.kept);
    return cont.kept;
  }

  async function lessonStream(t, body) {
    const topic = clean(body.topic, 300);
    if (!topic) return t.json(400, { ok: false, error: 'topic is required' });
    const cont = normalizeContinueFrom(body.continueFrom);
    if (cont?.error) return t.json(cont.status, { ok: false, error: cont.error });
    const level = ['beginner', 'intermediate', 'advanced'].includes(body.level) ? body.level : 'beginner';
    const material = loadMaterial(body.materialId); // Phase 10
    if (material?.missing) return t.json(404, { ok: false, error: 'That material is no longer stored on this server. Add it again from Today.' });
    // Phase 3: web search on by default for lessons; a lesson taught from the learner's own
    // material stays faithful to it unless search is asked for explicitly
    const useWebSearch = material ? body.useWebSearch === true : body.useWebSearch !== false;
    const userTurn = (text) => (material ? [documentBlock(material.meta, material.data), { type: 'text', text }] : text);
    // a continuation seeds the kept pages' sources and numbers new refs after theirs
    const sources = cont ? createContinuationSources({ turnIndex: 0, kept: cont.kept, seed: cont.sources }) : createSourceRegistry({ turnIndex: 0 });
    const streamKey = cleanKey(body.streamKey);
    const { writer, signal, figures } = startNdjson(t, { record: 'lesson', retryKey: streamKey && `lesson:${streamKey}`, appDataFor: citationAppData(sources), ...(cont?.messageId ? { messageId: cont.messageId } : {}) });
    writer.start();
    if (cont) applyContinue(writer, cont);
    else writer.reasoning('Planning the lesson…');
    const narrate = progressNarrator(writer, cont ? { first: cont.instruction ? `Steering: ${cont.instruction}` : 'Resuming where the lesson stopped…', pages: pageCount(cont.kept) } : undefined);
    // continueFrom: the first attempt continues the kept text (mid-page for a resume); a leading
    // repeat of a kept heading/paragraph is dropped (createContinuationGuard). A later live steer
    // is page-level and streams unguarded.
    let guard = cont ? createContinuationGuard(cont.kept) : null;
    const emit = (t) => { if (t) { writer.append(t); narrate(); } };
    const onText = (t) => emit(guard ? guard.push(t) : t);
    const endAttempt = () => { if (guard) { const g = guard; guard = null; emit(g.flush()); } };
    const op = steering.open(writer.operationId, signal, { onReject: (reason, instruction) => writer.control('steering-status', { status: 'rejected', reason, instruction }) });
    // A steer queued while (or just after) the upstream stream ended is applied as a continuation,
    // never dropped: lessonSteer only says "accepted" while the operation is still open, and the
    // operation stays open until this check fails synchronously right before close().
    const nextSteer = () => (signal.aborted ? null : op.takeSteer());
    let result = { status: 'demo' };
    try {
      if (state.mode === 'claude') {
        const request = lessonUserMessage({ topic, level, course: body.course, lessonTitle: clean(body.lessonTitle, 200), lessonSummary: clean(body.lessonSummary, 400), variant: body.variant, material: material?.meta });
        const learner = memoryContext(body);
        if (learner) logger.info?.(`[wonder] lesson request personalized with ${Math.min(memory.size, 15)} memory items`);
        const context = joinContext(
          learner && `${learner}\nUse this to pick examples and pacing that fit this learner; the lesson itself stays about the requested topic.`,
          learnerKnows(body, 'lesson'),
          body.memoryEnabled !== false ? insightsContext(body.learnerInsights) : '', // Phase 9
        );
        let messages = cont
          ? [{ role: 'user', content: userTurn(steeringUserContent(request, cont.kept, cont.instruction, { mode: cont.mode, fromPage: cont.fromPage })) }]
          : [{ role: 'user', content: userTurn(request) }];
        for (;;) {
          const params = withWebSearch(buildStreamParams({ system: LESSON_SYSTEM_PROMPT, context, messages, effort: 'medium' }), useWebSearch);
          const grounded = useWebSearch || material ? groundedStream(writer, sources, material ? materialCitation([material.meta]) : undefined) : undefined;
          result = await runClaude(writer, params, onText, op.attempt(), grounded);
          if (result.status === 'done') endAttempt();
          if (result.status !== 'aborted' && result.status !== 'done') break;
          const instruction = nextSteer();
          if (!instruction) break;
          guard = null;
          const kept = applySteer(writer, instruction);
          messages = [{ role: 'user', content: userTurn(steeringUserContent(request, kept, instruction)) }];
        }
      }
      if (result.status === 'demo') {
        let pick = pickDemoLesson(body.lessonTitle || topic);
        if (material?.meta.kind === 'text') pick = { id: null, title: material.meta.title, matched: true, markdown: demoMaterialLesson(material.meta, material.data) };
        else if (material) writer.reasoning('Demo mode cannot read PDFs. Showing a sample lesson instead…');
        else if (!pick.matched) writer.reasoning(`Demo mode: no sample for "${topic}", showing "${pick.title}"`);
        const ground = (md) => (useWebSearch && pick.id ? groundDemoLesson(pick.id, md, sources) : md);
        let text;
        let kept = '';
        if (cont) {
          kept = cont.kept;
          text = kept + demoContinuation(pick.markdown, kept, cont.instruction, { ground });
        } else text = ground(pick.markdown);
        let r = await streamDemoText(text.slice(kept.length), { onText, delayMs: state.demoDelayMs, signal: op.attempt(), seed: topic.length });
        if (!r.aborted) endAttempt();
        for (let instruction = nextSteer(); instruction && !signal.aborted; instruction = nextSteer()) {
          guard = null;
          kept = applySteer(writer, instruction);
          text = kept + (text.startsWith(kept) ? steerDemoRemainder(text.slice(kept.length), instruction) : demoContinuation(pick.markdown, kept, instruction, { ground }));
          r = await streamDemoText(text.slice(kept.length), { onText, delayMs: state.demoDelayMs, signal: op.attempt(), seed: topic.length });
        }
        result = { status: r.aborted ? 'aborted' : 'done', truncated: false };
      }
    } finally {
      op.close();
    }
    if (result.status === 'done') {
      finishGrounded(writer, sources);
      // Phase 7: lint always; the Claude critic only for a whole, non-refused Claude lesson
      if (body.verify !== false && !signal.aborted) {
        await verifyLesson(writer, { topic, level, sources, signal, useClaude: state.mode === 'claude' && !result.refused && !result.truncated });
      }
      await settleFigures(writer, figures, signal);
      if (!signal.aborted) writer.complete({ truncated: result.truncated });
    }
    t.end();
  }

  // ---- Phase 7: quality check after the lesson streamed (server/critic.js)
  async function verifyLesson(writer, { topic, level, sources, signal, useClaude }) {
    const md = writer.markdown;
    let lint = lintLesson(md);
    let critique = null;
    let applied = [];
    let error = null;
    if (useClaude) {
      writer.reasoning('Double-checking facts and quiz answers…', { icon: 'check' });
      try {
        critique = await critiqueLesson(state.client, { markdown: md, topic, level, sources: sources.list(), signal });
        const fixed = applyQuizFixes(md, critique.quizFixes);
        applied = fixed.applied;
        if (fixed.rejected.length) logger.warn?.(`[wonder] critic quiz fixes rejected: ${fixed.rejected.map((r) => `${r.question_id} (${r.reason})`).join('; ')}`);
        if (applied.length && !signal.aborted) {
          writer.replace(fixed.markdown);
          lint = lintLesson(fixed.markdown);
        }
        logger.info?.(`[wonder] lesson critic: ${critique.verdict}, ${critique.issues.length} issue(s), ${applied.length} quiz fix(es)`);
      } catch (err) {
        if (signal.aborted) return;
        error = err?.code === 'timeout' ? 'timeout' : friendlyError(err).code;
        logger.warn?.(`[wonder] lesson critic skipped: ${error}`);
      }
    }
    if (!signal.aborted) writer.control('quality-report', { report: qualityReport({ lint, critique, applied, checked: !!critique, error }) });
  }

  async function lessonSteer(t, body) {
    const instruction = cleanInstruction(body.instruction);
    if (!instruction) return t.json(400, { ok: false, error: 'instruction is required' });
    const op = steering.get(String(body.operationId || ''));
    if (!op || op.closed) return t.json(409, { ok: false, status: 'rejected', reason: 'not_streaming', error: 'This lesson has finished streaming.' });
    if (!op.steer(instruction)) return t.json(409, { ok: false, status: 'rejected', reason: op.hasSteer ? 'busy' : 'not_streaming', error: op.hasSteer ? 'Still applying your last change.' : 'This lesson has finished streaming.' });
    return t.json(200, { ok: true, status: 'accepted', operationId: op.operationId });
  }

  async function tutorStream(t, body) {
    const message = clean(body.message, 4000);
    if (!message) return t.json(400, { ok: false, error: 'message is required' });
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
    while (history.length && history[0].role !== 'user') history.shift();
    const useWebSearch = body.useWebSearch === true; // Phase 3: off for the tutor unless asked
    const sources = createSourceRegistry({ turnIndex: Math.floor(history.length / 2) + 1 });
    const streamKey = cleanKey(body.streamKey);
    const { writer, signal, figures } = startNdjson(t, { record: 'tutor', retryKey: streamKey && `tutor:${streamKey}`, appDataFor: citationAppData(sources) });
    writer.start();
    writer.reasoning('Thinking about your question…');
    const onText = (t) => writer.append(t);
    let result = { status: 'demo' };
    if (state.mode === 'claude') {
      const params = withWebSearch(buildStreamParams({
        system: TUTOR_SYSTEM_PROMPT,
        context: joinContext(tutorLessonContext({ ...body.lessonContext, markdown: stripGroundingTags(body.lessonContext?.markdown) }), memoryContext(body), learnerKnows(body, 'tutor'), body.mode === 'socratic' ? SOCRATIC_TUTOR_MODE : ''),
        messages: [...history, { role: 'user', content: message }],
        effort: 'medium',
      }), useWebSearch);
      result = await runClaude(writer, params, onText, signal, useWebSearch ? groundedStream(writer, sources) : undefined);
    }
    if (result.status === 'demo') {
      const reply = buildDemoTutorReply({ lessonContext: body.lessonContext, message, mode: body.mode });
      const r = await streamDemoText(reply, { onText, delayMs: state.demoDelayMs, signal, seed: message.length });
      result = { status: r.aborted ? 'aborted' : 'done', truncated: false };
    }
    if (result.status === 'done') finishGrounded(writer, sources);
    if (result.status === 'done') await settleFigures(writer, figures, signal);
    if (result.status === 'done') writer.complete({ truncated: result.truncated, defaultFollowups: result.refused ? [] : DEFAULT_TUTOR_FOLLOWUPS });
    t.end();
  }

  async function coursePlan(t, body) {
    const topic = clean(body.topic, 300);
    if (!topic) return t.json(400, { ok: false, error: 'topic is required' });
    const level = ['beginner', 'intermediate', 'advanced'].includes(body.level) ? body.level : 'beginner';
    const material = loadMaterial(body.materialId); // Phase 10: a course that follows the learner's material
    if (material?.missing) return t.json(404, { ok: false, error: 'That material is no longer stored on this server.' });
    if (state.mode === 'claude') {
      try {
        const params = buildStructuredParams({ system: COURSE_SYSTEM_PROMPT, schema: COURSE_PLAN_SCHEMA, user: `Topic: ${topic}\nLevel: ${level}`, effort: 'low' });
        if (material) {
          // structured output: the document goes in without citations (they don't combine)
          params.messages = [{ role: 'user', content: [documentBlock(material.meta, material.data, { citations: false }), { type: 'text', text: `Plan a course that teaches the attached material "${material.meta.title}", following its structure and order. Each lesson covers one part of it; lesson summaries name what the learner will be able to explain from that part.\nLevel: ${level}` }] }];
        }
        const plan = await createStructured(state.client, params);
        const sections = (plan.sections || []).map((s) => ({ title: clean(s.title, 120), lessons: (s.lessons || []).map((l) => ({ title: clean(l.title, 160), summary: clean(l.summary, 300) })).filter((l) => l.title).slice(0, 4) })).filter((s) => s.title && s.lessons.length).slice(0, 4);
        if (!sections.length) throw new Error('empty plan');
        return t.json(200, { ok: true, plan: { title: clean(plan.title, 120) || topic, description: clean(plan.description, 400), level, sections } });
      } catch (err) {
        if (isCredentialError(err)) switchToDemo('credentials-failed');
        else if (err?.code === 'refusal') return t.json(200, { ok: false, error: "I can't build a course on that topic. Try something else you're curious about." });
        else {
          const f = friendlyError(err);
          if (f.code !== 'internal') return t.json(502, { ok: false, error: f.message, code: f.code });
          logger.warn?.('[wonder] course plan fell back to a template');
        }
      }
    }
    return t.json(200, { ok: true, plan: material?.meta.kind === 'text' ? demoMaterialCourse(material.meta, material.data, level) : demoCoursePlan(topic, level) });
  }

  async function practiceExtract(t, body) {
    const markdown = stripGroundingTags(String(body.lessonMarkdown ?? ''));
    if (!markdown.trim()) return t.json(400, { ok: false, error: 'lessonMarkdown is required' });
    if (state.mode === 'claude') {
      try {
        return t.json(200, { ok: true, ...(await extractPracticeWithClaude(state.client, markdown)) });
      } catch (err) {
        if (isCredentialError(err)) switchToDemo('credentials-failed');
        logger.warn?.(`[wonder] structured extraction failed (${friendlyError(err).code}); using lesson components`);
      }
    }
    return t.json(200, { ok: true, ...extractPracticeDeterministic(markdown) });
  }


  async function teacherStream(t, body) {
    // Phase 10: a check-in (opener) turn uses the server's own fixed user turn, never client text
    const message = body.opener === true ? TEACHER_OPENER : clean(body.message, 4000);
    if (!message) return t.json(400, { ok: false, error: 'message is required' });
    const memoryEnabled = body.memoryEnabled !== false;
    const threadId = typeof body.threadId === 'string' && /^[\w-]{1,80}$/.test(body.threadId) ? body.threadId : undefined;
    const history = cleanHistory(body.history, { map: stripCardMarkup });
    const appData = { opGenui: { componentResults: {}, modelDataBindings: {} } };
    // a retried turn (same turnId) supersedes the attempt it replaces and replays its tool calls
    const turnId = cleanKey(body.turnId);
    const { writer, signal, figures } = startNdjson(t, { appData, record: 'teacher', retryKey: turnId && `teacher:${turnId}` });
    const turn = turnId ? teacherTurns.open(turnId) : null;
    writer.start({ conversationId: threadId });
    writer.reasoning('Thinking…');
    const params = buildStreamParams({
      system: TEACHER_SYSTEM_PROMPT,
      context: joinContext(memoryEnabled ? memory.promptBlock({ withIds: true }) || 'The learner\'s memory is empty so far.' : MEMORY_OFF_CONTEXT, learnerKnows(body, 'teacher'), turn ? retryNote(turn.recorded) : ''),
      messages: [],
      effort: 'medium',
      maxTokens: 32000,
      tools: TEACHER_TOOLS,
    });
    const run = (client) => runTeacherLoop({
      client,
      params,
      messages: withMessage(history, message),
      writer,
      signal,
      execute: (() => { const ex = createTeacherToolkit({ memory, progress: body.progress, mastery: body.mastery, memoryEnabled }); return turn ? turn.wrap(ex) : ex; })(),
      onCard: (cardState, card) => {
        const rid = card?.rid || newResolutionId();
        // a replayed card keeps its id and whatever state it has reached since
        const known = card?.replayed ? teacherCards.get(rid) : null;
        appData.opGenui.componentResults[rid] = resolved(known || teacherCards.set(rid, cardState));
        return rid;
      },
      logger,
    });
    let result;
    try {
      result = await run(state.mode === 'claude' ? state.client : demoTeacher);
    } catch (err) {
      if (signal.aborted) return t.end();
      if (state.mode === 'claude' && !writer.markdown && isCredentialError(err)) {
        switchToDemo('credentials-failed');
        writer.reasoning('Claude credentials were not accepted. Showing a demo reply…');
        try { result = await run(demoTeacher); } catch { if (signal.aborted) return t.end(); }
      }
      if (!result) {
        const f = friendlyError(err);
        const detail = err?.status ? ` (HTTP ${err.status}: ${err?.error?.error?.message || err.message})` : '';
        logger.error?.(`[wonder] Teacher request failed: ${f.code}${detail}`);
        writer.fail(f.message, f.code, f);
        return t.end();
      }
    }
    if (result.refused) writer.append(REFUSAL_MESSAGE);
    await settleFigures(writer, figures, signal);
    if (signal.aborted) return t.end();
    writer.complete({ truncated: result.truncated, defaultFollowups: result.refused ? [] : DEFAULT_TEACHER_FOLLOWUPS });
    t.end();
  }

  // ---------------------------------------------------------------- memory

  async function memoryList(t) {
    t.json(200, { ok: true, items: memory.list() });
  }

  async function memoryAdd(t, body) {
    const r = memory.add({ fact: body.fact, kind: body.kind, source: 'user' });
    if (!r.ok) return t.json(400, { ok: false, error: r.error });
    t.json(200, { ok: true, item: r.item, duplicate: r.duplicate, items: memory.list() });
  }

  async function memoryDelete(t, body) {
    const id = new URL(t.url, 'http://localhost').searchParams.get('id') || body.id;
    if (body.all === true) return t.json(200, { ok: true, removed: memory.clear(), items: [] });
    if (typeof id !== 'string' || !id) return t.json(400, { ok: false, error: 'id (or all:true) is required' });
    const item = memory.remove(id);
    if (!item) return t.json(404, { ok: false, error: 'No such memory item' });
    t.json(200, { ok: true, removed: 1, item, items: memory.list() });
  }

  async function memoryExtract(t, body) {
    if (body.memoryEnabled === false) return t.json(200, { ok: true, added: [], source: 'disabled' });
    const input = normalizeExtractInput(body);
    const existing = memory.list();
    let facts = null;
    let source = 'quiz-results';
    if (state.mode === 'claude') {
      try {
        facts = await extractMemoryWithClaude(state.client, input, existing);
        source = 'claude';
      } catch (err) {
        if (isCredentialError(err)) switchToDemo('credentials-failed');
        logger.warn?.(`[wonder] memory extraction failed (${err?.code === 'refusal' ? 'refusal' : friendlyError(err).code}); using quiz results`);
      }
    }
    if (!facts) facts = extractMemoryDeterministic(input);
    const added = [];
    for (const f of filterNewFacts(facts, existing)) {
      const r = memory.add({ ...f, source: 'lesson' });
      if (r.ok && !r.duplicate) added.push(r.item);
    }
    t.json(200, { ok: true, added, source });
  }

  const routes = {
    'POST /api/lesson/stream': lessonStream,
    'POST /api/tutor/stream': tutorStream,
    'POST /api/lesson/steer': lessonSteer, // Phase 4
    'POST /api/course/plan': coursePlan,
    'POST /api/practice/extract': practiceExtract,
    'POST /api/teacher/stream': teacherStream,
    'GET /api/memory': memoryList,
    'POST /api/memory': memoryAdd,
    'DELETE /api/memory': memoryDelete,
    'POST /api/memory/extract': memoryExtract,
    'POST /api/widget_action': async (t, body) => { const r = await widgetAction(body); t.json(r.status, r.body); }, // Phase 8: free-response grading is async
    // Phase 10: the learner's own material
    'GET /api/materials': async (t) => t.json(200, { ok: true, items: materials.list() }),
    'POST /api/materials': async (t, body) => {
      const r = materials.add({ title: body.title, kind: body.kind, text: body.text, base64: body.base64, filename: body.filename });
      if (!r.ok) return t.json(400, r);
      logger.info?.(`[wonder] material added: ${r.item.kind}, ${r.item.chars ?? r.item.bytes} ${r.item.kind === 'pdf' ? 'bytes' : 'chars'}`);
      t.json(200, { ok: true, item: r.item, items: materials.list() });
    },
    'DELETE /api/materials': async (t, body) => {
      const id = new URL(t.url, 'http://localhost').searchParams.get('id') || body.id;
      const meta = materials.remove(id);
      if (!meta) return t.json(404, { ok: false, error: 'No such material' });
      t.json(200, { ok: true, removed: meta, items: materials.list() });
    },
    'GET /api/materials/file': async (t) => {
      const id = new URL(t.url, 'http://localhost').searchParams.get('id');
      const meta = materials.meta(id);
      const data = meta ? materials.read(id) : null;
      if (data == null) return t.json(404, { ok: false, error: 'No such material' });
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      t.send(200, { 'Content-Type': meta.kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8', 'Content-Length': String(buf.length), 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, buf);
    },
  };

  const status = () => ({ mode: state.mode, model: MODEL, ...(state.mode === 'demo' ? { demoReason: state.demoReason } : {}) });

  /** Run one API request. Resolves when the response has ended; a 404 for unknown API paths. */
  async function handle(method, pathname, body, t) {
    if (pathname === '/api/status' && method === 'GET') return t.json(200, status());
    const route = routes[`${method} ${pathname}`];
    if (route) return route(t, body);
    return t.json(404, { ok: false, error: 'Not found' });
  }
  /** Does this method + path have a handler (and therefore a body to read)? */
  const hasRoute = (method, pathname) => (pathname === '/api/status' && method === 'GET') || !!routes[`${method} ${pathname}`];

  return { state, memory, teacherCards, status, handle, hasRoute };
}

/** Node transport: the core over node:http req/res. */
function nodeTransport(req, res) {
  return {
    url: req.url,
    json: (status, body) => sendJson(res, status, body),
    send: (status, headers, bytes) => { res.writeHead(status, headers); res.end(bytes); },
    openStream(headers) {
      res.writeHead(200, { ...headers, Connection: 'keep-alive' });
      res.flushHeaders?.();
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      return { write: (s) => { if (!res.destroyed && !res.writableEnded) res.write(s); }, signal: ac.signal, onClose: (fn) => res.on('close', fn) };
    },
    end: () => res.end(),
  };
}

/**
 * Standalone node:http server (the API plus the static client files). The app itself runs on
 * Next.js; this server exists for the test suite and for running without a Next build.
 * @param {Parameters<typeof createWonderCore>[0]} [opts]
 */
export function createWonderServer(opts = {}) {
  const core = createWonderCore(opts);
  const logger = opts.logger ?? console;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (core.hasRoute(req.method, url.pathname)) {
        const body = req.method === 'GET' ? {} : await readJson(req, bodyLimit(url.pathname));
        return await core.handle(req.method, url.pathname, body, nodeTransport(req, res));
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Not found' });
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      sendJson(res, err.status || 500, { ok: false, error: err.status ? err.message : 'Internal error' });
      if (!err.status) logger.error?.('[wonder] request failed', err?.message);
    }
  });
  server.wonder = core.state;
  server.memory = core.memory;
  server.teacherCards = core.teacherCards;
  return server;
}
