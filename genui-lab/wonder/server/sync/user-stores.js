// With account sync on, learner memory and uploaded material are per user: `memory` and
// `material` records in the same per-user table as the synced state (file content through the
// adapter's file methods: private Vercel Blob or Postgres). These wrap them in the interfaces the
// rest of the server already uses (server/memory.js, server/materials.js), one instance per
// request. Material methods are async; callers await them either way.

import { createMemoryStore } from '../memory.js';
import { prepareMaterial, MATERIAL_ID_RE, MAX_MATERIALS } from '../materials.js';

/** Learner memory for one user: loaded once per request, each save written back per item. */
export async function loadUserMemory(sync, userId, { logger = console } = {}) {
  const items = (await sync.list(userId, ['memory'])).map((r) => r.data);
  let prev = new Map(items.map((i) => [i.id, JSON.stringify(i)]));
  let pending = Promise.resolve();
  const store = createMemoryStore({
    file: null,
    items,
    logger,
    onSave(list) {
      const now = new Map(list.map((i) => [i.id, JSON.stringify(i)]));
      const changes = [];
      for (const [id, json] of now) if (prev.get(id) !== json) changes.push({ kind: 'memory', id, data: JSON.parse(json) });
      for (const id of prev.keys()) if (!now.has(id)) changes.push({ kind: 'memory', id, deleted: true });
      prev = now;
      if (changes.length) pending = pending.then(() => sync.writeServer(userId, changes)).catch((e) => logger.warn?.(`[wonder] could not save memory: ${e.message}`));
    },
  });
  store.flush = () => pending;
  return store;
}

/** Signed out on a server with accounts: no shared memory between anonymous visitors. */
export function signedOutMemory() {
  const no = { ok: false, error: 'Sign in to use memory.' };
  return { list: () => [], get: () => null, size: 0, add: () => no, restore: () => no, remove: () => null, clear: () => 0, promptBlock: () => '', flush: async () => {} };
}

export function signedOutMaterials() {
  return { list: async () => [], meta: async () => null, add: async () => ({ ok: false, error: 'Sign in to add material.' }), read: async () => null, remove: async () => null };
}

/** Uploaded material for one user. */
export function userMaterials(sync, userId) {
  let index = null;
  const load = async () => (index ??= (await sync.list(userId, ['material'])).map((r) => r.data).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  const store = {
    list: async () => (await load()).map((m) => ({ ...m })),
    meta: async (id) => (MATERIAL_ID_RE.test(String(id)) ? (await load()).find((m) => m.id === id) || null : null),
    async add(input) {
      const prepared = prepareMaterial(input);
      if (!prepared.ok) return prepared;
      const { meta, data } = prepared;
      const before = await load(); // read the index before this item is stored
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      await sync.db.putFile(userId, meta.id, { bytes, contentType: meta.kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8' });
      await sync.writeServer(userId, [{ kind: 'material', id: meta.id, data: meta }]);
      index = [meta, ...before.filter((m) => m.id !== meta.id)];
      while (index.length > MAX_MATERIALS) await store.remove(index[index.length - 1].id);
      return { ok: true, item: { ...meta } };
    },
    /** A string for text, a Buffer for a PDF; null when unknown or not this user's. */
    async read(id) {
      const meta = await store.meta(id);
      if (!meta) return null;
      const f = await sync.db.getFile(userId, id);
      if (!f) return null;
      return meta.kind === 'pdf' ? Buffer.from(f.bytes) : Buffer.from(f.bytes).toString('utf8');
    },
    async remove(id) {
      const meta = await store.meta(id);
      if (!meta) return null;
      await sync.writeServer(userId, [{ kind: 'material', id, deleted: true }]);
      await sync.db.deleteFile(userId, id);
      index = (await load()).filter((m) => m.id !== id);
      return meta;
    },
  };
  return store;
}
