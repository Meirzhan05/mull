// Persisted widget state for DIL surfaces: Wonder's take on ChatGPT's DILStatePersistence
// (`DIL.useState(initial, {key, widgetId})`, one snapshot per widget, `viewState` on the content
// record, `setStateSnapshot` main -> worker; chatgpt-findings §3.1–3.2).
//
// chatgpt-dil's runtime ignores useState's options and has no snapshot API, so the store lives
// in Wonder's runtime wrapper (learning-runtime.js) and reaches the in-sandbox catalog through
// a non-enumerable `appData.__wonderViewState`. Catalog components opt in with
// `useSaved(props, key, initial, restore)` (createUseSaved below, injected as source text).
//
// Snapshot (JSON, stored with the lesson / tutor message / Teacher message as `viewState`):
//   { v: 1, c: { [resolutionId]: { h: <props signature>, t: <write sequence>, s: { [key]: value } } } }
// - resolutionId comes from the compiler: (name, ordinal, messageId salt), stable across
//   streamed revisions, reloads and continuations of one message.
// - `h` fingerprints the component's props, so a component rewritten in place by a revision
//   (same id, different content) does not inherit the old widget's state.
// - values are JSON-only and size-capped; the oldest entries are evicted past MAX_VIEW_STATE_BYTES.

export const VIEW_STATE_VERSION = 1;
export const MAX_VIEW_STATE_BYTES = 50_000; // per surface (one lesson, one message)
export const MAX_VALUE_BYTES = 8_000; // one widget key
export const VIEW_STATE_DEBOUNCE_MS = 300;
const MAX_DEPTH = 6;
const MAX_KEYS = 200;

export const emptyViewState = () => ({ v: VIEW_STATE_VERSION, c: {} });

/** A JSON-safe deep copy of `v`, or undefined when it is not representable (fn, NaN, cycles, too deep). */
export function jsonSafe(v, depth = 0) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'object' || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) {
    if (v.length > MAX_KEYS) return undefined;
    const out = [];
    for (const x of v) { const c = jsonSafe(x, depth + 1); if (c === undefined) return undefined; out.push(c); }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const keys = Object.keys(v);
  if (keys.length > MAX_KEYS) return undefined;
  const out = {};
  for (const k of keys) {
    if (v[k] === undefined) continue;
    const c = jsonSafe(v[k], depth + 1);
    if (c === undefined) return undefined;
    out[k] = c;
  }
  return out;
}

function stable(v, depth = 0) {
  if (depth > 12) return 'null';
  if (Array.isArray(v)) return '[' + v.map((x) => stable(x, depth + 1)).join(',') + ']';
  if (v && typeof v === 'object') {
    if (v.$$dil) return '"<el>"';
    return '{' + Object.keys(v).sort().filter((k) => typeof v[k] !== 'function' && v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k], depth + 1)).join(',') + '}';
  }
  if (typeof v === 'function' || v === undefined) return 'null';
  return JSON.stringify(v);
}

/** Fingerprint of a component's content props (not children, callbacks or its resolution id). */
export function propsSignature(props) {
  const p = {};
  for (const k of Object.keys(props || {})) if (k !== 'children' && k !== '__resolutionId' && k !== 'key') p[k] = props[k];
  const s = stable(p);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(36) + h2.toString(36) + s.length.toString(36);
}

const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };
export const viewStateSize = (snap) => sizeOf(snap);

/** Tolerant parse of a persisted snapshot: anything malformed is dropped, never thrown. */
export function normalizeViewState(raw) {
  let snap = raw;
  if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch { return emptyViewState(); } }
  const out = emptyViewState();
  if (!snap || typeof snap !== 'object' || snap.v !== VIEW_STATE_VERSION || !snap.c || typeof snap.c !== 'object' || Array.isArray(snap.c)) return out;
  for (const [rid, e] of Object.entries(snap.c)) {
    if (!rid || rid.length > 120 || !e || typeof e !== 'object' || typeof e.h !== 'string' || !e.s || typeof e.s !== 'object' || Array.isArray(e.s)) continue;
    const s = {};
    for (const [k, v] of Object.entries(e.s)) {
      const c = jsonSafe(v);
      if (c !== undefined && sizeOf(c) <= MAX_VALUE_BYTES) s[k] = c;
    }
    if (Object.keys(s).length) out.c[rid] = { h: e.h, t: Number.isFinite(e.t) ? e.t : 0, s };
  }
  return capViewState(out);
}

/** Evict the least recently written widgets until the snapshot fits in `max` bytes. */
export function capViewState(snap, max = MAX_VIEW_STATE_BYTES) {
  if (sizeOf(snap) <= max) return snap;
  const c = { ...snap.c };
  const order = Object.keys(c).sort((a, b) => (c[a].t || 0) - (c[b].t || 0));
  const out = { v: VIEW_STATE_VERSION, c };
  for (const rid of order) {
    if (sizeOf(out) <= max) break;
    delete c[rid];
  }
  return out;
}

/**
 * Keep only widgets whose resolution id is in `keep` (a Set or array of the ids in the current
 * program) and, when `live` (rid -> current props signature) is given, whose props are unchanged.
 */
