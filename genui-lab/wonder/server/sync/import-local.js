// One-time import of this machine's signed-out server data (data/memory.json and data/materials/,
// from before accounts) into one account in the database. Browser state migrates on its own at
// first sign-in; learner memory and material lived on the server, so they move with this:
//
//   node --env-file-if-exists=.env.local server/sync/import-local.js --user <user id>
//
// The user id is the Neon Auth user id of the signed-in account (GET /api/account returns it). Items the
// account already has (same id) are skipped; the local files are left as they are.

import { createSyncService } from './service.js';
import { createMemoryStore, DEFAULT_MEMORY_FILE } from '../memory.js';
import { createMaterialStore, DEFAULT_MATERIALS_DIR } from '../materials.js';

/** Copy memory items and materials into `userId`'s records. Returns counts. */
export async function importLocal({ sync, userId, memory, materials }) {
  const have = new Set((await sync.list(userId, ['memory', 'material'])).map((r) => `${r.kind}:${r.id}`));
  const mem = memory.list().filter((i) => !have.has(`memory:${i.id}`));
  if (mem.length) await sync.writeServer(userId, mem.map((i) => ({ kind: 'memory', id: i.id, data: i })));
  let mats = 0;
  for (const meta of materials.list().reverse()) {
    if (have.has(`material:${meta.id}`)) continue;
    const data = materials.read(meta.id);
    if (data == null) continue;
    await sync.db.putFile(userId, meta.id, { bytes: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), contentType: meta.kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8' });
    await sync.writeServer(userId, [{ kind: 'material', id: meta.id, data: meta }]);
    mats++;
  }
  return { memory: mem.length, materials: mats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--user');
  const userId = i > 0 ? process.argv[i + 1] : '';
  if (!userId || !process.env.DATABASE_URL) {
    console.error('Usage: DATABASE_URL=... node server/sync/import-local.js --user <user id>');
    process.exit(2);
  }
  const { default: pg } = await import('pg');
  const { createPgDb } = await import('./pg-db.js');
  const blob = process.env.BLOB_READ_WRITE_TOKEN ? await import('@vercel/blob') : null;
  const db = createPgDb({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }), blob: blob && { put: blob.put, get: blob.get, del: blob.del } });
  const r = await importLocal({
    sync: createSyncService({ db }),
    userId,
    memory: createMemoryStore({ file: process.env.WONDER_MEMORY_FILE || DEFAULT_MEMORY_FILE }),
    materials: createMaterialStore({ dir: process.env.WONDER_MATERIALS_DIR || DEFAULT_MATERIALS_DIR }),
  });
  console.log(`Imported ${r.memory} memory item(s) and ${r.materials} material(s) into ${userId}.`);
  await db.close();
}
