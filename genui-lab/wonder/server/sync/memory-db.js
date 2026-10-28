// In-process sync storage: the same adapter interface as pg-db.js, for tests and for trying
// accounts locally without a database (WONDER_SYNC_DB=memory). Rows hold JSON strings, never live
// objects, and a transaction's writes apply only when it finishes, like a real database.

const key = (kind, id) => `${kind}:${id}`;

export function createMemoryDb() {
  const users = new Map(); // userId -> {rev, deletedRev, records: Map, subs: Map, reminders: Set, files: Map, usage: Map}
  const locks = new Map(); // userId -> tail of the transaction queue
  const user = (id) => {
    if (!users.has(id)) users.set(id, { rev: 0, deletedRev: 0, records: new Map(), subs: new Map(), reminders: new Set(), files: new Map(), usage: new Map() });
    return users.get(id);
  };
  const copy = (r) => ({ ...r });

  async function transaction(userId, fn) {
    const prev = locks.get(userId) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    locks.set(userId, prev.then(() => mine));
    await prev;
    try {
      const u = user(userId);
      let rev = u.rev;
      const pending = new Map();
      let wiped = false;
      const tx = {
        rev: async () => rev,
        deletedRev: async () => u.deletedRev,
        /** Delete account: drop everything but the revision counter and the usage counts. */
        wipe: async () => { wiped = true; pending.clear(); },
        setRev: async (n) => { rev = n; },
        get: async (keys) => {
          const out = new Map();
          for (const [kind, id] of keys) { const r = pending.get(key(kind, id)) || u.records.get(key(kind, id)); if (r) out.set(key(kind, id), copy(r)); }
          return out;
        },
        put: async (rows) => { for (const r of rows) pending.set(key(r.kind, r.id), copy(r)); },
        since: async (since, { maxBytes = Infinity, exclude = [] } = {}) => {
          const merged = new Map([...u.records, ...pending]);
          const rows = [...merged.values()].filter((r) => r.rev > since && !exclude.includes(r.kind)).sort((a, b) => a.rev - b.rev);
          const records = [];
          let bytes = 0;
          for (const r of rows) {
            const size = (r.json ? Buffer.byteLength(r.json) : 0) + 100;
            if (records.length && bytes + size > maxBytes) return { records, more: true, lastRev: records[records.length - 1].rev };
            bytes += size;
            records.push(copy(r));
          }
          return { records, more: false, lastRev: rows.length ? rows[rows.length - 1].rev : since };
        },
      };
      const result = await fn(tx);
      if (wiped) {
        for (const m of [u.records, u.subs, u.reminders, u.files]) m.clear();
        u.deletedRev = rev;
      }
      for (const [k, r] of pending) u.records.set(k, r);
      u.rev = rev;
      return result;
    } finally {
      release();
    }
  }

  return {
    kind: 'memory',
    transaction,
    async list(userId, kinds) {
      const u = users.get(userId);
      if (!u) return [];
      return [...u.records.values()].filter((r) => !r.deleted && (!kinds || kinds.includes(r.kind))).sort((a, b) => a.rev - b.rev).map(copy);
    },
    async count(userId, kinds) {
      const u = users.get(userId);
      return u ? [...u.records.values()].filter((r) => !r.deleted && kinds.includes(r.kind)).length : 0;
    },
    // -- Web Push subscriptions (one row per browser endpoint)
    async addSubscription(userId, sub) {
      for (const [id, u] of users) if (id !== userId) u.subs.delete(sub.endpoint); // the browser changed accounts
      user(userId).subs.set(sub.endpoint, { ...sub });
    },
    async removeSubscription(userId, endpoint) { return users.get(userId)?.subs.delete(endpoint) || false; },
    async listSubscriptions(userId) { return [...(users.get(userId)?.subs.values() || [])].map(copy); },
    /** Cron only: every user with at least one subscription. */
    async listPushUsers() { return [...users].filter(([, u]) => u.subs.size).map(([userId, u]) => ({ userId, subscriptions: [...u.subs.values()].map(copy) })); },
    /** First caller for (user, day) gets true: the daily reminder goes out once. */
    async claimReminder(userId, day) {
      const u = user(userId);
      if (u.reminders.has(day)) return false;
      u.reminders.add(day);
      return true;
    },
    // -- daily usage caps (server/usage.js)
    async useQuota(userId, day, kind, max) {
      const u = user(userId);
      const k = `${day}|${kind}`;
      const n = u.usage.get(k) || 0;
      if (n >= max) return { ok: false, used: n };
      u.usage.set(k, n + 1);
      return { ok: true, used: n + 1 };
    },
    async quotaUsed(userId, day) {
      const out = {};
      for (const [k, n] of users.get(userId)?.usage || []) if (k.startsWith(`${day}|`)) out[k.slice(day.length + 1)] = n;
      return out;
    },
    // -- material files
    async putFile(userId, id, { bytes, contentType }) { user(userId).files.set(id, { bytes: Buffer.from(bytes), contentType }); },
    async getFile(userId, id) { const f = users.get(userId)?.files.get(id); return f ? { bytes: Buffer.from(f.bytes), contentType: f.contentType } : null; },
    async deleteFile(userId, id) { users.get(userId)?.files.delete(id); },
    /** Delete account: records, files, push subscriptions and the reminder log (tx.wipe). */
    async deleteUser(userId) { await transaction(userId, (tx) => tx.wipe()); },
    async close() {},
  };
}
