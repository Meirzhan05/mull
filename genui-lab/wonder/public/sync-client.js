// Account sync, browser side: keeps the signed-in store (store.js over the IndexedDB cache) and
// the server's per-user records (POST /api/sync) in step. No DOM: tested under node:test with a
// fake transport that calls the server's sync service directly.
//
// The base is the multi-tab merge's idea applied to the server: for every record, the revision
// and hash of the version this browser last saw on the server ({rev, h}, sync-core.js hashData).
// A round:
//   1. snapshot the state as records and diff it against the base: new or edited records and
//      tombstones for deleted ones, each carrying the revision it was based on;
//   2. send them (in chunks under the body limit) with the cursor, and take back every record
//      newer than the cursor plus the server's answer to each change;
//   3. for each record from the server: it becomes the base; it replaces the local copy unless
//      that copy was edited while the round was in flight (then the edit is pushed next round,
//      against the new base, and the server sees it as the later change).
// The first round of a new account in this browser is special (see beginAccount in account.js):
//   'pull'  take the server's state as it is (local data is an empty start)
//   'merge' this browser's anonymous data is being added to the account: server records fill in
//           what is missing, settings / stats / awarded merge, local records stay and are pushed

import { toRecords, recordData, applyRecords, diffRecords, hashData, recordKey, mergeRecord, byteLength, DELETED_HASH } from './sync-core.js';
import { createStore } from './store.js';

export const BASE_KEY = 'wonder.sync';
export const CHUNK_BYTES = 2.5 * 1024 * 1024; // UTF-8 bytes per request (server limit 4 MB)
export const MAX_RECORD_BYTES = 3 * 1024 * 1024;
const STATE_KEY = 'wonder.v1'; // store.js KEY

/** `userId`'s sync base in `storage`: the cursor, what the server last sent, and a pending first round. */
function readBase(storage, userId) {
  try {
    const p = JSON.parse(storage.getItem(BASE_KEY) || 'null');
    if (p && p.userId === userId) return { since: Number(p.since) || 0, base: new Map(p.base || []), first: p.first || null };
  } catch { /* corrupt: start over (a full pull, then re-push whatever differs) */ }
  return { since: 0, base: new Map(), first: null };
}

/**
 * The cache was seeded for `userId` (beginAccount in account.js) and its first round has not
 * finished: it does not hold the account's lessons or settings yet.
 */
export function awaitsFirstSync(storage, userId) {
  return !!readBase(storage, userId).first;
}

/**
 * @param {{store: object, storage: {getItem, setItem}, userId: string,
 *   post: (body: object) => Promise<object>, now?: () => number,
 *   lock?: (fn: () => Promise<any>) => Promise<any>, onStatus?: (s: object) => void,
 *   onFirstSync?: (mode: string) => void, logger?: Console}} opts
 */
