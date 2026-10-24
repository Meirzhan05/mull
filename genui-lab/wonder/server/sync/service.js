// Account sync, server side: one round trip (POST /api/sync) pushes a browser's changed records
// and pulls everything newer than its cursor. Storage is behind a small adapter (memory-db.js for
// tests and local runs, pg-db.js for Postgres); every adapter method takes the user id first and
// every query is scoped to it.
//
// Each user has a revision counter. A push runs in one transaction that holds the user's row lock,
// bumps the counter once per written record and stamps the record with it, so a pull "since N"
// never misses a record that commits later with a smaller number. A change carries the revision
// it was based on; when the stored record moved on since then, the two versions merge
// (public/sync-core.js mergeRecord). Deletes are tombstones: a record with deleted=true and no
// data, kept so every device hears about it.

import { CLIENT_KINDS, SERVER_KINDS, mergeRecord, recordKey, byteLength } from '../../public/sync-core.js';

export const MAX_RECORD_BYTES = 3 * 1024 * 1024; // one lesson with its widgets and tutor chat
export const PAGE_BYTES = 3 * 1024 * 1024; // a pull response stays under Vercel's 4.5 MB limit (UTF-8 bytes)
export const SYNC_BODY_LIMIT = 4 * 1024 * 1024;
const ID_RE = /^[^\u0000]{1,300}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const same = (a, b) => a === b;

function cleanChange(c) {
  if (!c || typeof c !== 'object') return null;
  if (!CLIENT_KINDS.includes(c.kind) || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
  const deleted = c.deleted === true;
  if (!deleted && (c.data === undefined || c.data === null)) return null;
  const json = deleted ? null : JSON.stringify(c.data);
  if (json && byteLength(json) > MAX_RECORD_BYTES) return { tooBig: true, kind: c.kind, id: c.id };
  return { kind: c.kind, id: c.id, json, deleted, baseRev: Math.max(0, Math.floor(Number(c.baseRev) || 0)), updatedAt: Math.max(0, Math.floor(Number(c.updatedAt) || 0)) || Date.now() };
}

/** A stored row ({kind, id, json, deleted, updatedAt, rev}) as the client sees it. */
export const toClient = (row) => ({ kind: row.kind, id: row.id, rev: row.rev, updatedAt: row.updatedAt, ...(row.deleted ? { deleted: true } : { data: JSON.parse(row.json) }) });

export function requireUser(userId) {
  if (typeof userId !== 'string' || !userId) throw httpError(401, 'Sign in first');
}

/**
 * @param {{db: object, now?: () => number}} opts
 */
export function createSyncService({ db, now = () => Date.now() }) {
  /** Push changes and pull every record newer than `since` (client kinds only, paged by size). */
  async function sync(userId, { since = 0, changes = [] } = {}) {
    requireUser(userId);
    if (!Array.isArray(changes)) throw httpError(400, 'changes must be a list');
    const cleaned = changes.map(cleanChange);
    const rejected = [];
    const valid = [];
    for (const c of cleaned) {
      if (!c) rejected.push({ error: 'invalid change' });
      else if (c.tooBig) rejected.push({ kind: c.kind, id: c.id, error: 'record too large' });
      else valid.push(c);
    }
    const cursor = Math.max(0, Math.floor(Number(since) || 0));
    return db.transaction(userId, async (tx) => {
      let rev = await tx.rev();
      const stored = await tx.get(valid.map((c) => [c.kind, c.id]));
      const writes = new Map();
      const unchanged = new Map(); // key -> stored row, for changes that wrote nothing
      for (const c of valid) {
        const key = recordKey(c.kind, c.id);
        const cur = writes.get(key) || stored.get(key);
        let next;
        if (!cur || cur.rev === c.baseRev) next = { json: c.json, deleted: c.deleted, updatedAt: c.updatedAt };
        else {
          const m = mergeRecord(c.kind, c.id,
            { data: cur.deleted ? null : JSON.parse(cur.json), deleted: cur.deleted, updatedAt: cur.updatedAt },
            { data: c.deleted ? null : JSON.parse(c.json), deleted: c.deleted, updatedAt: c.updatedAt });
          next = { json: m.deleted ? null : JSON.stringify(m.data), deleted: m.deleted, updatedAt: m.updatedAt };
        }
        if (!cur && next.deleted) { unchanged.set(key, { kind: c.kind, id: c.id, json: null, deleted: true, updatedAt: c.updatedAt, rev: 0 }); continue; } // never had it
        if (cur && same(cur.json, next.json) && cur.deleted === next.deleted) { unchanged.set(key, cur); continue; } // no-op
        unchanged.delete(key);
        rev += 1;
        writes.set(key, { kind: c.kind, id: c.id, ...next, rev });
      }
      if (writes.size) { await tx.put([...writes.values()]); await tx.setRev(rev); }
      const page = await tx.since(cursor, { maxBytes: PAGE_BYTES, exclude: SERVER_KINDS });
      // a change that wrote nothing (the server already had it, or its merge kept the stored
      // version) still gets an answer, so the browser can adopt the stored version as its base
      for (const r of page.records) unchanged.delete(recordKey(r.kind, r.id));
      return {
        ok: true,
        rev: page.more ? page.lastRev : Math.max(rev, cursor),
        more: page.more,
        records: page.records.map(toClient),
        ...(unchanged.size ? { current: [...unchanged.values()].map(toClient) } : {}),
        ...(rejected.length ? { rejected } : {}),
      };
    });
  }

  /** Server-owned records (memory, material): write the given versions as they are. */
  async function writeServer(userId, changes) {
    requireUser(userId);
    const list = changes.filter((c) => SERVER_KINDS.includes(c.kind) && typeof c.id === 'string' && ID_RE.test(c.id));
    if (!list.length) return;
    await db.transaction(userId, async (tx) => {
      let rev = await tx.rev();
      const writes = list.map((c) => ({ kind: c.kind, id: c.id, json: c.deleted ? null : JSON.stringify(c.data), deleted: !!c.deleted, updatedAt: now(), rev: (rev += 1) }));
      await tx.put(writes);
      await tx.setRev(rev);
    });
  }

  /** Live records of some kinds, in revision order: [{kind, id, data, rev, updatedAt}]. */
  async function list(userId, kinds) {
    requireUser(userId);
    return (await db.list(userId, kinds)).map(toClient);
  }

  return {
    sync,
    writeServer,
    list,
    /** How many browser-side records the account holds (the first sign-in asks before merging). */
    async count(userId) { requireUser(userId); return db.count(userId, CLIENT_KINDS); },
    db,
  };
}
