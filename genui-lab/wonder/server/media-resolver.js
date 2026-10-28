// Server-resolved media components: one stream's lookups, delivered as componentResults entries
// keyed by each component's __resolutionId so they ride in every dil revision and are saved with
// the lesson. videos.js configures one for <Video/>; app.js combines it with the Figure resolver
// (figures.js, which adds a vision check) per stream.
//
//   compile result ──componentResults(r)──▶ {rid: {status:'pending'}}  (lookup starts)
//   lookup settles ──onUpdate──▶ writer.refresh()  ──▶ {rid: {status:'resolved', state:{found, …}}}
//   before complete: settle(ms) then finalize()  (anything still pending -> not found)

import { constRef } from './dil-constants.js';

export const MISS_TTL_MS = 10 * 60 * 1000; // a "nothing found" is retried after this
const CACHE_MAX = 300;

const remember = (cache, k, state, now) => { cache.delete(k); cache.set(k, { state, at: now }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };
/** A cache entry ({state}) that is still good: found results stay, a miss expires after missTtlMs. */
const cached = (cache, k, now, missTtlMs) => {
  const e = cache.get(k);
  if (!e) return undefined;
  if (e.state == null && now - e.at > missTtlMs) { cache.delete(k); return undefined; }
  return e;
};

/**
 * One stream's lookups for one component. `refOf(get)` reads the lookup reference from the
 * compiled props (`get(key)` returns a prop's hoisted constant) or returns null to skip it;
 * `keyOf(ref)` is its cache key. `lookup(ref, {signal})` resolves to a found state or null, or is
 * null itself to resolve everything as not found (no network: tests, WONDER_*=off). `cache`
 * (key -> {state, at}) is shared by the server's streams, so a steer or a later revision does not
 * look the same thing up again. A failed or aborted lookup is not cached (the next stream
 * retries it), and a "nothing found" expires after missTtlMs. `signal` (the stream's) cancels
 * lookups when the learner leaves. `label` is what the stream says while waiting for it.
 */
export function createLookupResolver({ component, refOf, keyOf, lookup, label = 'Finding media…', logger = console, cache = new Map(), signal, missTtlMs = MISS_TTL_MS, now = () => Date.now() }) {
  const callRe = new RegExp(`__dil\\.jsx\\(${component},\\{([^{}]*)\\}`, 'g');
  const inflight = new Map(); // key -> Promise
  const failed = new Set(); // keys whose lookup threw in this stream
  const listeners = new Set();
  let final = false;

  function start(ref, k) {
    if (cached(cache, k, now(), missTtlMs) || inflight.has(k) || failed.has(k)) return;
    if (!lookup || signal?.aborted) { failed.add(k); return; }
    const p = Promise.resolve()
      .then(() => lookup(ref, { signal }))
      .then((state) => {
        if (!state) logger.info?.(`[wonder] ${component.toLowerCase()} not found (${ref.file || ref.query})`);
        remember(cache, k, state || null, now());
      }, (err) => {
        if (!signal?.aborted) logger.warn?.(`[wonder] ${component.toLowerCase()} lookup failed (${ref.file || ref.query}): ${err?.message || err}`);
        failed.add(k);
      })
      .then(() => {
        inflight.delete(k);
        if (!final) for (const fn of listeners) fn();
      });
    inflight.set(k, p);
  }

  return {
    label,
    /** componentResults for every such component in a compiled program; starts new lookups. */
    componentResults(result) {
      const out = {};
      if (!result?.code || !result.code.includes(`${component},`)) return out;
      callRe.lastIndex = 0;
      let m;
      while ((m = callRe.exec(result.code))) {
        const body = m[1];
        const get = (key) => { const i = constRef(body, key); return i == null ? undefined : result.constants?.[i]; };
        const rid = get('__resolutionId');
        const ref = typeof rid === 'string' ? refOf(get) : null;
        if (!ref) continue;
        const k = keyOf(ref);
        start(ref, k);
        const hit = cached(cache, k, now(), missTtlMs);
        if (hit) out[rid] = { status: 'resolved', state: hit.state || { found: false } };
        else out[rid] = final || failed.has(k) ? { status: 'resolved', state: { found: false } } : { status: 'pending' };
      }
      return out;
    },
    /** Wait (at most `ms`) for the lookups in flight. */
    async settle(ms = 6000) {
      if (!inflight.size) return;
      let timer;
      await Promise.race([Promise.allSettled([...inflight.values()]), new Promise((r) => { timer = setTimeout(r, ms); })]);
      clearTimeout(timer);
    },
    /** From now on an unresolved component reports "not found" instead of "pending". */
    finalize() { final = true; listeners.clear(); },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get pending() { return inflight.size; },
  };
}

/** Several resolvers as one (same interface); `label` names what is still pending. */
export function combineResolvers(list) {
  const all = list.filter(Boolean);
  return {
    componentResults: (result) => Object.assign({}, ...all.map((r) => r.componentResults(result))),
    settle: (ms) => Promise.all(all.map((r) => r.settle(ms))).then(() => {}),
    finalize() { for (const r of all) r.finalize(); },
    onUpdate(fn) { const offs = all.map((r) => r.onUpdate(fn)); return () => offs.forEach((off) => off()); },
    get pending() { return all.reduce((n, r) => n + r.pending, 0); },
    get label() { const ls = all.filter((r) => r.pending).map((r) => r.label); return ls.length === 1 ? ls[0] : 'Finding images and videos…'; },
  };
}

/** Merge a resolver's componentResults into another appData factory's output. */
export function withResolved(appDataFor, resolver) {
  return (result) => {
    const base = appDataFor ? appDataFor(result) : null;
    const op = base?.opGenui || {};
    return { ...(base || {}), opGenui: { modelDataBindings: {}, ...op, componentResults: { ...(op.componentResults || {}), ...resolver.componentResults(result) } } };
  };
}
