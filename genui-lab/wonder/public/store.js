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

export function emptyState() {
  return { version: 1, courses: [], lessons: {}, deck: emptyDeck(), stats: emptyStats(), awarded: {}, teacherThreads: [], teacherLessons: {}, plans: [], settings: { memoryEnabled: true } };
}

export function createStore({ storage } = {}) {
  const picked = storage ? { storage, persistent: true } : safeStorage();
  const st = picked.storage;
  let data = emptyState();
  try {
    const raw = st.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) {
        data = { ...emptyState(), ...parsed };
        data.settings = { ...emptyState().settings, ...(parsed.settings || {}) };
        if (!Array.isArray(data.teacherThreads)) data.teacherThreads = [];
        if (!Array.isArray(data.plans)) data.plans = [];
        if (!data.lessons || typeof data.lessons !== 'object') data.lessons = {};
        try { sanitizeViewStates(data); } catch { /* keep the rest of the data */ }
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

  function writeNow() {
    timer = null;
    try {
      st.setItem(KEY, JSON.stringify(data));
    } catch {
      try { prune(); st.setItem(KEY, JSON.stringify(data)); } catch { /* storage full or blocked: keep in memory */ }
    }
  }

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
    reset() { data = emptyState(); writeNow(); },
  };
}

export function uid(prefix = 'id') {
  const rnd = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}
