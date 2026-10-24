// Fetch + parse a conversation-source NDJSON stream with chatgpt-dil's parser/validator and
// turn reducer. Calls back per record so the UI can render each revision.
//
// Failures are classified (classifyFailure) so the screens can recover instead of losing the
// turn:
//   network   fetch / body read threw, or the body ended before its `end` record   retryable
//   stalled   no bytes for `idleMs` (the server writes a blank keep-alive line every
//             15 s, so silence means a dead connection); the request is aborted      retryable
//   http      a non-2xx response: 408/425/429/5xx/529 retryable (Retry-After honored),
//             any other 4xx is not
//   server    the stream's own `control failed` record: codes in RETRYABLE_CODES retry
//   protocol  an unparseable / unexpected body                                        no
//   aborted   the caller's signal                                                     no
// streamTurn always aborts its own request before it throws, so a retry can never overlap the
// request it replaces (no double-charging).

import { ConversationSourceParser, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';

export const STREAM_IDLE_MS = 45_000;
/** Server `control failed` codes that mean "try again", not "the request was bad". */
export const RETRYABLE_CODES = Object.freeze(['network', 'stalled', 'rate_limited', 'overloaded', 'api_error']);
export const isRetryableStatus = (s) => s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599);

export class StreamError extends Error {
  constructor(message, { kind, status, code, retryable = false, retryAfterMs = null, received = 0 } = {}) {
    super(message);
    this.name = 'StreamError';
    this.kind = kind;
    this.status = status ?? null;
    this.code = code ?? kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.received = received; // records seen before the failure
  }
}

/** Retry-After (delta-seconds or an HTTP date) in ms, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * Wait before retry number `attempt` (0-based): the server's Retry-After when it sent one,
 * else exponential backoff with full jitter in [base*2^n / 2, base*2^n]. Capped at maxMs.
 */
export function retryDelay(attempt = 0, { retryAfterMs = null, baseMs = 1000, maxMs = 30_000, random = Math.random } = {}) {
  if (retryAfterMs != null && retryAfterMs >= 0) return Math.min(maxMs, retryAfterMs);
  const ceil = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceil / 2 + random() * (ceil / 2));
}

const MESSAGES = {
  network: 'Connection lost.',
  stalled: 'The connection stalled.',
  rate_limited: 'Claude is busy right now.',
  overloaded: 'Claude is overloaded right now.',
};

/**
 * {kind, code, retryable, retryAfterMs, message} for a failure. Pass one of
 *   {aborted:true} | {stalled:true} | {status, retryAfter?, message?} | {code, retryAfterMs?, message?} (server record)
 *   | {error} (a thrown fetch/read error) | {protocol:true, message?}
 */
export function classifyFailure(f = {}) {
  if (f.aborted) return { kind: 'aborted', code: 'aborted', retryable: false, retryAfterMs: null, message: 'Stopped.' };
  if (f.stalled) return { kind: 'stalled', code: 'stalled', retryable: true, retryAfterMs: null, message: MESSAGES.stalled };
  if (f.status != null) {
    const s = Number(f.status);
    const retryable = isRetryableStatus(s);
    const code = s === 429 ? 'rate_limited' : s === 529 ? 'overloaded' : retryable ? 'http_retryable' : 'http';
    const retryAfterMs = retryable ? parseRetryAfter(f.retryAfter, f.now) : null;
    return { kind: 'http', code, status: s, retryable, retryAfterMs, message: f.message || MESSAGES[code] || `Request failed (${s})` };
  }
  if (f.code != null) {
    const code = String(f.code);
    const retryable = RETRYABLE_CODES.includes(code);
    const retryAfterMs = retryable && Number.isFinite(f.retryAfterMs) ? Math.max(0, f.retryAfterMs) : null;
    return { kind: 'server', code, retryable, retryAfterMs, message: f.message || MESSAGES[code] || 'Generation failed' };
  }
  if (f.protocol) return { kind: 'protocol', code: 'protocol', retryable: false, retryAfterMs: null, message: f.message || 'Unexpected response' };
  // anything thrown by fetch / the body reader that is not the caller's abort: a dropped connection
  return { kind: 'network', code: 'network', retryable: true, retryAfterMs: null, message: MESSAGES.network };
}

const toError = (c, received = 0) => new StreamError(c.message, { ...c, received });

/** A StreamError for the `failure` a stream returned (its control failed record). */
export const failureError = (failure) => toError(classifyFailure({ code: failure?.code || 'failed', retryAfterMs: failure?.retryAfterMs, message: failure?.message }));

// ---------------------------------------------------------------- dev-only fault injection
//
// On localhost only: ?streamFault=<target>:<kind>[:<afterRecords>[:<times>]][,...] forces a
// failure so recovery can be tried in the browser. target: lesson | tutor | teacher (matched
// against the API path); kind: drop (connection lost after N records), stall (silence after N
// records; the idle limit drops to 4 s), or an HTTP status (429 / 500 / 503 / 400 ...; 429 and
// 503 carry Retry-After: 2). times defaults to 1 per page load.
// e.g. http://localhost:8755/?streamFault=lesson:drop:40:2#/

