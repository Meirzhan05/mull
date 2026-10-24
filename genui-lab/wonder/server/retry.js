// Recoverable streams, server side (the client half is public/stream-client.js).
//
//   createInflight()     one live upstream request per retry key. A lesson / tutor / Teacher
//                        request may carry `streamKey` (the lesson id, or the learner turn's
//                        id); a new request with the same key aborts the older one before it
//                        starts, so a retry can never run alongside the attempt it replaces,
//                        even when the old socket has not closed yet (no double-charging).
//   createTurnLedger()   the Teacher's tool calls per learner turn (`turnId`). A retried turn
//                        re-runs the tool loop; a call that already ran in an earlier attempt
//                        (same tool, same key arguments) returns its recorded result and the
//                        same card resolution id instead of running again, so remember /
//                        forget never apply twice and a card keeps its id and its state.

import { newResolutionId } from './teacher.js';

export const KEY_RE = /^[\w:-]{8,120}$/;
export const cleanKey = (v) => (typeof v === 'string' && KEY_RE.test(v) ? v : null);

export function createInflight() {
  const live = new Map();
  return {
    /** Abort any request holding `key`, then hold it. Returns {signal, release()}. */
    claim(key) {
      const prev = live.get(key);
      if (prev) prev.ctrl.abort();
      const entry = { ctrl: new AbortController() };
      live.set(key, entry);
      return {
        signal: entry.ctrl.signal,
        release() { if (live.get(key) === entry) live.delete(key); },
      };
    },
    has: (key) => live.has(key),
    get size() { return live.size; },
  };
}

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Ledger key for a tool call, or null for read-only tools (always re-run). */
export function toolCallKey(name, input = {}) {
  switch (name) {
    case 'create_lesson': return `create_lesson ${JSON.stringify({ topic: norm(input.topic), level: input.level })}`;
    case 'plan_study': return `plan_study ${JSON.stringify({ goal: norm(input.goal), deadline: input.deadline || '' })}`;
    case 'quiz_me': return `quiz_me ${JSON.stringify({ topic: norm(input.topic) })}`;
    case 'remember': return `remember ${JSON.stringify({ fact: norm(input.fact) })}`;
    case 'forget': return `forget ${JSON.stringify({ id: String(input.id ?? '') })}`;
    default: return null; // get_progress
  }
}

/** The arguments a retried turn should repeat to get a recorded call back (shown to the model). */
function keyArgs(name, input = {}) {
  switch (name) {
    case 'create_lesson': return { topic: input.topic, level: input.level };
    case 'plan_study': return { goal: input.goal, deadline: input.deadline || '' };
    case 'quiz_me': return { topic: input.topic };
    case 'remember': return { fact: input.fact, kind: input.kind };
    case 'forget': return { id: input.id };
    default: return input;
  }
}

export function createTurnLedger({ max = 200, ttlMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const turns = new Map(); // turnId -> {at, attempts, calls: Map(key -> {name, args, result, rid})}
  const prune = () => {
    const t = now();
    for (const [id, e] of turns) if (t - e.at > ttlMs) turns.delete(id);
    while (turns.size > max) turns.delete(turns.keys().next().value);
  };
  return {
    /** Start an attempt of turn `turnId`. */
    open(turnId) {
      prune();
      let e = turns.get(turnId);
      if (!e) { e = { at: now(), attempts: 0, calls: new Map() }; turns.set(turnId, e); }
      e.attempts++;
      e.at = now();
      const turn = {
        attempt: e.attempts,
        /** Calls recorded by earlier attempts (for the retry note). */
        get recorded() { return [...e.calls.values()].map(({ name, args }) => ({ name, args })); },
        /** Wrap a toolkit `execute`: a recorded call is replayed, a new one runs and is recorded. */
        wrap(execute) {
          return async (name, input) => {
            const key = toolCallKey(name, input);
            const hit = key && e.calls.get(key);
            if (hit) {
              const r = structuredClone(hit.result);
              if (r.card) r.card = { ...r.card, rid: hit.rid, replayed: true };
              return { ...r, replayed: true };
            }
            const r = await execute(name, input);
            if (key && !r.isError) {
              const rid = r.card ? newResolutionId() : null;
              if (r.card) r.card = { ...r.card, rid };
              e.calls.set(key, { name, args: keyArgs(name, input), result: structuredClone(r), rid });
            }
            return r;
          };
        },
      };
      return turn;
    },
    has: (turnId) => turns.has(turnId),
    get size() { return turns.size; },
  };
}

/** Context for a retried Teacher turn whose earlier attempt already ran tools. */
export function retryNote(recorded) {
  if (!recorded.length) return '';
  const lines = recorded.map((c) => `- ${c.name} ${JSON.stringify(c.args)}`);
  return [
    'This reply is a retry: your previous attempt at it was cut off by a connection problem, and the learner never saw it finish. These tool calls already ran in that attempt and their effects are kept:',
    ...lines,
    'If this reply needs one of them, call it again with exactly these arguments: it returns the earlier result and card without running twice. Do not mention the retry.',
  ].join('\n');
}
