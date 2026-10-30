// Wonder's API, as a transport-agnostic core (createWonderCore) with two front ends:
// Next.js route handlers (server/web.js, app/api/[...route]/route.js) and a small node:http
// server (createWonderServer) that the test suite drives.
//
//   GET  /api/status            -> {claude, model (lessons), models (per task), error?} (claude:false: no credentials, Claude routes answer 503)
//   POST /api/lesson/stream     -> conversation-source NDJSON (lesson in markdown + DIL); continueFrom resumes/revises
//   POST /api/tutor/stream      -> conversation-source NDJSON (tutor reply + followupPrompts)
//   POST /api/lesson/steer      -> JSON {ok, status: accepted|rejected} (Phase 4 mid-turn steering)
//   POST /api/course/plan       -> JSON course outline
//   POST /api/widget_action     -> JSON (componentResults / issueTurn / grading result)
//   POST /api/practice/extract  -> JSON knowledge cards + practice items
//   POST /api/teacher/stream    -> conversation-source NDJSON (Teacher turn: tool loop, cards in componentResults)
//   GET/POST/DELETE /api/memory -> learner memory items
//   POST /api/memory/extract    -> 0-3 new memory facts from a finished lesson
//   GET  /api/account           -> {sync, signedIn, plan, billing, usage, push} (account sync: server/sync/)
//   DELETE /api/account         -> delete everything kept for the signed-in user, then the sign-in
//   POST /api/billing/checkout  -> {url} of a Polar checkout for Pro (signed in; server/billing.js)
//   POST /api/billing/portal    -> {url} of Polar's customer portal: card, invoices, cancel (signed in)
//   POST /api/billing/sync      -> {plan}: the plan read from Polar now (signed in; back from checkout)
//   POST /api/billing/webhook   -> Polar subscription events (signed over t.rawBody) -> plan records
//   POST /api/sync              -> push changed records, pull newer ones (signed in)
//   POST/DELETE /api/push/subscribe -> this browser's Web Push subscription (signed in)
//   GET  /api/cron/reminders    -> daily reminders over Web Push (Vercel Cron, CRON_SECRET)
//   GET  /                      -> public/ ; /chatgpt-dil/src/* and /wondering-genui/src/* (read-only modules)

import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WONDER_ROOT, LAB_ROOT } from './paths.js';
import { CONTENT_TYPE, createTurnWriter } from './ndjson.js';
import {
  taskModels, hasClaudeCredentials, createClaudeClient, buildStreamParams, buildStructuredParams, streamText, createStructured,
  friendlyError, badRequestMessage, REFUSAL_MESSAGE, CLAUDE_NOT_CONFIGURED,
} from './claude.js';
import { createMaterialStore, DEFAULT_MATERIALS_DIR, MATERIAL_BODY_LIMIT, PART_BODY_LIMIT, PART_BYTES, MAX_PARTS, MAX_PDF_BYTES, MAX_MATERIAL_TOKENS, UPLOAD_ID_RE, isBase64, pdfTooLarge, materialCharge, prepareMaterial, extractPdfText, MIN_FALLBACK_CHARS, newUploadId, createPartStore, pruneUploads, takeUpload, documentBlock, materialCitation } from './materials.js'; // Phase 10
import { TEACHER_OPENER } from '../public/teacher-core.js'; // Phase 10
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT, TEACHER_SYSTEM_PROMPT, COURSE_SYSTEM_PROMPT, COURSE_PLAN_SCHEMA, lessonUserMessage, tutorLessonContext, joinContext, insightsContext } from './prompts.js';
import { extractPracticeDeterministic, extractPracticeWithClaude } from './practice.js';
import { createWidgetActionHandler } from './widget-actions.js';
import { createMemoryStore, DEFAULT_MEMORY_FILE } from './memory.js';
import { normalizeExtractInput, extractMemoryDeterministic, extractMemoryWithClaude, filterNewFacts } from './memory-extract.js';
import { TEACHER_TOOLS, createCardStore, createTeacherToolkit, runTeacherLoop, newResolutionId, resolved, stripCardMarkup } from './teacher.js';
// Phase 3 (grounded lessons) + Phase 4 (steering)
import { withWebSearch, streamGrounded, createSourceRegistry, citationAppData, stripGroundingTags, SOURCES_TAG } from './grounding.js';
import { createSteeringRegistry, cleanInstruction, steeringUserContent, trimToLastPage, normalizeContinueFrom, createContinuationSources, createContinuationGuard } from './steering.js';
import { masteryContext } from './learner-model.js'; // Phase 6
import { lintLesson, critiqueLesson, applyQuizFixes, qualityReport } from './critic.js'; // Phase 7
import { createGrader } from './grader.js'; // Phase 8
import { SOCRATIC_TUTOR_MODE } from './prompts-extra.js'; // Phase 8
import { pageCount } from '../public/steering-core.js';
import { createCommonsLookup, createFigureResolver, createFigureCheck, FIGURE_SETTLE_MS, FIGURE_CHECK_MODEL } from './figures.js'; // media: <Figure/> images
import { createYouTubeLookup, createVideoResolver } from './videos.js'; // media: <Video/> clips
import { combineResolvers, withResolved } from './media-resolver.js';
import { createInflight, createTurnLedger, cleanKey, retryNote } from './retry.js'; // recoverable streams
// account sync + Web Push
import { createSyncFromEnv } from './sync/index.js';
import { SYNC_BODY_LIMIT } from './sync/service.js';
import { loadUserMemory, signedOutMemory, userMaterials, signedOutMaterials, userUploadParts } from './sync/user-stores.js';
import { pushConfig, webPushSender, sendDueReminders } from './push.js';
import { usageKind, usageLimits, createUsageGate } from './usage.js'; // sign-in + daily caps for Claude routes
import { createPlans } from './plans.js'; // Free/Pro: which daily caps apply
import { polarConfig, createPolarBilling } from './billing.js'; // buying Pro through Polar

