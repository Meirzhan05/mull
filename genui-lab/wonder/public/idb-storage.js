// The signed-in browser cache: a localStorage-shaped store (getItem / setItem / removeItem) over
// IndexedDB, one database per account. Everything is read into memory once at startup, so reads
// stay synchronous for store.js; writes go to IndexedDB right away (not debounced: store.js already
// batches) and are announced to the account's other tabs over a BroadcastChannel, whose handler
// updates their copy and calls onChange(key, value).
//
// IndexedDB's quota is a share of the disk rather than localStorage's ~5 MB, and a write never
// throws, so store.js never reaches prune() here: nothing is dropped, and lesson bodies live on
// the server anyway.

const STORE = 'kv';

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const accountDbName = (userId) => `wonder-account-${userId}`;

/** @returns {Promise<{getItem, setItem, removeItem, onChange, flushNow, destroy, kind: 'indexeddb'}>} */
export async function openIdbStorage(userId, { logger = console } = {}) {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is not available');
  const name = accountDbName(userId);
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await req(open);
  let closed = false;
  db.onversionchange = () => { closed = true; db.close(); }; // the account is being signed out in another tab
  const cache = new Map();
  await new Promise((resolve, reject) => {
    const cur = db.transaction(STORE).objectStore(STORE).openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return resolve(); cache.set(String(c.key), String(c.value)); c.continue(); };
    cur.onerror = () => reject(cur.error);
  });
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
  const listeners = new Set();
  let last = Promise.resolve();
  if (channel) channel.onmessage = (e) => {
    const { key, value } = e.data || {};
    if (typeof key !== 'string') return;
    if (value == null) cache.delete(key); else cache.set(key, value);
    for (const fn of listeners) { try { fn(key, value); } catch {} }
  };
  const write = (key, value) => {
    if (closed) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      if (value == null) tx.objectStore(STORE).delete(key); else tx.objectStore(STORE).put(value, key);
      last = new Promise((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => { logger.warn?.(`[wonder] could not save to this browser (${tx.error?.name || 'error'})`); resolve(); };
      });
    } catch (e) { logger.warn?.(`[wonder] could not save to this browser (${e.name || e.message})`); }
    try { channel?.postMessage({ key, value }); } catch {}
  };
  return {
    kind: 'indexeddb',
    getItem: (key) => (cache.has(key) ? cache.get(key) : null),
    setItem(key, value) { const v = String(value); cache.set(key, v); write(key, v); },
    removeItem(key) { cache.delete(key); write(key, null); },
    /** Called with (key, value) when another tab of this account writes. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Resolves once the latest write has reached IndexedDB. */
    flushNow: () => last,
    /** Sign-out: forget this account's cache in this browser. */
    async destroy() {
      closed = true;
      try { channel?.close(); } catch {}
      db.close();
      // other tabs close on versionchange; never wait forever on one that does not
      await Promise.race([req(indexedDB.deleteDatabase(name)).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    },
  };
}

/**
 * Fallback when IndexedDB is unavailable: the same shape over localStorage, under keys of its own
 * and with quota errors swallowed, so a full disk never makes store.js prune synced lessons.
 */
export function prefixedLocalStorage(userId, { logger = console } = {}) {
  const ns = `wonder.account.${userId}.`;
  const ls = globalThis.localStorage;
  return {
    kind: 'localstorage',
    getItem: (k) => { try { return ls.getItem(ns + k); } catch { return null; } },
    setItem: (k, v) => { try { ls.setItem(ns + k, String(v)); } catch (e) { logger.warn?.(`[wonder] this browser's storage is full (${e.name}); changes stay in memory and on the server`); } },
    removeItem: (k) => { try { ls.removeItem(ns + k); } catch {} },
    onChange: () => () => {},
    flushNow: async () => {},
    async destroy() { try { for (const k of Object.keys(ls)) if (k.startsWith(ns)) ls.removeItem(k); } catch {} },
  };
}
