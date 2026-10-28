// Claude access: request builders, streaming, structured output, error mapping, mode detection.
//
// The Anthropic client is dependency-injected everywhere (tests pass a fake). Credentials are
// resolved by the SDK itself (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`
// profile); this module never reads, logs or forwards key values.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

export { Anthropic };
export const MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** True when the environment names a credential (value never inspected beyond non-emptiness). */
export function hasEnvCredentials(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/** True when an `ant auth login` profile credential file exists (file contents are not read). */
export function hasProfileCredentials(env = process.env) {
  try {
    const dir = env.ANTHROPIC_CONFIG_DIR || path.join(os.homedir(), '.config', 'anthropic');
    let profile = env.ANTHROPIC_PROFILE;
    if (!profile) {
      try { profile = fs.readFileSync(path.join(dir, 'active_config'), 'utf8').trim(); } catch { profile = 'default'; }
    }
    if (!/^[\w.-]+$/.test(profile || '')) return false;
    return fs.existsSync(path.join(dir, 'credentials', `${profile}.json`));
  } catch {
    return false;
  }
}

/** 'demo' | 'claude'. WONDER_MODE=demo|claude forces a mode. */
export function detectMode(env = process.env) {
  if (env.WONDER_MODE === 'demo' || env.WONDER_MODE === 'claude') return env.WONDER_MODE;
  return hasEnvCredentials(env) || hasProfileCredentials(env) ? 'claude' : 'demo';
}

export function createClaudeClient() {
  // Keys that are not scoped to a workspace must name one on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const options = workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {};
  try { return new Anthropic(options); } catch { return null; }
}

/**
 * Streaming request for lessons, tutor and Teacher turns. `system` is the static (cached)
 * prompt; `context` is per-request system text (learner memory, lesson context) placed after
 * the cache breakpoint. `tools` must be static too: they render before the system prompt, so
 * the breakpoint caches tools + system. No tool_choice: forcing a tool is a 400 on this model.
 */
export function buildStreamParams({ system, context, messages, effort = 'medium', maxTokens = 64000, tools }) {
  const sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (context) sys.push({ type: 'text', text: context });
  return {
    model: MODEL,
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: sys,
    ...(tools?.length ? { tools } : {}),
    messages,
  };
}

/** Structured-output request for small extraction calls. `user` is a string or content blocks. */
export function buildStructuredParams({ system, schema, user, effort = 'low', maxTokens = 16000, model = MODEL }) {
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  };
}

/**
 * Stream text deltas. Returns {stopReason, message}. Throws SDK errors to the caller.
 * @param {{beta:{messages:{stream:Function}}}} client
 */
/** Raised when a stream goes silent for longer than the idle limit (see idleWatch). */
export class StreamStalledError extends Error {
  constructor(idleMs) { super(`No data from Claude for ${Math.round(idleMs / 1000)}s`); this.name = 'StreamStalledError'; this.code = 'stalled'; }
}

export const STREAM_IDLE_MS = Number(process.env.WONDER_STREAM_IDLE_MS) || 120_000;

/**
 * Idle watchdog for one streaming request: an inner AbortSignal that fires when the outer
 * signal aborts or when no event arrives for `idleMs` (a silently stalled connection otherwise
 * hangs until the socket dies minutes later and surfaces as a bare TypeError).
 */