export function pruneViewState(snap, keep, live = null) {
  const s = normalizeViewState(snap);
  const ids = keep instanceof Set ? keep : new Set(keep || []);
  for (const [rid, e] of Object.entries(s.c)) {
    if (!ids.has(rid) || (live && live[rid] && live[rid] !== e.h)) delete s.c[rid];
  }
  return s;
}

export const hasViewState = (snap) => !!(snap && snap.c && Object.keys(snap.c).length);

/**
 * The worker-side store. `api` is what the sandbox sees (read/write/touch); every write is
 * debounced into one `onChange(snapshot)` call.
 */
export function createViewStateStore({ initial, onChange = () => {}, debounceMs = VIEW_STATE_DEBOUNCE_MS, maxBytes = MAX_VIEW_STATE_BYTES, timers = globalThis } = {}) {
  let snap = normalizeViewState(initial);
  let seq = 0;
  let timer = null;
  let live = {}; // rid -> props signature of the mounted widget (last render)
  let seen = {}; // rid -> prop values of the last signature (identity cache: hoisted constants are reused)
  const reseq = () => { seq = Object.values(snap.c).reduce((m, e) => Math.max(m, e.t || 0), 0); };
  reseq();

  const snapshot = () => JSON.parse(JSON.stringify(capViewState(snap, maxBytes)));
  function emit() {
    timer = null;
    snap = capViewState(snap, maxBytes);
    try { onChange(snapshot()); } catch { /* host callback failure must not break the sandbox */ }
  }
  function schedule() {
    if (timer != null) return;
    timer = debounceMs > 0 ? timers.setTimeout(emit, debounceMs) : (emit(), null);
  }
  const ridOf = (props) => (props && typeof props.__resolutionId === 'string' && props.__resolutionId ? props.__resolutionId : null);

  /** Current props signature of a widget; recomputed only when a prop value changed identity. */
  function sigOf(rid, props) {
    const vals = Object.keys(props).filter((k) => k !== 'children').flatMap((k) => [k, props[k]]);
    const prev = seen[rid];
    if (prev && live[rid] && prev.length === vals.length && prev.every((v, i) => v === vals[i])) return live[rid];
    seen[rid] = vals;
    return (live[rid] = propsSignature(props));
  }

  const api = Object.freeze({
    /** Called on every render of a persisted widget: records its live props signature. */
    touch(props) { const rid = ridOf(props); if (rid) sigOf(rid, props); },
    /** Saved value for (widget, key), or undefined (no entry, other props, unknown key). */
    read(props, key) {
      const rid = ridOf(props);
      if (!rid) return undefined;
      const sig = sigOf(rid, props);
      const e = snap.c[rid];
      if (!e) return undefined;
      if (e.h !== sig) { delete snap.c[rid]; schedule(); return undefined; } // the widget was rewritten
      const v = e.s[String(key)];
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    write(props, key, value) {
      const rid = ridOf(props);
      if (!rid) return false;
      const v = jsonSafe(value);
      if (v === undefined || sizeOf(v) > MAX_VALUE_BYTES) return false;
      const sig = sigOf(rid, props);
      let e = snap.c[rid];
      if (!e || e.h !== sig) e = snap.c[rid] = { h: sig, t: 0, s: {} };
      e.s[String(key)] = v;
      e.t = ++seq;
      schedule();
      return true;
    },
  });

  return {
    api,
    snapshot,
    /** setStateSnapshot: replace the saved map (before the first render, or after a prune/reset). */
    load(next) { snap = normalizeViewState(next); reseq(); },
    prune(keep) {
      const before = JSON.stringify(snap);
      snap = pruneViewState(snap, keep, live);
      if (JSON.stringify(snap) !== before) schedule();
    },
    clear() { snap = emptyViewState(); seq = 0; if (timer != null) { timers.clearTimeout(timer); timer = null; } emit(); },
    /** Deliver a pending debounced change now. */
    flush() { if (timer != null) { timers.clearTimeout(timer); emit(); } },
    pending: () => timer != null,
    cancel() { if (timer != null) { timers.clearTimeout(timer); timer = null; } },
  };
}

/**
 * In-sandbox hook (injected as source text, so it must stay self-contained):
 *   const [i, setI] = useSaved(props, 'i', 0, (saved, init) => valid(saved) ? saved : undefined)
 * Starts from the saved value when the snapshot has one for this widget (and `restore` accepts
 * it), else from `initial`; every set also writes the snapshot. Without a resolution id or a
 * store it is plain DIL.useState.
 */
export function createUseSaved(DIL) {
  return function useSaved(props, key, initial, restore) {
    const vs = DIL.useAppData((ad) => (ad && ad.__wonderViewState) || null);
    const ref = DIL.useRef(null);
    const [val, setVal] = DIL.useState(() => {
      const init = typeof initial === 'function' ? initial() : initial;
      const saved = vs ? vs.read(props, key) : undefined;
      if (saved === undefined) return init;
      let r;
      try { r = restore ? restore(saved, init) : saved; } catch { r = undefined; }
      return r === undefined ? init : r;
    });
    if (!ref.current) ref.current = { value: val };
    const r = ref.current;
    r.value = val;
    r.props = props;
    r.vs = vs;
    if (vs) vs.touch(props);
    const set = DIL.useCallback((v) => {
      const nv = typeof v === 'function' ? v(r.value) : v;
      r.value = nv;
      setVal(nv);
      if (r.vs) r.vs.write(r.props, key, nv);
    }, []);
    return [val, set];
  };
}
