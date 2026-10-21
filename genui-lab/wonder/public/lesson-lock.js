// Cross-tab lesson lock. Only one tab may stream, resume or revise a lesson at a time (each
// stream writes the lesson to localStorage, so two writers would clobber each other).
//
//   Web Locks (preferred): navigator.locks.request(`wonder-lesson-${id}`, {ifAvailable:true}, …)
//     held for the whole stream; the browser releases it if the tab closes or crashes.
//   Lease fallback (no navigator.locks): localStorage `wonder.lock.<id>` = {owner, expires},
//     a ~10 s lease renewed every ~3 s and removed on release / pagehide. An expired lease is free.
//     Acquiring claims on the channel, writes, waits a ~120 ms settle window and re-checks, so two
//     tabs racing for a free lease cannot both win.
//
// A tab that cannot get the lock shows "being written in another tab" and calls watch(): it is
// told when the lock is free again (a BroadcastChannel 'wonder' message, the storage event on
// the lease key, or a poll every few seconds as a backstop).
//
// Everything is injectable (locks, storage, clock, timers, channel, event target) so the logic
// runs under node:test. No DOM access beyond the optional event target.

export const LOCK_PREFIX = 'wonder-lesson-';
export const LEASE_PREFIX = 'wonder.lock.';
export const LEASE_TTL_MS = 10000;
export const LEASE_RENEW_MS = 3000;
export const CHANNEL_NAME = 'wonder';
export const LEASE_SETTLE_MS = 120; // lease fallback: wait this long after writing before checking who won

export const lockName = (lessonId) => `${LOCK_PREFIX}${lessonId}`;
export const leaseKey = (lessonId) => `${LEASE_PREFIX}${lessonId}`;

function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s) { s.getItem('__wonder_lock_probe'); return s; }
  } catch { /* blocked */ }
  return null;
}

function defaultChannel() {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null; } catch { return null; }
}