export function idleWatch(signal, idleMs = STREAM_IDLE_MS) {
  const ac = new AbortController();
  let stalled = false;
  let timer = null;
  const onAbort = () => ac.abort(signal.reason);
  if (signal) { if (signal.aborted) ac.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; ac.abort(new StreamStalledError(idleMs)); }, idleMs);
    timer.unref?.();
  };
  touch();
  return {
    signal: ac.signal,
    touch,
    get stalled() { return stalled; },
    /** Rethrow as StreamStalledError when the watchdog (not the caller) aborted the stream. */
    rethrow(err) { throw stalled ? new StreamStalledError(idleMs) : err; },
    done() { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

export async function streamText(client, params, { onText, signal, idleMs } = {}) {
  const watch = idleWatch(signal, idleMs);
  try {
    const stream = client.beta.messages.stream(params, { signal: watch.signal });
    for await (const event of stream) {
      watch.touch();
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText?.(event.delta.text);
    }
    const message = await stream.finalMessage();
    return { stopReason: message.stop_reason, message };
  } catch (err) {
    return watch.rethrow(err);
  } finally {
    watch.done();
  }
}

/** Non-streaming structured call; returns parsed JSON or throws. `options`: SDK request options ({signal, maxRetries}). */
export async function createStructured(client, params, options) {
  const message = await (options ? client.messages.create(params, options) : client.messages.create(params));
  if (message.stop_reason === 'refusal') {
    const err = new Error('Claude declined to produce this output');
    err.code = 'refusal';
    throw err;
  }
  const block = (message.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Structured response had no text block');
  return JSON.parse(block.text);
}

/** Missing/invalid credentials (before or at the first request): switch to demo mode. */
export function isCredentialError(err) {
  if (err instanceof Anthropic.AuthenticationError) return true;
  if (err instanceof Anthropic.APIError && err.status != null) return false;
  const msg = String(err?.message || '');
  return /credential|api[ _-]?key|apiKey|auth(entication)? token|could not resolve authentication/i.test(msg);
}

/** Low-level fetch/socket failures that the SDK does not wrap while a stream is being read. */
function isNetworkError(err) {
  const code = err?.code || err?.cause?.code || '';
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/.test(code)
    || (err instanceof TypeError && /terminated|fetch failed|network/i.test(String(err.message)));
}

const apiErrorType = (err) => err?.error?.error?.type || err?.error?.type || '';

/** {retryAfterMs} from an API error's Retry-After header (seconds), or {}. */
function retryAfterOf(err) {
  const h = err?.headers;
  const v = typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after'];
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? { retryAfterMs: Math.round(Math.min(n, 300) * 1000) } : {};
}

/** Map an error to a user-facing {code, message, retryAfterMs?}. Most specific class first. */
export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return { code: 'auth_failed', message: 'Claude rejected the credentials. Check ANTHROPIC_API_KEY in genui-lab/wonder/.env and restart the server.' };
  if (err instanceof Anthropic.RateLimitError) return { code: 'rate_limited', message: 'Claude is busy right now (rate limit). Wait a few seconds and try again.', ...retryAfterOf(err) };
  // 529, or an `overloaded_error` event mid-stream (no HTTP status): retryable, like a 429
  if (err instanceof Anthropic.APIError && (err.status === 529 || apiErrorType(err) === 'overloaded_error')) return { code: 'overloaded', message: 'Claude is overloaded right now. Wait a moment and try again.', ...retryAfterOf(err) };
  if (err instanceof Anthropic.BadRequestError && /anthropic-workspace-id/.test(String(err?.error?.error?.message || err.message))) return { code: 'workspace_required', message: 'This API key is not scoped to a workspace. Add ANTHROPIC_WORKSPACE_ID=wrkspc_... to ~/.config/wonder/.env and restart.' };
  if (err instanceof Anthropic.BadRequestError) return { code: 'bad_request', message: 'Claude could not process this request. Try a shorter or simpler prompt.' };
  if (err?.code === 'stalled' || err instanceof StreamStalledError) return { code: 'stalled', message: 'Claude stopped responding partway through. Resume to continue from the last complete page.' };
  if (err instanceof Anthropic.APIConnectionError || isNetworkError(err)) return { code: 'network', message: 'The connection to Claude dropped. Resume to continue from the last complete page.' };
  if (err instanceof Anthropic.APIError) return { code: 'api_error', message: `Claude had a problem${err.status ? ` (HTTP ${err.status})` : ''}. Please try again.` };
  if (err?.name === 'AbortError' || err?.code === 'aborted') return { code: 'aborted', message: 'Stopped.' };
  return { code: 'internal', message: 'Something went wrong while generating. Please try again.' };
}

/** The API's own message for a request Claude refused as invalid (HTTP 400), else null. */
export function badRequestMessage(err) {
  return err instanceof Anthropic.BadRequestError ? String(err?.error?.error?.message || err.message) : null;
}

export const REFUSAL_MESSAGE = "\n\n*I can't help with that topic. Try asking about something else you're curious about.*\n";
