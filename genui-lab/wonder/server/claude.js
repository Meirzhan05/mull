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
  try { return new Anthropic(); } catch { return null; }
}

/**
 * Streaming request for lessons and tutor turns. `system` is the static (cached) prompt;
 * `context` is per-request system text placed after the cache breakpoint.
 */
export function buildStreamParams({ system, context, messages, effort = 'medium', maxTokens = 64000 }) {
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
    messages,
  };
}

/** Structured-output request for small extraction calls. */
export function buildStructuredParams({ system, schema, user, effort = 'low', maxTokens = 16000 }) {
  return {
    model: MODEL,
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
export async function streamText(client, params, { onText, signal } = {}) {
  const stream = client.beta.messages.stream(params, signal ? { signal } : undefined);
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText?.(event.delta.text);
  }
  const message = await stream.finalMessage();
  return { stopReason: message.stop_reason, message };
}

/** Non-streaming structured call; returns parsed JSON or throws. */
export async function createStructured(client, params) {
  const message = await client.messages.create(params);
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

/** Map an error to a user-facing {code, message}. Most specific class first. */
export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return { code: 'auth_failed', message: 'Claude rejected the credentials. Check ANTHROPIC_API_KEY in genui-lab/wonder/.env and restart the server.' };
  if (err instanceof Anthropic.RateLimitError) return { code: 'rate_limited', message: 'Claude is busy right now (rate limit). Wait a few seconds and try again.' };
  if (err instanceof Anthropic.BadRequestError) return { code: 'bad_request', message: 'Claude could not process this request. Try a shorter or simpler prompt.' };
  if (err instanceof Anthropic.APIError) return { code: 'api_error', message: `Claude had a problem${err.status ? ` (HTTP ${err.status})` : ''}. Please try again.` };
  if (err?.name === 'AbortError' || err?.code === 'aborted') return { code: 'aborted', message: 'Stopped.' };
  return { code: 'internal', message: 'Something went wrong while generating. Please try again.' };
}

export const REFUSAL_MESSAGE = "\n\n*I can't help with that topic. Try asking about something else you're curious about.*\n";