const randomOwner = () => `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * @param {{locks?:object|null, storage?:Storage|null, owner?:string, now?:()=>number,
 *   timers?:{setInterval:Function, clearInterval:Function}, channel?:object|null,
 *   target?:EventTarget|null, ttlMs?:number, renewMs?:number, settleMs?:number,
 *   sleep?:(ms:number)=>Promise<void>, ticket?:()=>number}} [opts]
 */
export function createLessonLocks(opts = {}) {
  const locks = 'locks' in opts ? opts.locks : (globalThis.navigator?.locks ?? null);
  const storage = 'storage' in opts ? opts.storage : defaultStorage();
  const owner = opts.owner || randomOwner();
  const now = opts.now || (() => Date.now());
  const timers = opts.timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h) };
  const channel = 'channel' in opts ? opts.channel : defaultChannel();
  const target = 'target' in opts ? opts.target : (typeof window !== 'undefined' ? window : null);
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const renewMs = opts.renewMs ?? LEASE_RENEW_MS;
  const settleMs = opts.settleMs ?? LEASE_SETTLE_MS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ticket = opts.ticket || (() => Math.random());
  const mode = locks && typeof locks.request === 'function' ? 'web-locks' : storage ? 'lease' : 'none';
  const held = new Map(); // lessonId -> handle (held by this instance)
  const watchers = new Set();

  const post = (msg) => { try { channel?.postMessage({ type: 'lesson-lock', owner, ...msg }); } catch { /* closed */ } };

  // ---- lease helpers (fallback path)
  function readLease(lessonId) {
    if (!storage) return null;
    try {
      const v = JSON.parse(storage.getItem(leaseKey(lessonId)) || 'null');
      return v && typeof v.owner === 'string' && typeof v.expires === 'number' ? v : null;
    } catch { return null; }
  }
  const liveLease = (lessonId) => { const l = readLease(lessonId); return l && l.expires > now() ? l : null; };
  function writeLease(lessonId) {
    try { storage.setItem(leaseKey(lessonId), JSON.stringify({ owner, expires: now() + ttlMs })); return true; } catch { return false; }
  }
  function clearLease(lessonId) {
    try { if (readLease(lessonId)?.owner === owner) storage.removeItem(leaseKey(lessonId)); } catch { /* blocked */ }
  }

  function makeHandle(lessonId, kind, doRelease) {
    let done = null;
    const handle = {
      lessonId,
      kind,
      get released() { return !!done; },
      /** Release the lock; resolves once another tab can take it. Idempotent. */
      release() {
        if (done) return done;
        held.delete(lessonId);
        done = Promise.resolve(doRelease()).catch(() => {}).then(() => { post({ lessonId, state: 'released' }); });
        return done;
      },
    };
    held.set(lessonId, handle);
    post({ lessonId, state: 'acquired' });
    return handle;
  }

  /** Take the lesson's lock if no other tab holds it. Resolves to a handle, or null. */
  async function acquire(lessonId) {
    if (held.has(lessonId)) return null; // this page is already writing it
    if (mode === 'web-locks') {
      return new Promise((resolve) => {
        let releaseLock;
        const requested = locks.request(lockName(lessonId), { ifAvailable: true }, (lock) => {
          if (!lock) { resolve(null); return undefined; }
          return new Promise((r) => {
            releaseLock = r;
            resolve(makeHandle(lessonId, 'web-locks', () => { releaseLock(); return requested; }));
          });
        });
        requested.catch(() => resolve(null));
      });
    }
    if (mode === 'lease') {
      const cur = liveLease(lessonId);
      if (cur && cur.owner !== owner) return null;
      // Two tabs can both see a free lease and both write it. Tabs are separate processes, so
      // a microtask is not enough: claim on the channel, write, wait a settle window so racing
      // writes land (last writer wins, both tabs then read the same value), and let the lowest
      // claim ticket win if the channel saw a competitor before storage settled.
      const mine = ticket();
      let beaten = false;
      const onClaim = (e) => {
        const d = e?.data;
        if (d?.type !== 'lesson-lock' || d.lessonId !== lessonId || d.owner === owner) return;
        if (d.state === 'claiming' && (d.ticket < mine || (d.ticket === mine && d.owner < owner))) beaten = true;
        if (d.state === 'acquired') beaten = true;
      };
      channel?.addEventListener?.('message', onClaim);
      try {
        post({ lessonId, state: 'claiming', ticket: mine });
        if (!writeLease(lessonId)) return null;
        await sleep(settleMs);
        if (beaten || readLease(lessonId)?.owner !== owner) { clearLease(lessonId); return null; }
      } finally {
        channel?.removeEventListener?.('message', onClaim);
      }
      const timer = timers.setInterval(() => {
        const l = readLease(lessonId);
        if (l && l.owner !== owner && l.expires > now()) return; // lost it (we stalled past expiry)
        writeLease(lessonId);
      }, renewMs);
      return makeHandle(lessonId, 'lease', () => { timers.clearInterval(timer); clearLease(lessonId); });
    }
    return makeHandle(lessonId, 'none', () => {}); // no locking available: single-tab behaviour
  }

  /** Does ANOTHER tab hold the lesson's lock right now? */
  async function isHeld(lessonId) {
    if (held.has(lessonId)) return false;
    if (mode === 'web-locks') {
      const name = lockName(lessonId);
      if (typeof locks.query === 'function') {
        try { const q = await locks.query(); return (q?.held || []).some((l) => l.name === name); } catch { /* fall through */ }
      }
      return new Promise((resolve) => {
        locks.request(name, { ifAvailable: true }, (lock) => { resolve(!lock); }).catch(() => resolve(false));
      });
    }
    if (mode === 'lease') { const l = liveLease(lessonId); return !!l && l.owner !== owner; }
    return false;
  }

  /**
   * Call `onFree()` once when no other tab holds the lesson's lock any more.
   * Returns a stop function.
   */
  function watch(lessonId, onFree, { intervalMs = renewMs } = {}) {
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (stopped || checking) return;
      checking = true;
      try { if (!(await isHeld(lessonId)) && !stopped) { stop(); onFree(); } } finally { checking = false; }
    };
    const onMessage = (e) => { const d = e?.data; if (d?.type === 'lesson-lock' && d.lessonId === lessonId && d.state === 'released') check(); };
    const onStorage = (e) => { if (e?.key === leaseKey(lessonId) && !e.newValue) check(); };
    const timer = timers.setInterval(check, intervalMs);
    channel?.addEventListener?.('message', onMessage);
    target?.addEventListener?.('storage', onStorage);
    function stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(timer);
      channel?.removeEventListener?.('message', onMessage);
      target?.removeEventListener?.('storage', onStorage);
      watchers.delete(stop);
    }
    watchers.add(stop);
    return stop;
  }

  /**
   * Another tab took the lesson's lock (it started streaming, resuming or revising it): call
   * `onTaken()` so this page can drop its Resume/Revise controls. Broadcast-based; a tab that
   * misses the message still finds out when it tries to acquire. Returns a stop function.
   */
  function onTaken(lessonId, onTakenCb) {
    const onMessage = (e) => {
      const d = e?.data;
      if (d?.type === 'lesson-lock' && d.lessonId === lessonId && d.state === 'acquired' && d.owner !== owner) onTakenCb();
    };
    channel?.addEventListener?.('message', onMessage);
    const stop = () => { channel?.removeEventListener?.('message', onMessage); watchers.delete(stop); };
    watchers.add(stop);
    return stop;
  }

  /** Release everything this page holds (pagehide). */
  function releaseAll() { for (const h of [...held.values()]) h.release(); }
  // releaseOnHide:false when the page releases in its own pagehide handler (after its last save)
  const onHide = () => releaseAll();
  if (opts.releaseOnHide !== false) {
    target?.addEventListener?.('pagehide', onHide);
    target?.addEventListener?.('beforeunload', onHide);
  }

  return {
    mode,
    owner,
    acquire,
    isHeld,
    watch,
    onTaken,
    releaseAll,
    readLease,
    holds: (lessonId) => held.has(lessonId),
    /** Tear down listeners and the channel (tests; a page never needs this). */
    close() {
      releaseAll();
      for (const stop of [...watchers]) stop();
      target?.removeEventListener?.('pagehide', onHide);
      target?.removeEventListener?.('beforeunload', onHide);
      if ('channel' in opts) return;
      try { channel?.close?.(); } catch { /* closed */ }
    },
  };
}