export function createSyncEngine({ store, storage, userId, post, now = () => Date.now(), lock = (fn) => fn(), onStatus = () => {}, onFirstSync = () => {}, logger = console }) {
  let state = load();
  let applying = false;
  let running = null;
  let again = false;
  let timer = null;
  let stopped = false;
  let status = { state: 'idle', at: null, error: null };

  function load() { return readBase(storage, userId); }
  function save() {
    storage.setItem(BASE_KEY, JSON.stringify({ userId, since: state.since, base: [...state.base], first: state.first }));
  }
  const setStatus = (s) => { status = { ...status, ...s }; try { onStatus(status); } catch {} };

  /** Apply server records; `snap` holds each record's hash when the round's snapshot was taken. */
  function adopt(records, snap, first) {
    const toApply = [];
    for (const r of records) {
      const key = recordKey(r.kind, r.id);
      const remoteH = r.deleted ? DELETED_HASH : hashData(r.data);
      const local = recordData(store.data, r.kind, r.id);
      const localH = hashData(local);
      const seen = { rev: Number(r.rev) || 0, h: remoteH };
      if (localH === remoteH) { state.base.set(key, seen); continue; }
      if (first === 'pull') { state.base.set(key, seen); toApply.push(r); continue; }
      if (first === 'merge') {
        if (local === undefined) { state.base.set(key, seen); if (!r.deleted) toApply.push(r); continue; }
        if (r.kind === 'state' && !r.deleted) { state.base.set(key, seen); toApply.push({ ...r, data: mergeRecord('state', r.id, { data: local, updatedAt: 0 }, { data: r.data, updatedAt: 1 }).data }); continue; }
        continue; // both have it: the local version goes up against no base, so the server merges the two
      }
      // edited during the round: keep ours, and keep the old base, so the next push is a
      // concurrent change the server merges (activity, evidence) rather than a plain overwrite
      if (localH !== (snap.get(key) ?? DELETED_HASH)) continue;
      state.base.set(key, seen);
      toApply.push(r);
    }
    if (!toApply.length) return 0;
    applying = true;
    try { store.update((d) => { applyRecords(d, toApply); return d; }); } finally { applying = false; }
    return toApply.length;
  }

  async function round() {
    state = load(); // another tab of this account may have synced since
    const first = state.first;
    const snapshot = toRecords(store.data);
    const snap = new Map([...snapshot].map(([k, r]) => [k, hashData(r.data)]));
    const sizes = new Map();
    const changes = first ? [] : diffRecords(state.base, snapshot, now()).filter((c) => {
      if (c.deleted) return true;
      const n = byteLength(JSON.stringify(c.data));
      sizes.set(c, n);
      if (n > MAX_RECORD_BYTES) logger.warn?.(`[wonder] ${c.kind} ${c.id} is too large to sync; it stays in this browser`);
      return n <= MAX_RECORD_BYTES;
    });
    const chunks = [];
    let cur = [];
    let size = 0;
    for (const full of changes) {
      const { h: _h, ...c } = full;
      const n = (sizes.get(full) || 0) + 200;
      if (cur.length && size + n > CHUNK_BYTES) { chunks.push(cur); cur = []; size = 0; }
      cur.push(c);
      size += n;
    }
    if (cur.length) chunks.push(cur);
    let i = 0;
    let more = false;
    let pulled = 0;
    let applied = 0;
    do {
      const res = await post({ userId, since: state.since, changes: chunks[i++] || [] });
      if (!res?.ok) throw Object.assign(new Error(res?.error || 'Sync failed'), { status: res?.status });
      applied += adopt([...(res.records || []), ...(res.current || [])], snap, first);
      pulled += (res.records || []).length;
      state.since = Number(res.rev) || state.since;
      more = !!res.more;
      save(); // progress survives a closed tab
    } while (more || i < chunks.length);
    if (first) { state.first = null; save(); }
    return { pushed: changes.length, pulled, applied, first };
  }

  async function syncNow() {
    if (running) { again = true; return running; }
    clearTimeout(timer);
    setStatus({ state: 'syncing' });
    running = (async () => {
      try {
        let r = await lock(round);
        let applied = r.applied;
        if (r.first) { onFirstSync(r.first); r = await lock(round); applied += r.applied; } // push what the first round kept local
        setStatus({ state: 'synced', at: now(), error: null, applied });
        return r;
      } catch (e) {
        const offline = !e.status && globalThis.navigator?.onLine === false;
        // 410: the account was deleted (on another device) since this browser last synced
        setStatus({ state: e.status === 409 ? 'mismatch' : e.status === 401 ? 'signedOut' : e.status === 410 ? 'deleted' : offline ? 'offline' : 'error', error: e.message });
        if (e.status !== 409 && e.status !== 401 && e.status !== 410) schedule(30_000);
        return null;
      } finally {
        running = null;
        if (again) { again = false; schedule(300); }
      }
    })();
    return running;
  }

  function schedule(ms = 2000) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(syncNow, ms);
  }

  const unsubscribe = store.subscribe?.(() => { if (!applying) schedule(); });

  return {
    syncNow,
    schedule,
    get status() { return status; },
    /** Local changes not yet on the server. */
    pending() { return diffRecords(load().base, toRecords(store.data)).length; },
    stop() { stopped = true; clearTimeout(timer); unsubscribe?.(); },
  };
}

/**
 * The first round of a cache just seeded for `userId`, run before the page reloads into it
 * (beginAccount), so the page opens on the account's lessons and settings instead of an empty
 * start. Gives up after `timeoutMs` and puts the cache back as seeded (the page's own engine then
 * does the first round); writes from a round still in flight are dropped, so the base never
 * gets ahead of the data.
 * @returns {Promise<boolean>} whether the round finished
 */
export async function syncBeforeOpening({ storage, userId, post, lock, timeoutMs = 10_000, logger = console }) {
  const seeded = [STATE_KEY, BASE_KEY].map((k) => [k, storage.getItem(k)]);
  let open = true;
  const guarded = {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => { if (open) storage.setItem(k, v); },
    removeItem: (k) => { if (open) storage.removeItem?.(k); },
  };
  const store = createStore({ storage: guarded });
  let state = null;
  const engine = createSyncEngine({ store, storage: guarded, userId, post, lock, logger, onStatus: (s) => { state = s.state; } });
  let timer;
  await Promise.race([engine.syncNow(), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
  clearTimeout(timer);
  engine.stop();
  const done = state === 'synced';
  if (done) store.flush();
  open = false;
  if (!done) for (const [k, v] of seeded) { if (v == null) storage.removeItem?.(k); else storage.setItem(k, v); }
  return done;
}
