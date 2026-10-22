// localStorage persistence for courses, lessons (markdown + compiled dil + widget state),
// Teacher threads (messages + compiled dil + card componentResults), saved study plans,
// settings (memoryEnabled), the practice deck and XP/streak. Every storage access is wrapped: private windows and
// blocked storage fall back to an in-memory store, and quota errors prune old lessons.

import { emptyDeck, emptyStats } from './deck.js';
import { normalizeViewState, hasViewState } from './view-state.js';

const KEY = 'wonder.v1';
const MAX_LESSONS = 40;
const MAX_THREADS = 30;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('__wonder_probe', '1');
    s.removeItem('__wonder_probe');
    return { storage: s, persistent: true };
  } catch {
    return { storage: memoryStorage(), persistent: false };
  }
}

/**
 * Widget state snapshots (`viewState`, view-state.js) live on each lesson, tutor message and
 * Teacher message. Loaded snapshots are re-validated (JSON-only, size-capped); a corrupted
 * one is dropped instead of breaking the lesson.
 */
export function sanitizeViewStates(data) {
  const fix = (o) => {
    if (!o || typeof o !== 'object' || !('viewState' in o)) return;
    const v = normalizeViewState(o.viewState);
    if (hasViewState(v)) o.viewState = v; else delete o.viewState;
  };
  for (const l of Object.values(data.lessons || {})) {
    fix(l);
    for (const m of Array.isArray(l?.tutor) ? l.tutor : []) fix(m);
  }
  for (const t of data.teacherThreads || []) for (const m of Array.isArray(t?.messages) ? t.messages : []) fix(m);
  return data;
}

// ---------------------------------------------------------------- multi-tab merge
// Every tab keeps the whole state under one localStorage key. A tab's write used to replace
// the blob, wiping another tab's unrelated changes. Writes now do a three-way merge: `base`
// is the last state this tab read from (or wrote to) storage, `ours` the in-memory state,
// `theirs` what is in storage now. A record this tab changed since `base` wins; everything
// else comes from `theirs`.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MAP_KEYS = new Set(['lessons', 'teacherLessons', 'awarded', 'mastery']);
const LIST_KEYS = new Set(['courses', 'teacherThreads', 'plans']);

function mergeMap(base = {}, ours = {}, theirs = {}) {
  const out = { ...theirs };
  for (const id of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (same(ours[id], base[id])) continue; // untouched here: keep theirs (incl. their deletes)
    if (id in ours) out[id] = ours[id]; else delete out[id]; // changed or deleted here
  }
  return out;
}

function mergeList(base = [], ours = [], theirs = []) {
  const key = (x) => (x && typeof x === 'object' && 'id' in x ? x.id : JSON.stringify(x));
  const b = new Map(base.map((x) => [key(x), x]));
  const o = new Map(ours.map((x) => [key(x), x]));
  const out = [];
  const done = new Set();
  for (const t of theirs) {
    const k = key(t);
    done.add(k);
    if (o.has(k)) out.push(same(o.get(k), b.get(k)) ? t : o.get(k));
    else if (!b.has(k)) out.push(t); // added by them
    // else: deleted here
  }
  for (const x of ours) if (!done.has(key(x)) && !b.has(key(x))) out.push(x); // added here
  return out;
}

/** Three-way merge of whole Wonder states (exported for tests). */
export function mergeStates(base, ours, theirs) {
  const out = { ...theirs };
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (MAP_KEYS.has(k)) out[k] = mergeMap(base?.[k], ours[k], theirs[k]);
    else if (LIST_KEYS.has(k)) out[k] = mergeList(base?.[k], ours[k], theirs[k]);
    else out[k] = same(ours[k], base?.[k]) ? theirs[k] : ours[k];
  }
  return out;
}

export function emptyState() {
  return { version: 1, courses: [], lessons: {}, deck: emptyDeck(), stats: emptyStats(), awarded: {}, teacherThreads: [], teacherLessons: {}, plans: [], mastery: {}, settings: { memoryEnabled: true } };
}

