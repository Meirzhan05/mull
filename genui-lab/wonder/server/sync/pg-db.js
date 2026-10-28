// Postgres sync storage (Neon via the Vercel Marketplace, or any Postgres): the adapter interface
// of memory-db.js over `pg`. Every statement that reads or writes learner data is scoped with
// `user_id = $1` (test/sync-auth.test.js checks this file for it); the two exceptions are marked
// CROSS-USER and only serve the reminder cron and a browser moving to another account.
//
// Tables are created on first use (CREATE ... IF NOT EXISTS). Record data is stored as JSON text:
// the server never queries inside it, and text keeps the exact bytes a browser sent.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS wonder_users (
  id text PRIMARY KEY,
  rev bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wonder_users ADD COLUMN IF NOT EXISTS deleted_rev bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS wonder_records (
  user_id text NOT NULL REFERENCES wonder_users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  id text NOT NULL,
  data text,
  deleted boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL,
  rev bigint NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS wonder_records_user_rev ON wonder_records (user_id, rev);
CREATE TABLE IF NOT EXISTS wonder_push_subscriptions (
  user_id text NOT NULL,
  endpoint text NOT NULL,
  keys text NOT NULL,
  time_zone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint)
);
CREATE TABLE IF NOT EXISTS wonder_reminders_sent (
  user_id text NOT NULL,
  day text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS wonder_usage (
  user_id text NOT NULL,
  day text NOT NULL,
  kind text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);
CREATE TABLE IF NOT EXISTS wonder_files (
  user_id text NOT NULL,
  id text NOT NULL,
  content_type text NOT NULL,
  bytes bytea,
  blob_path text,
  PRIMARY KEY (user_id, id)
);
`;

const PAGE_ROWS = 200;
const row = (r) => ({ kind: r.kind, id: r.id, json: r.data, deleted: r.deleted, updatedAt: Number(r.updated_at), rev: Number(r.rev) });

/**
 * @param {{pool: import('pg').Pool, blob?: {put: Function, get: Function, del: Function} | null}} opts
 *   blob: private Vercel Blob for material files; without it files live in wonder_files.bytes.
 */
export function createPgDb({ pool, blob = null }) {
  let ready = null;
  const ensure = () => (ready ??= pool.query(SCHEMA).catch((e) => { ready = null; throw e; }));
  const q = async (text, params) => { await ensure(); return pool.query(text, params); };

  async function transaction(userId, fn) {
    await ensure();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO wonder_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
      const { rows: [u] } = await client.query('SELECT rev, deleted_rev FROM wonder_users WHERE id = $1 FOR UPDATE', [userId]);
      let rev = Number(u.rev);
      const tx = {
        rev: async () => rev,
        deletedRev: async () => Number(u.deleted_rev),
        /**
         * Delete account: the user's records, files, push subscriptions and reminder log. The
         * revision counter stays (deleted_rev marks where the delete happened), and so do usage
         * counts, so deleting and signing in again does not reset the day's caps.
         * @returns {Promise<string[]>} Blob paths to delete once this commits
         */
        wipe: async () => {
          await client.query('DELETE FROM wonder_records WHERE user_id = $1', [userId]);
          const { rows } = await client.query('DELETE FROM wonder_files WHERE user_id = $1 RETURNING blob_path', [userId]);
          await client.query('DELETE FROM wonder_push_subscriptions WHERE user_id = $1', [userId]);
          await client.query('DELETE FROM wonder_reminders_sent WHERE user_id = $1', [userId]);
          await client.query('UPDATE wonder_users SET deleted_rev = rev WHERE id = $1', [userId]);
          return rows.map((r) => r.blob_path).filter(Boolean);
        },
        setRev: async (n) => { rev = n; await client.query('UPDATE wonder_users SET rev = $2 WHERE id = $1', [userId, n]); },
        get: async (keys) => {
          const out = new Map();
          if (!keys.length) return out;
          const { rows } = await client.query(
            'SELECT kind, id, data, deleted, updated_at, rev FROM wonder_records WHERE user_id = $1 AND (kind, id) IN (SELECT * FROM unnest($2::text[], $3::text[]))',
            [userId, keys.map((k) => k[0]), keys.map((k) => k[1])]);
          for (const r of rows) out.set(`${r.kind}:${r.id}`, row(r));
          return out;
        },
        put: async (rows) => {
          for (let i = 0; i < rows.length; i += 100) {
            const part = rows.slice(i, i + 100);
            await client.query(
              `INSERT INTO wonder_records (user_id, kind, id, data, deleted, updated_at, rev)
               SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::bigint[], $7::bigint[])
               ON CONFLICT (user_id, kind, id) DO UPDATE SET data = EXCLUDED.data, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at, rev = EXCLUDED.rev
               WHERE wonder_records.user_id = $1`,
              [userId, part.map((r) => r.kind), part.map((r) => r.id), part.map((r) => r.json), part.map((r) => !!r.deleted), part.map((r) => r.updatedAt), part.map((r) => r.rev)]);
          }
        },
        since: async (since, { maxBytes = Infinity, exclude = [] } = {}) => {
          const records = [];
          let bytes = 0;
          let after = since;
          for (;;) {
            const { rows } = await client.query(
              'SELECT kind, id, data, deleted, updated_at, rev FROM wonder_records WHERE user_id = $1 AND rev > $2 AND NOT (kind = ANY($3::text[])) ORDER BY rev LIMIT $4',
              [userId, after, exclude, PAGE_ROWS]);
            for (const r of rows.map(row)) {
              const size = (r.json ? Buffer.byteLength(r.json) : 0) + 100;
              if (records.length && bytes + size > maxBytes) return { records, more: true, lastRev: records[records.length - 1].rev };
              bytes += size;
              records.push(r);
            }
            if (rows.length < PAGE_ROWS) return { records, more: false, lastRev: records.length ? records[records.length - 1].rev : since };
            after = Number(rows[rows.length - 1].rev);
          }
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    kind: 'postgres',
    transaction,
    async list(userId, kinds) {
      const { rows } = await q(
        'SELECT kind, id, data, deleted, updated_at, rev FROM wonder_records WHERE user_id = $1 AND NOT deleted AND ($2::text[] IS NULL OR kind = ANY($2::text[])) ORDER BY rev',
        [userId, kinds || null]);
      return rows.map(row);
    },
    async count(userId, kinds) {
      const { rows: [r] } = await q('SELECT count(*)::int AS n FROM wonder_records WHERE user_id = $1 AND NOT deleted AND kind = ANY($2::text[])', [userId, kinds]);
      return r.n;
    },
    async addSubscription(userId, sub) {
      // CROSS-USER: an endpoint belongs to one browser; when that browser signs in to another
      // account, the old account must stop sending to it. Only the browser knows its endpoint.
      await q('DELETE FROM wonder_push_subscriptions WHERE endpoint = $2 AND user_id <> $1', [userId, sub.endpoint]);
      await q(
        `INSERT INTO wonder_push_subscriptions (user_id, endpoint, keys, time_zone) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, endpoint) DO UPDATE SET keys = EXCLUDED.keys, time_zone = EXCLUDED.time_zone`,
        [userId, sub.endpoint, JSON.stringify(sub.keys || {}), sub.timeZone || null]);
    },
    async removeSubscription(userId, endpoint) {
      const r = await q('DELETE FROM wonder_push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
      return r.rowCount > 0;
    },
    async listSubscriptions(userId) {
      const { rows } = await q('SELECT endpoint, keys, time_zone FROM wonder_push_subscriptions WHERE user_id = $1', [userId]);
      return rows.map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys), timeZone: r.time_zone }));
    },
    async listPushUsers() {
      // CROSS-USER: the reminder cron (authorized by CRON_SECRET) visits every subscribed user.
      const { rows } = await q('SELECT user_id, endpoint, keys, time_zone FROM wonder_push_subscriptions ORDER BY user_id');
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.user_id)) by.set(r.user_id, []);
        by.get(r.user_id).push({ endpoint: r.endpoint, keys: JSON.parse(r.keys), timeZone: r.time_zone });
      }
      return [...by].map(([userId, subscriptions]) => ({ userId, subscriptions }));
    },
    async claimReminder(userId, day) {
      const r = await q('INSERT INTO wonder_reminders_sent (user_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, day]);
      return r.rowCount === 1;
    },
    // -- daily usage caps (server/usage.js)
    /** Count one use of `kind` today unless `max` is reached: one atomic upsert. */
    async useQuota(userId, day, kind, max) {
      const { rows } = await q(
        'INSERT INTO wonder_usage (user_id, day, kind, count) VALUES ($1, $2, $3, 1) ON CONFLICT (user_id, day, kind) DO UPDATE SET count = wonder_usage.count + 1 WHERE wonder_usage.count < $4 RETURNING count',
        [userId, day, kind, max],
      );
      return rows.length ? { ok: true, used: Number(rows[0].count) } : { ok: false, used: max };
    },
    async quotaUsed(userId, day) {
      const { rows } = await q('SELECT kind, count FROM wonder_usage WHERE user_id = $1 AND day = $2', [userId, day]);
      return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]));
    },
    async putFile(userId, id, { bytes, contentType }) {
      let blobPath = null;
      if (blob) blobPath = (await blob.put(`wonder/${encodeURIComponent(userId)}/${id}`, bytes, { access: 'private', addRandomSuffix: true, contentType })).pathname;
      await q(
        `INSERT INTO wonder_files (user_id, id, content_type, bytes, blob_path) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, id) DO UPDATE SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, blob_path = EXCLUDED.blob_path`,
        [userId, id, contentType, blobPath ? null : Buffer.from(bytes), blobPath]);
    },
    async getFile(userId, id) {
      const { rows: [r] } = await q('SELECT content_type, bytes, blob_path FROM wonder_files WHERE user_id = $1 AND id = $2', [userId, id]);
      if (!r) return null;
      if (!r.blob_path) return { bytes: r.bytes, contentType: r.content_type };
      const got = blob ? await blob.get(r.blob_path, { access: 'private' }) : null;
      if (!got || got.statusCode !== 200) return null;
      return { bytes: Buffer.from(await new Response(got.stream).arrayBuffer()), contentType: r.content_type };
    },
    async deleteFile(userId, id) {
      const { rows: [r] } = await q('DELETE FROM wonder_files WHERE user_id = $1 AND id = $2 RETURNING blob_path', [userId, id]);
      if (r?.blob_path && blob) { try { await blob.del(r.blob_path); } catch { /* orphaned blob: harmless */ } }
    },
    /** Delete account (tx.wipe), under the user's row lock so no sync interleaves. */
    async deleteUser(userId) {
      const paths = await transaction(userId, (tx) => tx.wipe());
      if (paths.length && blob) { try { await blob.del(paths); } catch { /* orphaned blobs: harmless */ } }
    },
    async close() { await pool.end(); },
  };
}
