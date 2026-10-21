// Wonder HTTP server (node:http, no framework). Serves the API and the static client.
//
//   GET  /api/status            -> {mode:"claude"|"demo", model}
//   POST /api/lesson/stream     -> conversation-source NDJSON (lesson in markdown + DIL)
//   POST /api/tutor/stream      -> conversation-source NDJSON (tutor reply + followupPrompts)
//   POST /api/lesson/steer      -> JSON {ok, status: accepted|rejected} (Phase 4 mid-turn steering)
//   POST /api/course/plan       -> JSON course outline
//   POST /api/widget_action     -> JSON (componentResults / issueTurn / grading result)
//   POST /api/practice/extract  -> JSON knowledge cards + practice items
//   GET  /                      -> public/ ; /chatgpt-dil/src/* and /wondering-genui/src/* (read-only modules)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_TYPE, createTurnWriter } from './ndjson.js';
import {
  MODEL, detectMode, createClaudeClient, buildStreamParams, buildStructuredParams, streamText, createStructured,
  isCredentialError, friendlyError, REFUSAL_MESSAGE,
} from './claude.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT, COURSE_SYSTEM_PROMPT, COURSE_PLAN_SCHEMA, lessonUserMessage, tutorLessonContext } from './prompts.js';
import { pickDemoLesson, streamDemoText, buildDemoTutorReply, demoCoursePlan } from './demo.js';
import { extractPracticeDeterministic, extractPracticeWithClaude } from './practice.js';
import { createWidgetActionHandler } from './widget-actions.js';
// Phase 3 (grounded lessons) + Phase 4 (steering)
import { withWebSearch, streamGrounded, createSourceRegistry, citationAppData, stripGroundingTags, SOURCES_TAG } from './grounding.js';
import { createSteeringRegistry, cleanInstruction, steeringUserContent, steerDemoRemainder, trimToLastPage } from './steering.js';
import { groundDemoLesson } from './demo-grounding.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WONDER_ROOT = path.resolve(HERE, '..');
const LAB_ROOT = path.resolve(WONDER_ROOT, '..');
const STATIC_ROOTS = [
  { prefix: '/chatgpt-dil/src/', dir: path.join(LAB_ROOT, 'chatgpt-dil', 'src'), exts: new Set(['.js', '.css']) },
  { prefix: '/wondering-genui/src/', dir: path.join(LAB_ROOT, 'wondering-genui', 'src'), exts: new Set(['.js']) },
  { prefix: '/', dir: path.join(WONDER_ROOT, 'public'), exts: new Set(['.js', '.css', '.html', '.svg', '.png', '.ico', '.json', '.webmanifest']) },
];
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TUTOR_FOLLOWUPS = ['Quiz me on this lesson', 'Give me a real-world example', 'What should I learn next?'];

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Body must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  for (const root of STATIC_ROOTS) {
    if (!rel.startsWith(root.prefix)) continue;
    const file = path.resolve(root.dir, '.' + rel.slice(root.prefix.length - 1));
    if (!file.startsWith(root.dir + path.sep)) break;
    const ext = path.extname(file);
    if (!root.exts.has(ext)) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

/** Follow '## ' headings as they stream and narrate progress like ChatGPT's reasoning line. */
function progressNarrator(writer, { first = 'Writing the introduction…' } = {}) {
  let started = false;
  let pages = 0;
  return () => {
    if (!started) { started = true; writer.reasoning(first); }
    const n = (('\n' + writer.markdown).match(/\n## /g) || []).length;
    if (n < pages) pages = n; // a steering replace dropped the unfinished page
    for (; pages < n; ) writer.reasoning(`Writing page ${++pages}…`);
  };
}

/**
 * @param {{client?:object, mode?:'claude'|'demo', env?:object, demoDelayMs?:number, logger?:Console}} [opts]
 */
export function createWonderServer(opts = {}) {
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
  const widgetAction = createWidgetActionHandler();
  const steering = createSteeringRegistry(); // Phase 4: in-flight lesson operations

  function switchToDemo(reason) {
    state.mode = 'demo';
    state.demoReason = reason;
    logger.warn?.(`[wonder] switching to demo mode (${reason})`);
  }

  function startNdjson(req, res, writerOpts = {}) {
    res.writeHead(200, { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders?.();
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const writer = createTurnWriter({ write: (s) => { if (!res.destroyed) res.write(s); }, ...writerOpts });
    return { writer, signal: ac.signal };
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
      writer.fail(f.message, f.code);
      return { status: 'failed' };
    }
  }

  // ---- Phase 3: web search with citations -> Cite pills + Sources (server/grounding.js)
  function groundedStream(writer, sources) {
    return (p, o) => streamGrounded(state.client, p, {
      ...o,
      registry: sources,
      onSearch: (q) => writer.reasoning(q ? `Searching the web: “${String(q).slice(0, 80)}”` : 'Searching the web…', { icon: 'globe' }),
      onSearchError: (code) => { logger.warn?.(`[wonder] web search error: ${code}`); writer.reasoning('Search is unavailable, writing from what I know…'); },
    });
  }
  function finishGrounded(writer, sources) {
    if (sources.size) writer.append(`${writer.markdown.endsWith('\n') ? '\n' : '\n\n'}${SOURCES_TAG}\n`);
  }
  // ---- Phase 4: steering. Keep the complete pages, replace the tail, continue.
  function applySteer(writer, instruction) {
    const kept = trimToLastPage(writer.markdown);
    writer.control('steering-status', { status: 'accepted', instruction });
    writer.control('steering-message', { message: { role: 'user', content: instruction } });
    writer.reasoning(`Steering: ${instruction}`);
    writer.replace(kept);
    return kept;
  }

  async function lessonStream(req, res, body) {
    const topic = clean(body.topic, 300);
    if (!topic) return sendJson(res, 400, { ok: false, error: 'topic is required' });
    const level = ['beginner', 'intermediate', 'advanced'].includes(body.level) ? body.level : 'beginner';
    const useWebSearch = body.useWebSearch !== false; // Phase 3: on by default for lessons
    const sources = createSourceRegistry({ turnIndex: 0 });
    const { writer, signal } = startNdjson(req, res, { appDataFor: citationAppData(sources) });
    writer.start();
    writer.reasoning('Planning the lesson…');
    const narrate = progressNarrator(writer);
    const onText = (t) => { writer.append(t); narrate(); };
    const op = steering.open(writer.operationId, signal, { onReject: (reason, instruction) => writer.control('steering-status', { status: 'rejected', reason, instruction }) });
    let result = { status: 'demo' };
    try {
      if (state.mode === 'claude') {
        const request = lessonUserMessage({ topic, level, course: body.course, lessonTitle: clean(body.lessonTitle, 200), lessonSummary: clean(body.lessonSummary, 400) });
        let messages = [{ role: 'user', content: request }];
        for (;;) {
          const params = withWebSearch(buildStreamParams({ system: LESSON_SYSTEM_PROMPT, messages, effort: 'medium' }), useWebSearch);
          result = await runClaude(writer, params, onText, op.attempt(), useWebSearch ? groundedStream(writer, sources) : undefined);
          if (result.status !== 'aborted' || !op.hasSteer) break;
          const instruction = op.takeSteer();
          const kept = applySteer(writer, instruction);
          messages = [{ role: 'user', content: steeringUserContent(request, kept, instruction) }];
        }
      }
      if (result.status === 'demo') {
        const pick = pickDemoLesson(body.lessonTitle || topic);
        if (!pick.matched) writer.reasoning(`Demo mode: no sample for "${topic}", showing "${pick.title}"`);
        let text = useWebSearch ? groundDemoLesson(pick.id, pick.markdown, sources) : pick.markdown;
        let r = await streamDemoText(text, { onText, delayMs: state.demoDelayMs, signal: op.attempt(), seed: topic.length });
        while (r.aborted && op.hasSteer) {
          const instruction = op.takeSteer();
          const kept = applySteer(writer, instruction);
          text = kept + steerDemoRemainder(text.startsWith(kept) ? text.slice(kept.length) : '', instruction);
          r = await streamDemoText(text.slice(kept.length), { onText, delayMs: state.demoDelayMs, signal: op.attempt(), seed: topic.length });
        }
        result = { status: r.aborted ? 'aborted' : 'done', truncated: false };
      }
    } finally {
      op.close();
    }
    if (result.status === 'done') {
      finishGrounded(writer, sources);
      writer.complete({ truncated: result.truncated });
    }
    res.end();
  }

  async function lessonSteer(req, res, body) {
    const instruction = cleanInstruction(body.instruction);
    if (!instruction) return sendJson(res, 400, { ok: false, error: 'instruction is required' });
    const op = steering.get(String(body.operationId || ''));
    if (!op) return sendJson(res, 409, { ok: false, status: 'rejected', reason: 'not_streaming', error: 'This lesson has finished streaming.' });
    if (!op.steer(instruction)) return sendJson(res, 409, { ok: false, status: 'rejected', reason: 'busy', error: 'Still applying your last change.' });
    return sendJson(res, 200, { ok: true, status: 'accepted', operationId: op.operationId });
  }

  async function tutorStream(req, res, body) {
    const message = clean(body.message, 4000);
    if (!message) return sendJson(res, 400, { ok: false, error: 'message is required' });
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
    while (history.length && history[0].role !== 'user') history.shift();
    const useWebSearch = body.useWebSearch === true; // Phase 3: off for the tutor unless asked
    const sources = createSourceRegistry({ turnIndex: Math.floor(history.length / 2) + 1 });
    const { writer, signal } = startNdjson(req, res, { appDataFor: citationAppData(sources) });
    writer.start();
    writer.reasoning('Thinking about your question…');
    const onText = (t) => writer.append(t);
    let result = { status: 'demo' };
    if (state.mode === 'claude') {
      const params = withWebSearch(buildStreamParams({
        system: TUTOR_SYSTEM_PROMPT,
        context: tutorLessonContext({ ...body.lessonContext, markdown: stripGroundingTags(body.lessonContext?.markdown) }),
        messages: [...history, { role: 'user', content: message }],
        effort: 'medium',
      }), useWebSearch);
      result = await runClaude(writer, params, onText, signal, useWebSearch ? groundedStream(writer, sources) : undefined);
    }
    if (result.status === 'demo') {
      const reply = buildDemoTutorReply({ lessonContext: body.lessonContext, message });
      const r = await streamDemoText(reply, { onText, delayMs: state.demoDelayMs, signal, seed: message.length });
      result = { status: r.aborted ? 'aborted' : 'done', truncated: false };
    }
    if (result.status === 'done') finishGrounded(writer, sources);
    if (result.status === 'done') writer.complete({ truncated: result.truncated, defaultFollowups: result.refused ? [] : DEFAULT_TUTOR_FOLLOWUPS });
    res.end();
  }

  async function coursePlan(req, res, body) {
    const topic = clean(body.topic, 300);
    if (!topic) return sendJson(res, 400, { ok: false, error: 'topic is required' });
    const level = ['beginner', 'intermediate', 'advanced'].includes(body.level) ? body.level : 'beginner';
    if (state.mode === 'claude') {
      try {
        const plan = await createStructured(state.client, buildStructuredParams({ system: COURSE_SYSTEM_PROMPT, schema: COURSE_PLAN_SCHEMA, user: `Topic: ${topic}\nLevel: ${level}`, effort: 'low' }));
        const sections = (plan.sections || []).map((s) => ({ title: clean(s.title, 120), lessons: (s.lessons || []).map((l) => ({ title: clean(l.title, 160), summary: clean(l.summary, 300) })).filter((l) => l.title).slice(0, 4) })).filter((s) => s.title && s.lessons.length).slice(0, 4);
        if (!sections.length) throw new Error('empty plan');
        return sendJson(res, 200, { ok: true, plan: { title: clean(plan.title, 120) || topic, description: clean(plan.description, 400), level, sections } });
      } catch (err) {
        if (isCredentialError(err)) switchToDemo('credentials-failed');
        else if (err?.code === 'refusal') return sendJson(res, 200, { ok: false, error: "I can't build a course on that topic. Try something else you're curious about." });
        else {
          const f = friendlyError(err);
          if (f.code !== 'internal') return sendJson(res, 502, { ok: false, error: f.message, code: f.code });
          logger.warn?.('[wonder] course plan fell back to a template');
        }
      }
    }
    return sendJson(res, 200, { ok: true, plan: demoCoursePlan(topic, level) });
  }

  async function practiceExtract(req, res, body) {
    const markdown = stripGroundingTags(String(body.lessonMarkdown ?? ''));
    if (!markdown.trim()) return sendJson(res, 400, { ok: false, error: 'lessonMarkdown is required' });
    if (state.mode === 'claude') {
      try {
        return sendJson(res, 200, { ok: true, ...(await extractPracticeWithClaude(state.client, markdown)) });
      } catch (err) {
        if (isCredentialError(err)) switchToDemo('credentials-failed');
        logger.warn?.(`[wonder] structured extraction failed (${friendlyError(err).code}); using lesson components`);
      }
    }
    return sendJson(res, 200, { ok: true, ...extractPracticeDeterministic(markdown) });
  }

  const routes = {
    'POST /api/lesson/stream': lessonStream,
    'POST /api/tutor/stream': tutorStream,
    'POST /api/lesson/steer': lessonSteer, // Phase 4
    'POST /api/course/plan': coursePlan,
    'POST /api/practice/extract': practiceExtract,
    'POST /api/widget_action': async (req, res, body) => { const r = widgetAction(body); sendJson(res, r.status, r.body); },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, { mode: state.mode, model: MODEL, ...(state.mode === 'demo' ? { demoReason: state.demoReason } : {}) });
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const body = await readJson(req);
        return await route(req, res, body);
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
  server.wonder = state;
  return server;
}