export const STATIC_ROOTS = [
  { prefix: '/chatgpt-dil/src/', dir: path.join(LAB_ROOT, 'chatgpt-dil', 'src'), exts: new Set(['.js', '.css']) },
  { prefix: '/wondering-genui/src/', dir: path.join(LAB_ROOT, 'wondering-genui', 'src'), exts: new Set(['.js']) },
  // KaTeX's dist (math typesetting, public/math.js): read-only, scripts/styles/fonts only
  { prefix: '/vendor/katex/', dir: path.join(WONDER_ROOT, 'node_modules', 'katex', 'dist'), exts: new Set(['.js', '.mjs', '.css', '.woff2', '.woff', '.ttf']) },
  { prefix: '/', dir: path.join(WONDER_ROOT, 'public'), exts: new Set(['.js', '.css', '.html', '.svg', '.png', '.ico', '.json', '.webmanifest']) },
];
export const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
export const MAX_BODY = 2 * 1024 * 1024;
/** Request bodies up to this size are also kept as raw text (t.rawBody), for signature checks. */
export const RAW_BODY_KEEP = 256 * 1024;
const DEFAULT_TUTOR_FOLLOWUPS = ['Quiz me on this lesson', 'Give me a real-world example', 'What should I learn next?'];
const DEFAULT_TEACHER_FOLLOWUPS = ['What should I study today?', 'Make me a study plan', 'Quiz me'];
// with account sync on: routes that need a signed-in user, and routes that read learner memory
const SIGNED_IN_ONLY = new Set(['DELETE /api/account', 'POST /api/lesson/steer', 'POST /api/billing/checkout', 'POST /api/billing/portal', 'POST /api/billing/sync', 'POST /api/sync', 'POST /api/push/subscribe', 'DELETE /api/push/subscribe', 'POST /api/memory', 'DELETE /api/memory', 'POST /api/materials', 'POST /api/materials/part', 'DELETE /api/materials', 'GET /api/materials/file']);
const MEMORY_PATHS = /^\/api\/(lesson|tutor|teacher|memory|widget_action)(\/|$)/;
// routes that only Claude can answer: 503 while the server has no credentials
const NEEDS_CLAUDE = new Set(['POST /api/lesson/stream', 'POST /api/tutor/stream', 'POST /api/teacher/stream', 'POST /api/course/plan']);
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

/** Largest JSON body a path accepts: material uploads (Phase 10) carry a PDF (or a part of one) as base64. */
export function bodyLimit(pathname) {
  if (pathname === '/api/sync') return SYNC_BODY_LIMIT;
  if (pathname === '/api/materials/part') return PART_BODY_LIMIT;
  return pathname === '/api/materials' ? MATERIAL_BODY_LIMIT : MAX_BODY;
}

/** A JSON request body as {body, raw}: raw is the exact text (up to RAW_BODY_KEEP), for signature checks. */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const raw = size <= RAW_BODY_KEEP ? text : undefined; // large uploads are not held twice
      if (!text) return resolve({ body: {}, raw });
      try { resolve({ body: JSON.parse(text), raw }); } catch { reject(Object.assign(new Error('Body must be JSON'), { status: 400 })); }
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
 * `client` is the Anthropic client (tests pass a fake); without one, the server makes one when
 * the environment has credentials, and otherwise runs without Claude (Claude routes answer 503).
 * @param {{client?:object|null, env?:object, logger?:Console}} [opts]
 */