const faultUses = new Map();
function devFault(url) {
  if (typeof location === 'undefined' || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return null;
  let spec = null;
  try { spec = new URLSearchParams(location.search).get('streamFault'); } catch { return null; }
  if (!spec) return null;
  for (const [i, part] of spec.split(',').entries()) {
    const [target, kind, after = '0', times = '1'] = part.split(':');
    if (!target || !kind || !String(url).includes(`/${target}/`)) continue;
    const key = `${i}:${part}`;
    if ((faultUses.get(key) || 0) >= Number(times)) continue;
    // a use counts only once the fault fires (a reply shorter than `after` records is not cut)
    return { kind, after: Number(after) || 0, fire: () => faultUses.set(key, (faultUses.get(key) || 0) + 1) };
  }
  return null;
}

// ---------------------------------------------------------------- streaming

export async function streamTurn(url, body, { onContent, onReasoning, onControl, signal, idleMs = STREAM_IDLE_MS, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const fault = devFault(url);
  if (fault?.kind === 'stall') idleMs = Math.min(idleMs, 4000);
  // our own controller: the stall watchdog and every failure path abort the request first
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  if (signal?.aborted) ac.abort(); else signal?.addEventListener('abort', onOuter, { once: true });
  let stalled = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    if (idleMs > 0) timer = setTimeout(() => { stalled = true; ac.abort(); }, idleMs);
  };
  let received = 0;
  const fail = (c) => { ac.abort(); throw toError(c, received); };
  const thrown = (e) => {
    if (e instanceof StreamError) return e;
    const c = signal?.aborted ? classifyFailure({ aborted: true }) : stalled ? classifyFailure({ stalled: true }) : classifyFailure({ error: e });
    return toError(c, received);
  };
  try {
    arm();
    let res;
    if (fault && /^\d{3}$/.test(fault.kind)) {
      fault.fire();
      const s = Number(fault.kind);
      res = new Response(JSON.stringify({ ok: false, error: `Simulated HTTP ${s} (streamFault)` }), { status: s, headers: { 'Content-Type': 'application/json', ...(s === 429 || s === 503 ? { 'Retry-After': '2' } : {}) } });
    } else {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: CONTENT_TYPE },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch {}
      fail(classifyFailure({ status: res.status, retryAfter: res.headers.get('retry-after'), message: msg || undefined }));
    }
    if (!(res.headers.get('content-type') || '').startsWith(CONTENT_TYPE)) fail(classifyFailure({ protocol: true, message: 'Unexpected response type' }));
    const turn = new ConversationTurn();
    let failure = null;
    let lastContent = null;
    const parser = new ConversationSourceParser((rec) => {
      received++;
      const ev = turn.apply(rec);
      if (ev.type === 'content') { lastContent = { record: rec, message: ev.message }; onContent?.(ev.message, rec); }
      else if (ev.type === 'reasoning') onReasoning?.(rec.status || {}, rec);
      else if (ev.type === 'control') {
        if (rec.detail?.kind === 'failed') {
          const c = classifyFailure({ code: rec.detail.code || 'failed', retryAfterMs: rec.detail.retryAfterMs, message: rec.detail.message });
          failure = { ...rec.detail, retryable: c.retryable, retryAfterMs: c.retryAfterMs };
        }
        onControl?.(rec.detail || {}, rec);
      }
    });
    const reader = res.body.getReader();
    // not every fetch errors its body on abort: cancel the reader too, so a stall always ends
    ac.signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (ac.signal.aborted) throw new Error('aborted'); // stalled or the caller's abort (classified below)
      if (done) break;
      arm();
      try { parser.push(decoder.decode(value, { stream: true })); } catch (e) { fail(classifyFailure({ protocol: true, message: e.message })); }
      if (fault?.kind === 'drop' && received >= fault.after) { fault.fire(); reader.cancel().catch(() => {}); fail(classifyFailure({ error: new TypeError('Simulated drop (streamFault)') })); }
      if (fault?.kind === 'stall' && received >= fault.after) {
        fault.fire();
        await new Promise((resolve) => ac.signal.addEventListener('abort', resolve, { once: true })); // the watchdog fires
      }
    }
    parser.push(decoder.decode());
    // the body closed without its terminal record: the connection was cut, not a bad reply
    try { parser.finish(); } catch { fail(classifyFailure({ error: new Error('missing end') })); }
    return { turn, message: turn.primary, failure, final: lastContent?.record };
  } catch (e) {
    ac.abort();
    throw thrown(e);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

/** Sleep for `ms`, resolving early (false) when `signal` aborts. */
export function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(t); resolve(false); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export async function postJson(url, body, { signal } = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data || data.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
