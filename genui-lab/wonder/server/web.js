// The Wonder core over the Fetch API (Request -> Response), for Next.js route handlers.
// JSON endpoints resolve to a JSON Response; NDJSON endpoints resolve as soon as the stream
// opens and keep writing into a ReadableStream. A client disconnect (request.signal, or the
// browser cancelling the body) aborts the turn exactly like a closed node:http response.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWonderCore, resolveStatic, bodyLimit, RAW_BODY_KEEP } from './app.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

/** The JSON body as {body, raw}: raw is the exact text (up to RAW_BODY_KEEP), for signature checks. */
async function readBody(request, limit) {
  if (request.method === 'GET' || request.method === 'HEAD') return { body: {}, raw: '' };
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
  const text = await request.text();
  if (Buffer.byteLength(text) > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
  const raw = Buffer.byteLength(text) <= RAW_BODY_KEEP ? text : undefined; // large uploads are not held twice
  if (!text) return { body: {}, raw };
  try { return { body: JSON.parse(text), raw }; } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }); }
}

/**
 * Handle one /api/* request with a core from createWonderCore.
 * @param {ReturnType<typeof createWonderCore>} core
 * @param {Request} request
 * @param {{logger?: Console, userId?: string|null, deleteAuthUser?: () => Promise<boolean>}} [opts]
 *   userId: the signed-in user (account sync); deleteAuthUser: delete that user's sign-in (DELETE /api/account)
 * @returns {Promise<Response>}
 */
export async function handleWebRequest(core, request, { logger = console, userId = null, deleteAuthUser = null } = {}) {
  const url = new URL(request.url);
  if (!core.hasRoute(request.method, url.pathname)) return json(404, { ok: false, error: 'Not found' });
  let body;
  let raw;
  try { ({ body, raw } = await readBody(request, bodyLimit(url.pathname))); } catch (err) { return json(err.status || 400, { ok: false, error: err.message }); }

  return new Promise((resolve) => {
    let settled = false;
    let controller = null;
    let closed = false;
    const closers = [];
    const ac = new AbortController();
    const finish = () => {
      if (closed) return;
      closed = true;
      try { controller?.close(); } catch { /* already closed or cancelled */ }
      for (const fn of closers.splice(0)) { try { fn(); } catch {} }
    };
    const abort = () => { if (!closed) { ac.abort(); finish(); } };
    request.signal?.addEventListener?.('abort', abort);
    const encoder = new TextEncoder();
    const transport = {
      url: url.pathname + url.search,
      origin: url.origin,
      header: (name) => request.headers.get(name),
      rawBody: raw,
      userId,
      deleteAuthUser,
      authorization: request.headers.get('authorization') || '',
      json(status, data) {
        if (settled) return;
        settled = true;
        resolve(json(status, data));
      },
      send(status, headers, bytes) {
        if (settled) return;
        settled = true;
        resolve(new Response(bytes, { status, headers }));
      },
      openStream(headers) {
        const stream = new ReadableStream({
          start(c) { controller = c; },
          cancel() { abort(); },
        });
        settled = true;
        resolve(new Response(stream, { status: 200, headers }));
        return {
          write: (s) => { if (!closed) { try { controller.enqueue(encoder.encode(s)); } catch { /* cancelled */ } } },
          signal: ac.signal,
          onClose: (fn) => closers.push(fn),
        };
      },
      end: finish,
    };
    core.handle(request.method, url.pathname, body, transport)
      .catch((err) => {
        if (!settled) { settled = true; resolve(json(err.status || 500, { ok: false, error: err.status ? err.message : 'Internal error' })); }
        if (!err.status) logger.error?.('[wonder] request failed', err?.message);
      })
      .finally(() => {
        finish();
        request.signal?.removeEventListener?.('abort', abort);
        if (!settled) { settled = true; resolve(json(500, { ok: false, error: 'No response' })); }
      });
  });
}

/** A read-only static module (chatgpt-dil, wondering-genui, KaTeX) as a Response, or a 404. */
export function staticResponse(pathname, { head = false } = {}) {
  const hit = resolveStatic(pathname);
  if (!hit || hit.file.includes(`${path.sep}public${path.sep}`)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const headers = { 'Content-Type': hit.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(hit.size) };
  return new Response(head ? null : fs.readFileSync(/* turbopackIgnore: true */ hit.file), { status: 200, headers });
}

/**
 * Credentials for Claude (and YOUTUBE_API_KEY for <Video/>): Next.js already loads .env /
 * .env.local from the app folder. Like `npm start` used to, also accept ~/.config/wonder/.env (or
 * $WONDER_ENV_FILE) so the keys never have to sit next to the code. Values already in the
 * environment win (process.loadEnvFile does not overwrite them). Values are never read or logged
 * here, only handed to the SDK and the YouTube lookup.
 */
export function loadUserEnv(env = process.env) {
  const file = env.WONDER_ENV_FILE || path.join(os.homedir(), '.config', 'wonder', '.env');
  // the file may still add YOUTUBE_API_KEY (<Video/>) when the shell already has a Claude key
  if ((env.ANTHROPIC_API_KEY && env.YOUTUBE_API_KEY) || !fs.existsSync(/* turbopackIgnore: true */ file)) return;
  try {
    process.loadEnvFile(file);
    if (env.ANTHROPIC_API_KEY === 'YOUR_KEY') delete env.ANTHROPIC_API_KEY; // unedited placeholder
  } catch (e) {
    console.warn(`Could not load ${file}: ${e.message}`);
  }
}

/** One core per server process (shared by every route, kept across Next dev reloads). */
export function getWonderCore() {
  const g = globalThis;
  if (!g.__wonderCore) {
    loadUserEnv();
    g.__wonderCore = createWonderCore();
    const { mode, videos } = g.__wonderCore.status();
    console.log(`[wonder] API ready (${mode === 'claude' ? 'Claude mode' : 'demo mode: set ANTHROPIC_API_KEY to use Claude'}; videos: ${videos === 'youtube' ? 'YouTube' : videos === 'demo' ? 'demo clips (set YOUTUBE_API_KEY for live search)' : 'off'})`);
  }
  return g.__wonderCore;
}