export function createWonderCore(opts = {}) {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;
  const state = {
    client: opts.client !== undefined ? opts.client : hasClaudeCredentials(env) ? createClaudeClient() : null,
  };
  const localMemory = opts.memory ?? createMemoryStore({ file: opts.memoryFile === undefined ? (env.WONDER_MEMORY_FILE || DEFAULT_MEMORY_FILE) : opts.memoryFile, logger });
  // Account sync (server/sync/): with it on, memory and material belong to the signed-in user.
  // Each request runs in a scope that holds that user's stores; `memory` and `materials` below
  // follow the current scope, so every route and the Teacher's tools use the right user's data.
  // Without sync (or outside a request) they are the local file-backed stores, as before.
  const syncReady = opts.sync !== undefined ? Promise.resolve(opts.sync) : createSyncFromEnv(env, { logger }).catch((e) => { logger.error?.(`[wonder] account sync unavailable: ${e.message}`); return null; });
  const push = opts.push !== undefined ? opts.push : pushConfig(env);
  const scopes = new AsyncLocalStorage();
  let usage = opts.usage ?? null; // per-user daily caps on Claude routes (server/usage.js), made on first use
  let plans = opts.plans ?? null; // Free/Pro per user (server/plans.js), made on first use
  const usageGate = (sync) => (usage ??= createUsageGate({ db: sync.db, limits: usageLimits(env), proLimits: usageLimits(env, 'pro'), logger }));
  const userPlans = (sync) => (plans ??= createPlans({ db: sync.db, env, logger }));
  /** Charge one Claude call to a user's daily caps: null when it may go ahead, else the 429 body. */
  async function overCap(sync, userId, kind, { retryKey, units = 1 } = {}) {
    if (!state.client || userPlans(sync).isAdmin(userId)) return null; // a server without Claude spends nothing; admins have no caps
    const plan = await userPlans(sync).planId(userId);
    const r = await usageGate(sync).charge(userId, kind, { retryKey, units, plan });
    return r.ok ? null : r.body;
  }
  // Polar checkout, portal and webhooks (server/billing.js); null when not configured
  let billing = opts.billing;
  const billingFor = (sync) => {
    if (billing === undefined) {
      const config = polarConfig(env);
      billing = config ? createPolarBilling({ config, plans: userPlans(sync), fetch: opts.billingFetch, logger }) : null;
      if (billing) logger.info?.(`[wonder] billing: Polar ${config.server}`);
    }
    return billing;
  };
  const scoped = (name, local) => new Proxy({}, {
    get(_, k) {
      const target = scopes.getStore()?.[name] ?? local();
      const v = Reflect.get(target, k, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const memory = scoped('memory', () => localMemory);
  const materials = scoped('materials', () => localMaterials);
  const uploadParts = scoped('parts', () => localParts);
  const teacherCards = createCardStore();
  const models = opts.models ?? taskModels(env); // which Claude model each kind of call uses (claude.js TASK_MODELS)
  const grade = createGrader({ getClient: () => state.client, logger, model: models.grade }); // Phase 8
  const widgetAction = createWidgetActionHandler({ cards: teacherCards, memory, grade });
  const recordDir = opts.recordDir ?? env.WONDER_RECORD_DIR ?? null;
  const memoryContext = (body, { withIds = false } = {}) => (body?.memoryEnabled === false ? '' : memory.promptBlock({ withIds }));
  // Phase 6: the client's mastery summary (personalization, so it follows the memory switch)
  const learnerKnows = (body, surface) => (body?.memoryEnabled === false ? '' : masteryContext(body?.mastery, surface));
  const steering = createSteeringRegistry(); // Phase 4: in-flight lesson operations
  // recoverable streams (server/retry.js): one live request per streamKey; Teacher tool calls per turnId
  const inflight = createInflight();
  const teacherTurns = createTurnLedger();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  // with accounts on, retry keys belong to the signed-in user: one user's streamKey or turnId
  // can never abort another user's stream or replay their Teacher tool calls
  const ownKey = (key) => { const u = scopes.getStore()?.userId; return key && u ? `${u}|${key}` : key; };
  // Phase 10: the learner's own material. Tests that keep memory in-process (memoryFile: null)
  // keep materials in-process too unless they pass materialsDir.
  const localMaterials = opts.materials ?? createMaterialStore({ dir: 'materialsDir' in opts ? opts.materialsDir : opts.memoryFile === null ? null : (env.WONDER_MATERIALS_DIR || DEFAULT_MATERIALS_DIR) });
  const localParts = createPartStore();
  /**
   * How many tokens Claude reads for a new material (count_tokens is free), so a document too long
   * for a lesson's request (over MAX_MATERIAL_TOKENS, or over 600 PDF pages) is refused at upload
   * rather than when a course is planned. {error} when Claude can't take it; null when it can't be
   * counted (no Claude, a network error), and the material is kept anyway.
   */
  async function materialTokens(meta, data) {
    if (!state.client) return null;
    let tokens;
    try {
      ({ input_tokens: tokens } = await state.client.messages.countTokens({ model: models.lesson, messages: [{ role: 'user', content: [documentBlock(meta, data, { citations: false, cache: false }), { type: 'text', text: 'Read this.' }] }] }));
    } catch (err) {
      const refused = badRequestMessage(err);
      if (refused) return { error: `Claude can't read that file: ${refused}` };
      logger.warn?.(`[wonder] could not count material tokens: ${err?.message}`);
      return null;
    }
    if (tokens > MAX_MATERIAL_TOKENS) return { error: `That ${meta.kind === 'pdf' ? 'PDF' : 'text'} is too long for one lesson (about ${Math.round(tokens / 1000)}k tokens; the limit is ${MAX_MATERIAL_TOKENS / 1000}k). Split it and add the part you need.` };
    return tokens;
  }

  /** A PDF taught from its text layer: the same material, as text. */
  const asText = (meta, text) => ({ meta: { ...meta, kind: 'text' }, data: text });
  /** {meta, data} for a client-sent material id, or null. */
  const loadMaterial = async (id) => {
    if (id == null || id === '') return null;
    const meta = await materials.meta(id);
    if (meta?.textFallback) { const text = await materials.readText(id); if (text != null) return asText(meta, text); }
    const data = meta ? await materials.read(id) : null;
    return meta && data != null ? { meta, data } : { missing: true };
  };
  /** Claude refused this PDF itself ("Could not process PDF", too many pages): its text layer may still do. */
  const unreadablePdf = (err, material) => material?.meta.kind === 'pdf' && /\bPDF\b/i.test(badRequestMessage(err) || '');
  /**
   * The material Claude could not read as a PDF, as its text layer from now on (kept with the
   * material, so later lessons go straight to it), or {error} when it has no usable text.
   */
  async function pdfAsText(material) {
    let text = '';
    try { text = await extractPdfText(material.data); } catch (e) { logger.warn?.(`[wonder] could not read the PDF's text layer: ${e.message}`); }
    if (text.length < MIN_FALLBACK_CHARS) return { error: "Claude can't read this PDF, and it has no text layer to teach from. Export it again as a PDF (for example with Preview's Export as PDF) and add that, or paste its text." };
    const pages = (text.match(/^\[Page \d+\]$/gm) || []).length;
    const meta = await materials.setTextFallback(material.meta.id, text, { chars: text.length, pages });
    logger.info?.(`[wonder] material ${material.meta.id}: Claude could not read the PDF; teaching from its text layer (${pages} pages, ${text.length} chars)`);
    return asText(meta || material.meta, text);
  }

  // <Figure/> images come from Wikimedia Commons; WONDER_FIGURES=off (or figureLookup: null) skips the network
  const figureLookup = opts.figureLookup !== undefined ? opts.figureLookup : env.WONDER_FIGURES === 'off' ? null : createCommonsLookup();
  const figureSettleMs = opts.figureSettleMs ?? FIGURE_SETTLE_MS;
  const figureCache = new Map(); // shared by this core's streams (server/figures.js)
  // The figure vision check: Claude looks at each found image and drops one that does not fit its
  // caption. On by default when Claude is configured (it needs the client); figureCheck: false or
  // WONDER_FIGURE_CHECK=off turns it off, and a function replaces the check (tests).
  const figureCheckOpt = opts.figureCheck !== undefined ? opts.figureCheck : env.WONDER_FIGURE_CHECK === 'off' ? false : true;
  const figureCheckModel = opts.figureCheckModel || env.WONDER_FIGURE_CHECK_MODEL || FIGURE_CHECK_MODEL;
  const figureVerify = typeof figureCheckOpt === 'function' ? figureCheckOpt : createFigureCheck({ client: () => state.client, model: figureCheckModel });
  const figureVerifyFor = () => (figureCheckOpt && state.client ? figureVerify : null);
  // which check runs now (the eval report records it): the model id, 'custom', or null when off
  Object.defineProperty(state, 'figureCheck', { get: () => (figureVerifyFor() ? (typeof figureCheckOpt === 'function' ? 'custom' : figureCheckModel) : null) });
  // <Video/> clips come from the YouTube Data API (YOUTUBE_API_KEY). Without a key Videos are left
  // out; WONDER_VIDEOS=off (or videoLookup: null) skips the network.
  const videoLookup = opts.videoLookup !== undefined ? opts.videoLookup : env.WONDER_VIDEOS === 'off' ? null : createYouTubeLookup({ apiKey: env.YOUTUBE_API_KEY });
  const videoSource = () => (videoLookup ? 'youtube' : 'off');
  const videoCache = new Map();

  /**
   * Open an NDJSON response. `retryKey` (scope + the client's streamKey) supersedes an older
   * request with the same key: it is aborted before this one starts. A blank line every
   * `heartbeatMs` keeps the connection visibly alive (parsers skip blank lines), so the
   * client's idle watchdog only fires on a dead connection.
   *
   * Every DIL stream (lesson, tutor, Teacher) resolves its <Figure/>s and <Video/>s: a lookup
   * that lands mid-stream re-sends the program (writer.refresh), and settleMedia runs before complete.
   */
  function startNdjson(t, { record, retryKey, appData, appDataFor, ...writerOpts } = {}) {
    const claim = retryKey ? inflight.claim(ownKey(retryKey)) : null;
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
    const media = combineResolvers([
      createFigureResolver({ lookup: figureLookup, verify: figureVerifyFor(), logger, cache: figureCache, signal }),
      createVideoResolver({ lookup: videoLookup, logger, cache: videoCache, signal }),
    ]);
    writer = createTurnWriter({ write: (s) => { io.write(s); tee?.write(s); }, ...writerOpts, appDataFor: withResolved(appDataFor || (() => appData), media) });
    let queued = false;
    media.onUpdate(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (writer.finished || signal.aborted) return;
        try { writer.refresh(); } catch (err) { logger.warn?.(`[wonder] media refresh failed: ${err?.message || err}`); }
      });
    });
    return { writer, signal, media };
  }
  /** Before the final record: wait briefly for image and video lookups, then report the rest as not found. */
  async function settleMedia(writer, media, signal) {
    if (media.pending && !signal.aborted) {
      writer.reasoning(media.label, { icon: 'image' });
      await media.settle(figureSettleMs);
    }
    media.finalize();
  }

  /** Run Claude. Returns {status: 'done' | 'aborted' | 'failed' | 'retry'}. */
  /** `retryable(err)`: an error the caller recovers from itself ({status: 'retry', err}, nothing shown). */
  async function runClaude(writer, params, onText, signal, stream = (p, o) => streamText(state.client, p, o), { retryable, task } = {}) {
    try {
      const { stopReason } = await stream(params, { onText, signal, task });
      if (stopReason === 'refusal') {
        onText(REFUSAL_MESSAGE);
        return { status: 'done', truncated: false, refused: true };
      }
      return { status: 'done', truncated: stopReason === 'max_tokens' };
    } catch (err) {
      if (signal.aborted) return { status: 'aborted' };
      if (retryable?.(err)) return { status: 'retry', err };
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
    let material = await loadMaterial(body.materialId); // Phase 10
    if (material?.missing) return t.json(404, { ok: false, error: 'That material is no longer stored on this server. Add it again from Today.' });
    // Phase 3: web search on by default for lessons; a lesson taught from the learner's own
    // material stays faithful to it unless search is asked for explicitly
    const useWebSearch = material ? body.useWebSearch === true : body.useWebSearch !== false;
    const userTurn = (text) => (material ? [documentBlock(material.meta, material.data), { type: 'text', text }] : text);
    // a continuation seeds the kept pages' sources and numbers new refs after theirs
    const sources = cont ? createContinuationSources({ turnIndex: 0, kept: cont.kept, seed: cont.sources }) : createSourceRegistry({ turnIndex: 0 });
    const streamKey = cleanKey(body.streamKey);
    const { writer, signal, media } = startNdjson(t, { record: 'lesson', retryKey: streamKey && `lesson:${streamKey}`, appDataFor: citationAppData(sources), ...(cont?.messageId ? { messageId: cont.messageId } : {}) });
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
    op.owner = scopes.getStore()?.userId ?? null; // only the lesson's own learner may steer it
    // A steer queued while (or just after) the upstream stream ended is applied as a continuation,
    // never dropped: lessonSteer only says "accepted" while the operation is still open, and the
    // operation stays open until this check fails synchronously right before close().
    const nextSteer = () => (signal.aborted ? null : op.takeSteer());
    let result;
    try {
      const request = lessonUserMessage({ topic, level, course: body.course, lessonTitle: clean(body.lessonTitle, 200), lessonSummary: clean(body.lessonSummary, 400), variant: body.variant, material: material?.meta });
      const learner = memoryContext(body);
      if (learner) logger.info?.(`[wonder] lesson request personalized with ${Math.min(memory.size, 15)} memory items`);
      const context = joinContext(
        learner && `${learner}\nUse this to pick examples and pacing that fit this learner; the lesson itself stays about the requested topic.`,
        learnerKnows(body, 'lesson'),
        body.memoryEnabled !== false ? insightsContext(body.learnerInsights) : '', // Phase 9
      );
      const firstMessages = () => (cont
        ? [{ role: 'user', content: userTurn(steeringUserContent(request, cont.kept, cont.instruction, { mode: cont.mode, fromPage: cont.fromPage })) }]
        : [{ role: 'user', content: userTurn(request) }]);
      let messages = firstMessages();
      for (;;) {
        const params = withWebSearch(buildStreamParams({ system: LESSON_SYSTEM_PROMPT, context, messages, effort: 'medium', model: models.lesson }), useWebSearch);
        const grounded = useWebSearch || material ? groundedStream(writer, sources, material ? materialCitation([material.meta]) : undefined) : undefined;
        result = await runClaude(writer, params, onText, op.attempt(), grounded, { task: 'lesson', retryable: (err) => !writer.markdown && unreadablePdf(err, material) });
        if (result.status === 'retry') { // the PDF itself was refused: teach from its text layer
          const text = await pdfAsText(material);
          if (text.error) { writer.fail(text.error, 'bad_request'); result = { status: 'failed' }; break; }
          material = text;
          writer.reasoning("Claude couldn't read the PDF's pages, so this lesson uses the book's text…");
          messages = firstMessages();
          continue;
        }
        if (result.status === 'done') endAttempt();
        if (result.status !== 'aborted' && result.status !== 'done') break;
        const instruction = nextSteer();
        if (!instruction) break;
        guard = null;
        const kept = applySteer(writer, instruction);
        messages = [{ role: 'user', content: userTurn(steeringUserContent(request, kept, instruction)) }];
      }
    } finally {
      op.close();
    }
    if (result.status === 'done') {
      finishGrounded(writer, sources);
      // Phase 7: lint always; the Claude critic only for a whole, non-refused lesson
      if (body.verify !== false && !signal.aborted) {
        await verifyLesson(writer, { topic, level, sources, signal, useClaude: !result.refused && !result.truncated });
      }
      await settleMedia(writer, media, signal);
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
        critique = await critiqueLesson(state.client, { markdown: md, topic, level, sources: sources.list(), signal, model: models.critic });
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
    const { userId, sync } = scopes.getStore() || {};
    // another user's lesson looks like one that has finished: an operation id reveals nothing
    if (!op || op.closed || (sync && op.owner !== userId)) return t.json(409, { ok: false, status: 'rejected', reason: 'not_streaming', error: 'This lesson has finished streaming.' });
    if (op.hasSteer) { op.steer(instruction); return t.json(409, { ok: false, status: 'rejected', reason: 'busy', error: 'Still applying your last change.' }); } // rejects in the stream too
    // an accepted steer is a new Claude request on the lesson: it counts as a lesson
    if (sync) { const over = await overCap(sync, userId, 'lesson'); if (over) return t.json(429, over); }
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
    const { writer, signal, media } = startNdjson(t, { record: 'tutor', retryKey: streamKey && `tutor:${streamKey}`, appDataFor: citationAppData(sources) });
    writer.start();
    writer.reasoning('Thinking about your question…');
    const onText = (t) => writer.append(t);
    const params = withWebSearch(buildStreamParams({
      system: TUTOR_SYSTEM_PROMPT,
      context: joinContext(tutorLessonContext({ ...body.lessonContext, markdown: stripGroundingTags(body.lessonContext?.markdown) }), memoryContext(body), learnerKnows(body, 'tutor'), body.mode === 'socratic' ? SOCRATIC_TUTOR_MODE : ''),
      messages: [...history, { role: 'user', content: message }],
      effort: 'medium',
      model: models.tutor,
    }), useWebSearch);
    const result = await runClaude(writer, params, onText, signal, useWebSearch ? groundedStream(writer, sources) : undefined, { task: 'tutor' });
    if (result.status === 'done') finishGrounded(writer, sources);
    if (result.status === 'done') await settleMedia(writer, media, signal);
    if (result.status === 'done') writer.complete({ truncated: result.truncated, defaultFollowups: result.refused ? [] : DEFAULT_TUTOR_FOLLOWUPS });
    t.end();
  }

  async function coursePlan(t, body) {
    const topic = clean(body.topic, 300);
    if (!topic) return t.json(400, { ok: false, error: 'topic is required' });
    const level = ['beginner', 'intermediate', 'advanced'].includes(body.level) ? body.level : 'beginner';
    let material = await loadMaterial(body.materialId); // Phase 10: a course that follows the learner's material
    if (material?.missing) return t.json(404, { ok: false, error: 'That material is no longer stored on this server.' });
    try {
      const params = buildStructuredParams({ system: COURSE_SYSTEM_PROMPT, schema: COURSE_PLAN_SCHEMA, user: `Topic: ${topic}\nLevel: ${level}`, effort: 'low', model: models.course });
      // structured output: the document goes in without citations (they don't combine)
      const fromMaterial = () => { params.messages = [{ role: 'user', content: [documentBlock(material.meta, material.data, { citations: false }), { type: 'text', text: `Plan a course that teaches the attached material "${material.meta.title}", following its structure and order. Each lesson covers one part of it; lesson summaries name what the learner will be able to explain from that part.\nLevel: ${level}` }] }]; };
      if (material) fromMaterial();
      let plan;
      try {
        plan = await createStructured(state.client, params, { task: 'course' });
      } catch (err) {
        if (!unreadablePdf(err, material)) throw err;
        const text = await pdfAsText(material); // the PDF itself was refused: plan from its text layer
        if (text.error) return t.json(422, { ok: false, error: text.error, code: 'bad_request' });
        material = text;
        fromMaterial();
        plan = await createStructured(state.client, params, { task: 'course' });
      }
      const sections = (plan.sections || []).map((s) => ({ title: clean(s.title, 120), lessons: (s.lessons || []).map((l) => ({ title: clean(l.title, 160), summary: clean(l.summary, 300) })).filter((l) => l.title).slice(0, 4) })).filter((s) => s.title && s.lessons.length).slice(0, 4);
      if (!sections.length) throw new Error('empty plan');
      return t.json(200, { ok: true, plan: { title: clean(plan.title, 120) || topic, description: clean(plan.description, 400), level, sections } });
    } catch (err) {
      if (err?.code === 'refusal') return t.json(200, { ok: false, error: "I can't build a course on that topic. Try something else you're curious about." });
      const f = friendlyError(err);
      logger.warn?.(`[wonder] course plan failed: ${f.code}${f.code === 'internal' ? ` (${err?.message})` : ''}`);
      return t.json(502, { ok: false, error: f.code === 'internal' ? "Couldn't plan that course. Please try again." : f.message, code: f.code });
    }
  }

  async function practiceExtract(t, body) {
    const markdown = stripGroundingTags(String(body.lessonMarkdown ?? ''));
    if (!markdown.trim()) return t.json(400, { ok: false, error: 'lessonMarkdown is required' });
    if (state.client) {
      try {
        return t.json(200, { ok: true, ...(await extractPracticeWithClaude(state.client, markdown, { model: models.extract })) });
      } catch (err) {
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
    const { writer, signal, media } = startNdjson(t, { appData, record: 'teacher', retryKey: turnId && `teacher:${turnId}` });
    const turn = turnId ? teacherTurns.open(ownKey(turnId)) : null;
    writer.start({ conversationId: threadId });
    writer.reasoning('Thinking…');
    const params = buildStreamParams({
      system: TEACHER_SYSTEM_PROMPT,
      context: joinContext(memoryEnabled ? memory.promptBlock({ withIds: true }) || 'The learner\'s memory is empty so far.' : MEMORY_OFF_CONTEXT, learnerKnows(body, 'teacher'), turn ? retryNote(turn.recorded) : ''),
      messages: [],
      effort: 'medium',
      maxTokens: 32000,
      tools: TEACHER_TOOLS,
      model: models.teacher,
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
      result = await run(state.client);
    } catch (err) {
      if (signal.aborted) return t.end();
      const f = friendlyError(err);
      const detail = err?.status ? ` (HTTP ${err.status}: ${err?.error?.error?.message || err.message})` : '';
      logger.error?.(`[wonder] Teacher request failed: ${f.code}${detail}`);
      writer.fail(f.message, f.code, f);
      return t.end();
    }
    if (result.refused) writer.append(REFUSAL_MESSAGE);
    await settleMedia(writer, media, signal);
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
    if (state.client) {
      try {
        facts = await extractMemoryWithClaude(state.client, input, existing, { model: models.extract });
        source = 'claude';
      } catch (err) {
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
    'GET /api/materials': async (t) => t.json(200, { ok: true, items: await materials.list() }),
    'POST /api/materials': async (t, body) => {
      let bytes;
      if (body.upload != null) { // a PDF sent in parts
        bytes = await takeUpload(uploadParts, body.upload, body.parts);
        if (!bytes) return t.json(400, { ok: false, error: 'Part of that upload is missing. Attach the file again.' });
      }
      const prepared = prepareMaterial({ title: body.title, kind: body.kind, text: body.text, base64: body.base64, bytes, filename: body.filename });
      if (!prepared.ok) return t.json(400, prepared);
      const tokens = await materialTokens(prepared.meta, prepared.data);
      if (tokens?.error) return t.json(400, { ok: false, error: tokens.error });
      if (tokens) prepared.meta.tokens = tokens;
      const r = await materials.save(prepared);
      logger.info?.(`[wonder] material added: ${r.item.kind}, ${r.item.chars ?? r.item.bytes} ${r.item.kind === 'pdf' ? 'bytes' : 'chars'}`);
      t.json(200, { ok: true, item: r.item, items: await materials.list() });
    },
    'POST /api/materials/part': async (t, body) => {
      const index = Number(body.index);
      const total = Number(body.total);
      if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 0 || index >= total) return t.json(400, { ok: false, error: 'Bad upload part' });
      if (total > MAX_PARTS) return t.json(400, { ok: false, error: pdfTooLarge(total * PART_BYTES) });
      const upload = index === 0 ? newUploadId() : String(body.upload ?? '');
      const b64 = String(body.base64 ?? '');
      if (!UPLOAD_ID_RE.test(upload) || !isBase64(b64)) return t.json(400, { ok: false, error: 'Bad upload part' });
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > PART_BYTES) return t.json(413, { ok: false, error: 'Upload part too large' });
      if (index === 0) await pruneUploads(uploadParts); // a new upload: drop abandoned ones first
      await uploadParts.put(upload, index, bytes);
      t.json(200, { ok: true, upload });
    },
    'DELETE /api/materials': async (t, body) => {
      const id = new URL(t.url, 'http://localhost').searchParams.get('id') || body.id;
      const meta = await materials.remove(id);
      if (!meta) return t.json(404, { ok: false, error: 'No such material' });
      t.json(200, { ok: true, removed: meta, items: await materials.list() });
    },
    'GET /api/materials/file': async (t) => {
      const id = new URL(t.url, 'http://localhost').searchParams.get('id');
      const meta = await materials.meta(id);
      const data = meta ? await materials.read(id) : null;
      if (data == null) return t.json(404, { ok: false, error: 'No such material' });
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      t.send(200, { 'Content-Type': meta.kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8', 'Content-Length': String(buf.length), 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, buf);
    },
    // account sync + Web Push
    'GET /api/account': account,
    'DELETE /api/account': deleteAccount,
    'POST /api/sync': syncRoute,
    'POST /api/push/subscribe': pushSubscribe,
    'DELETE /api/push/subscribe': pushUnsubscribe,
    'GET /api/cron/reminders': cronReminders,
    'POST /api/billing/checkout': billingCheckout,
    'POST /api/billing/portal': billingPortal,
    'POST /api/billing/sync': billingSync,
    'POST /api/billing/webhook': billingWebhook,
  };

  // materials: the upload limits public/today.js checks before sending a file
  const status = () => ({ claude: !!state.client, model: models.lesson, models, ...(state.client ? {} : { error: CLAUDE_NOT_CONFIGURED }), videos: videoSource(), materials: { maxPdfBytes: MAX_PDF_BYTES, partBytes: PART_BYTES } });

  /** Run one API request. Resolves when the response has ended; a 404 for unknown API paths. */
  async function handle(method, pathname, body, t) {
    if (pathname === '/api/status' && method === 'GET') return t.json(200, status());
    const route = routes[`${method} ${pathname}`];
    if (!route) return t.json(404, { ok: false, error: 'Not found' });
    if (!state.client && NEEDS_CLAUDE.has(`${method} ${pathname}`)) return t.json(503, { ok: false, error: CLAUDE_NOT_CONFIGURED, code: 'not_configured' });
    const sync = await syncReady;
    if (!sync) return route(t, body);
    // account sync on: memory and material are the signed-in user's, and nobody else's
    const userId = typeof t.userId === 'string' && t.userId ? t.userId : null;
    if (!userId && SIGNED_IN_ONLY.has(`${method} ${pathname}`)) return t.json(401, { ok: false, error: 'Sign in first', signedOut: true });
    const userMats = userId ? userMaterials(sync, userId) : null;
    // routes that call Claude: signed in only, and within the user's daily caps (server/usage.js).
    // A lesson or course plan taught from a long material counts as more than one.
    const spend = usageKind(method, pathname, body);
    if (spend) {
      if (!userId) return t.json(401, { ok: false, error: 'Sign in to use Mull: lessons, the tutor and the Teacher need an account.', signedOut: true });
      const units = body?.materialId ? materialCharge(await userMats.meta(body.materialId)) : 1;
      const over = await overCap(sync, userId, spend, { retryKey: cleanKey(body?.streamKey) || cleanKey(body?.turnId), units });
      if (over) return t.json(429, over);
    }
    const scope = { userId, sync, memory: signedOutMemory(), materials: signedOutMaterials() };
    if (userId) {
      scope.materials = userMats;
      scope.parts = userUploadParts(sync, userId);
      if (MEMORY_PATHS.test(pathname)) scope.memory = await loadUserMemory(sync, userId, { logger });
    }
    // memory saves finish before the response does: a serverless function may be frozen once
    // its response has ended
    const flush = () => scope.memory.flush?.();
    const tt = {
      ...t,
      json: (status, data) => { Promise.resolve(flush()).then(() => t.json(status, data)); },
      send: (status, headers, bytes) => { Promise.resolve(flush()).then(() => t.send(status, headers, bytes)); },
      end: () => { Promise.resolve(flush()).then(() => t.end()); },
    };
    try {
      return await scopes.run(scope, () => route(tt, body));
    } finally {
      await flush();
    }
  }

  // ---------------------------------------------------------------- account sync + Web Push

  async function account(t) {
    const sync = await syncReady;
    const userId = sync && typeof t.userId === 'string' && t.userId ? t.userId : null;
    const record = userId ? await userPlans(sync).record(userId) : null;
    const plan = userId ? await userPlans(sync).describe(userId, record) : null;
    const pay = userId ? billingFor(sync) : null;
    t.json(200, {
      ok: true,
      sync: !!sync,
      signedIn: !!userId,
      // billing: what the browser may offer (upgrade, manage); null without a payment provider
      ...(userId ? { userId, records: await sync.count(userId), plan, billing: pay ? await pay.offer(record, plan) : null } : {}),
      ...(userId && state.client ? { usage: await usageGate(sync).today(userId, plan.id, { unlimited: plan.source === 'admin' }) } : {}),
      push: sync && push ? { publicKey: push.publicKey } : null,
    });
  }

  async function deleteAccount(t) {
    const { userId, sync } = scopes.getStore() || {};
    if (!sync) return t.json(404, { ok: false, error: 'Accounts are not configured on this server' });
    // Pro subscriptions end first, so a deleted account is never charged again; if that fails
    // nothing is deleted. Only users who ever opened checkout (they have a plan record) can have one.
    const pay = billingFor(sync);
    let record = null;
    let ended = 0;
    if (pay) {
      try {
        record = await userPlans(sync).stored(userId);
      } catch (e) {
        logger.error?.(`[wonder] account delete: plan lookup failed: ${e.message}`);
        return t.json(503, { ok: false, error: 'Could not delete your account right now, so nothing was deleted. Try again in a minute.' });
      }
      if (record?.provider === 'polar') {
        try {
          ended = await pay.cancelAll(userId, record);
        } catch (e) {
          logger.error?.(`[wonder] account delete: could not end the Pro subscription: ${e.message}`);
          return t.json(502, { ok: false, error: 'Could not reach billing to end your Pro subscription, so nothing was deleted. Try again in a minute.' });
        }
      }
    }
    try {
      await sync.deleteAccount(userId);
    } catch (e) {
      if (!ended) throw e;
      logger.error?.(`[wonder] account delete failed after ending its Pro subscription: ${e.message}`);
      return t.json(500, { ok: false, error: 'Your Pro subscription was canceled, but deleting your data failed. Try deleting again.' });
    }
    // the data is gone: now the Polar customer too (best effort)
    if (pay && record?.provider === 'polar') await pay.forgetCustomer(userId);
    // then the sign-in itself, in the same request, so a closed tab cannot leave it behind
    const authDeleted = (await t.deleteAuthUser?.()) === true;
    logger.info?.(`[wonder] account deleted${authDeleted ? ' with its sign-in' : ''}`);
    t.json(200, { ok: true, authDeleted });
  }

  async function syncRoute(t, body) {
    const { userId, sync } = scopes.getStore() || {};
    if (!sync) return t.json(404, { ok: false, error: 'Account sync is not configured on this server' });
    // a browser syncing an account's cache must still be signed in to that account
    if (body.userId && body.userId !== userId) return t.json(409, { ok: false, error: 'Signed in as someone else', signedInAs: userId });
    t.json(200, await sync.sync(userId, { since: body.since, changes: body.changes }));
  }

  async function pushSubscribe(t, body) {
    const { userId, sync } = scopes.getStore() || {};
    if (!sync || !push) return t.json(404, { ok: false, error: 'Push is not configured on this server' });
    const sub = body.subscription;
    const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : '';
    if (!/^https:\/\/[^\s]{8,2000}$/.test(endpoint) || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') return t.json(400, { ok: false, error: 'Invalid push subscription' });
    const tz = typeof body.timeZone === 'string' && body.timeZone.length < 64 ? body.timeZone : null;
    await sync.db.addSubscription(userId, { endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, timeZone: tz });
    t.json(200, { ok: true });
  }

  async function pushUnsubscribe(t, body) {
    const { userId, sync } = scopes.getStore() || {};
    if (!sync) return t.json(404, { ok: false, error: 'Push is not configured on this server' });
    t.json(200, { ok: true, removed: await sync.db.removeSubscription(userId, String(body.endpoint || '')) });
  }

  async function cronReminders(t) {
    const sync = await syncReady;
    const secret = env.CRON_SECRET;
    const given = Buffer.from(String(t.authorization || ''));
    const want = Buffer.from(`Bearer ${secret}`);
    if (!secret || given.length !== want.length || !timingSafeEqual(given, want)) return t.json(401, { ok: false, error: 'Unauthorized' });
    if (!sync || !push) return t.json(200, { ok: true, skipped: 'push not configured' });
    const r = await sendDueReminders({ sync, send: opts.pushSender ?? webPushSender(push), logger });
    logger.info?.(`[wonder] reminders: ${r.sent} sent to ${r.checked} subscribed learners`);
    t.json(200, { ok: true, ...r });
  }
  /** The billing routes' common start: {userId, sync, pay}, or null once it has answered 404. */
  async function billingScope(t) {
    const { userId, sync } = scopes.getStore() || { sync: await syncReady };
    const pay = sync ? billingFor(sync) : null;
    if (!pay) { t.json(404, { ok: false, error: 'Billing is not available on this server' }); return null; }
    return { userId, sync, pay };
  }

  async function billingCheckout(t) {
    const b = await billingScope(t);
    if (!b) return;
    const plans = userPlans(b.sync);
    const plan = await plans.describe(b.userId);
    if (plan.id === 'pro') return t.json(409, { ok: false, error: 'You are already on Pro.', plan });
    let url;
    try {
      url = await b.pay.checkout(b.userId, { origin: t.origin });
    } catch (e) {
      if (e.resynced) return t.json(409, { ok: false, error: e.message, resynced: true });
      logger.error?.(`[wonder] checkout failed: ${e.message}`);
      return t.json(502, { ok: false, error: 'Could not open checkout. Try again in a minute.' });
    }
    // a pending record marks that this user may have a Polar subscription from now on (account
    // deletion looks for one only then); a real record is never replaced by it
    try {
      if (!(await plans.stored(b.userId))) await plans.setPlan(b.userId, { plan: 'pro', status: 'incomplete', provider: 'polar' });
    } catch (e) {
      logger.error?.(`[wonder] checkout: could not mark the pending plan: ${e.message}`);
      return t.json(503, { ok: false, error: 'Could not open checkout. Try again in a minute.' });
    }
    t.json(200, { ok: true, url });
  }

  const lastSync = new Map(); // userId -> time of their last POST /api/billing/sync (per instance)
  async function billingSync(t) {
    const b = await billingScope(t);
    if (!b) return;
    const at = Date.now();
    if (at - (lastSync.get(b.userId) || 0) >= 1500) {
      lastSync.set(b.userId, at);
      while (lastSync.size > 5000) lastSync.delete(lastSync.keys().next().value);
      try {
        await b.pay.sync(b.userId);
      } catch (e) {
        logger.warn?.(`[wonder] billing sync failed: ${e.message}`);
      }
    }
    t.json(200, { ok: true, plan: await userPlans(b.sync).describe(b.userId) });
  }

  async function billingPortal(t) {
    const b = await billingScope(t);
    if (!b) return;
    try {
      t.json(200, { ok: true, url: await b.pay.portal(b.userId, await userPlans(b.sync).record(b.userId), { origin: t.origin }) });
    } catch (e) {
      logger.error?.(`[wonder] billing portal failed: ${e.message}`);
      t.json(e.status === 404 ? 404 : 502, { ok: false, error: e.status === 404 ? 'No subscription to manage yet.' : 'Could not open billing. Try again in a minute.' });
    }
  }

  async function billingWebhook(t) {
    const b = await billingScope(t);
    if (!b) return;
    try {
      const r = await b.pay.webhook(typeof t.rawBody === 'string' ? t.rawBody : '', t.header);
      t.json(r.status, { ok: r.status < 300 });
    } catch (e) {
      // any other failure is a 500, so Polar delivers the event again
      logger.error?.(`[wonder] Polar webhook failed: ${e.message}`);
      t.json(500, { ok: false });
    }
  }
  /** Does this method + path have a handler (and therefore a body to read)? */
  const hasRoute = (method, pathname) => (pathname === '/api/status' && method === 'GET') || !!routes[`${method} ${pathname}`];

  return { state, memory, teacherCards, status, handle, hasRoute };
}

/** Node transport: the core over node:http req/res. */
function nodeTransport(req, res, userId = null, deleteAuthUser = null) {
  return {
    url: req.url,
    origin: `http://${req.headers.host || 'localhost'}`,
    header: (name) => req.headers[name.toLowerCase()] ?? null,
    userId,
    deleteAuthUser,
    authorization: req.headers.authorization || '',
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
  // account sync only when a test (or caller) passes it, with getUserId(req) as its auth
  const core = createWonderCore({ ...opts, sync: opts.sync ?? null });
  const logger = opts.logger ?? console;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (core.hasRoute(req.method, url.pathname)) {
        const { body, raw } = req.method === 'GET' ? { body: {}, raw: '' } : await readBody(req, bodyLimit(url.pathname));
        return await core.handle(req.method, url.pathname, body, { ...nodeTransport(req, res, (await opts.getUserId?.(req)) || null, opts.deleteAuthUser ?? null), rawBody: raw });
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
