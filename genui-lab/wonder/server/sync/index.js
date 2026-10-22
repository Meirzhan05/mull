// Is account sync on, and with which storage? On only when an auth provider is configured (both
// Clerk keys: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY for sign-in, CLERK_SECRET_KEY for sessions) and a
// database is: DATABASE_URL (Postgres), or WONDER_SYNC_DB=memory to try
// accounts locally without one (data lasts until the server stops). Otherwise Wonder runs exactly
// as before: browser-only state, data/memory.json and data/materials.
//
// Material files go to a private Vercel Blob store when BLOB_READ_WRITE_TOKEN is set, else into
// Postgres. Web Push is on when the VAPID keys and subject are set (see server/push.js).

import { createSyncService } from './service.js';
import { createMemoryDb } from './memory-db.js';

export function syncConfig(env = process.env) {
  const auth = env.CLERK_SECRET_KEY && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? 'clerk' : null;
  const db = env.DATABASE_URL ? 'postgres' : env.WONDER_SYNC_DB === 'memory' ? 'memory' : null;
  return { enabled: !!(auth && db), auth, db };
}

/** The sync service for this environment, or null when sync is off. Lazy: pg loads on first use. */
export async function createSyncFromEnv(env = process.env, { logger = console } = {}) {
  const cfg = syncConfig(env);
  if (!cfg.enabled) return null;
  let db;
  if (cfg.db === 'memory') db = createMemoryDb();
  else {
    const { default: pg } = await import('pg');
    const { createPgDb } = await import('./pg-db.js');
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.WONDER_DB_POOL || 5), idleTimeoutMillis: 10_000 });
    pool.on('error', (e) => logger.warn?.(`[wonder] database pool error: ${e.message}`));
    let blob = null;
    if (env.BLOB_READ_WRITE_TOKEN) {
      const b = await import('@vercel/blob');
      blob = { put: b.put, get: b.get, del: b.del };
    }
    db = createPgDb({ pool, blob });
  }
  logger.info?.(`[wonder] account sync on (${cfg.auth} + ${db.kind}${cfg.db === 'postgres' && env.BLOB_READ_WRITE_TOKEN ? ' + blob' : ''})`);
  return createSyncService({ db });
}