export function createStore({ storage } = {}) {
  const picked = storage ? { storage, persistent: true } : safeStorage();
  const st = picked.storage;
  let data = emptyState();
  let lastRaw = null; // the blob this tab last read from or wrote to storage
  let base = emptyState(); // ...and its parsed form (merge base)
  const parseState = (raw) => {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    const d = { ...emptyState(), ...parsed };
    d.settings = { ...emptyState().settings, ...(parsed.settings || {}) };
    if (!Array.isArray(d.teacherThreads)) d.teacherThreads = [];
    if (!Array.isArray(d.plans)) d.plans = [];
    if (!d.lessons || typeof d.lessons !== 'object') d.lessons = {};
    try { sanitizeViewStates(d); } catch { /* keep the rest */ }
    return d;
  };
  try {
    const raw = st.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) {
        lastRaw = raw;
        data = { ...emptyState(), ...parsed };
        data.settings = { ...emptyState().settings, ...(parsed.settings || {}) };
        if (!Array.isArray(data.teacherThreads)) data.teacherThreads = [];
        if (!Array.isArray(data.plans)) data.plans = [];
        if (!data.lessons || typeof data.lessons !== 'object') data.lessons = {};
        try { sanitizeViewStates(data); } catch { /* keep the rest of the data */ }
        base = JSON.parse(JSON.stringify(data));
      }
    }
  } catch { /* corrupted or unavailable: start fresh */ }

  let timer = null;
  const listeners = new Set();

  function prune() {
    const lessons = Object.values(data.lessons).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const l of lessons.slice(MAX_LESSONS)) delete data.lessons[l.id];
    // drop tutor transcripts of the oldest half first
    for (const l of lessons.slice(Math.floor(lessons.length / 2))) if (data.lessons[l.id]) { data.lessons[l.id].tutor = []; delete data.lessons[l.id].viewState; }
    // keep the newest Teacher threads; old ones lose their compiled programs (text stays)
    data.teacherThreads = (data.teacherThreads || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, MAX_THREADS);
    for (const t of data.teacherThreads.slice(Math.floor(data.teacherThreads.length / 2))) for (const m of t.messages || []) if (m.role === 'assistant') { m.dil = null; delete m.viewState; }
  }

  /** Another tab wrote since our last read: merge our changes onto theirs. */
  function mergeFromStorage() {
    let cur = null;
    try { cur = st.getItem(KEY); } catch { return false; }
    if (cur == null || cur === lastRaw) return false;
    let theirs = null;
    try { theirs = parseState(cur); } catch { theirs = null; }
    if (!theirs) return false;
    data = mergeStates(base, data, theirs);
    return true;
  }

  function writeNow() {
    timer = null;
    const merged = mergeFromStorage();
    let raw = JSON.stringify(data);
    try {
      st.setItem(KEY, raw);
    } catch {
      try { prune(); raw = JSON.stringify(data); st.setItem(KEY, raw); } catch { /* storage full or blocked: keep in memory */ raw = null; }
    }
    if (raw != null) { lastRaw = raw; base = JSON.parse(raw); }
    if (merged) for (const l of listeners) { try { l(data); } catch {} }
  }

  // Pick up other tabs' saves while we have nothing pending (with pending writes, the merge
  // happens at write time instead).
  const onStorage = (e) => {
    if (e.key !== KEY || e.newValue == null || e.newValue === lastRaw || timer) return;
    let theirs = null;
    try { theirs = parseState(e.newValue); } catch { theirs = null; }
    if (!theirs) return;
    data = theirs;
    lastRaw = e.newValue;
    base = JSON.parse(e.newValue);
    for (const l of listeners) { try { l(data); } catch {} }
  };
  // only for the real localStorage: a passed-in storage (the signed-in account cache, tests) brings
  // its own change feed, and must not pick up the signed-out state's storage events
  if (!storage && picked.persistent && typeof globalThis.addEventListener === 'function') globalThis.addEventListener('storage', onStorage);

  return {
    persistent: picked.persistent,
    get data() { return data; },
    update(fn) {
      const r = fn(data);
      if (r && typeof r === 'object' && r !== data && r.version === 1) data = r;
      if (!timer) timer = setTimeout(writeNow, 250);
      for (const l of listeners) { try { l(data); } catch {} }
      return data;
    },
    flush() { if (timer) { clearTimeout(timer); writeNow(); } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() { data = emptyState(); base = emptyState(); lastRaw = null; try { st.removeItem?.(KEY); } catch {} writeNow(); },
    /** test hook: apply another tab's storage event */
    _onStorage: onStorage,
  };
}

export function uid(prefix = 'id') {
  const rnd = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}
