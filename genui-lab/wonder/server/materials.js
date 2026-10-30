// Phase 10: the learner's own material (notes, a chapter, a syllabus; pasted text or a PDF), so
// lessons and courses can be taught from it and cite it.
//
// Files live in genui-lab/wonder/data/materials/ (git-ignored): index.json plus one
// <id>.txt / <id>.pdf per item. The browser keeps only the id. `dir: null` keeps everything in
// memory (tests). Ids are server-generated and checked against MATERIAL_ID_RE before any path
// is built, so a client-sent id can never reach outside the directory.
//
// Claude gets a material as a `document` content block with citations enabled; its
// char_location / page_location citations become Cite pills through materialCitation().

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WONDER_ROOT } from './paths.js'; // import.meta.url is a build chunk under Next.js

export const DEFAULT_MATERIALS_DIR = path.join(WONDER_ROOT, 'data', 'materials');
export const MATERIAL_ID_RE = /^mat-[0-9a-f]{12}$/;
export const MAX_TEXT_CHARS = 200_000;
// a book fits; as base64 (about 26.7 MB) it stays under the Claude API's 32 MB request limit
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_MATERIALS = 50;
export const MATERIAL_BODY_LIMIT = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 64 * 1024; // base64 + JSON
// A PDF larger than one part goes up in parts (POST /api/materials/part, then POST /api/materials
// with {kind:'pdf', upload, parts}): Vercel rejects request bodies over 4.5 MB with a 413 before
// the function runs, and a whole PDF as base64 JSON passes that at about 3.3 MB.
export const PART_BYTES = 2 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_PDF_BYTES / PART_BYTES);
export const PART_BODY_LIMIT = Math.ceil((PART_BYTES * 4) / 3) + 16 * 1024;
export const UPLOAD_ID_RE = /^up-[0-9a-f]{16}$/;
export const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;
export const MAX_OPEN_UPLOADS = 2; // per user, besides the one starting
// Claude reads a material as tokens (each PDF page is its text plus an image of the page): above
// this a lesson's request no longer fits the 1M context, and Claude reads at most 600 PDF pages
export const MAX_MATERIAL_TOKENS = 800_000;
// a lesson or course plan from a long material counts as one more request per this many tokens
// (about $1 of uncached input), so the daily caps still bound what one user spends
export const MATERIAL_TOKENS_PER_CHARGE = 250_000;

// A PDF Claude refuses ("Could not process PDF": e.g. a scan whose page images use formats it
// can't decode) is taught from its text layer instead; below this many characters it has none
export const MIN_FALLBACK_CHARS = 500;

export const isBase64 = (s) => /^[A-Za-z0-9+/]+=*$/.test(s);
export const pdfTooLarge = (bytes) => `That PDF is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_PDF_BYTES / 1048576} MB.`;
/**
 * How many requests a lesson or course plan from this material counts as against the daily caps
 * (a PDF taught from its text layer: about 4 characters a token).
 */
export const materialCharge = (meta) => 1 + Math.floor((meta?.textFallback ? meta.textFallback.chars / 4 : Number(meta?.tokens) || 0) / MATERIAL_TOKENS_PER_CHARGE);

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Normalize pasted text: unify newlines, drop control characters, collapse blank runs. */
export function cleanMaterialText(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
}

/** A title: the given one, else the first non-empty line of the text, else the file name. */
export function materialTitle({ title, text, filename } = {}) {
  const first = String(text || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  return clean(title, 120) || clean(first, 80) || clean(String(filename || '').replace(/\.[a-z0-9]+$/i, ''), 120) || 'My material';
}

/**
 * Validate one upload: {title?, kind:'text', text} or {title?, kind:'pdf', base64 | bytes, filename?}
 * (bytes: a Buffer, from parts put back together by takeUpload).
 * Returns {ok, meta, data} (data: string for text, Buffer for a PDF) or {ok:false, error}.
 */
export function prepareMaterial(input) {
  const kind = input?.kind === 'pdf' ? 'pdf' : 'text';
  let data;
  let meta;
  const id = `mat-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  if (kind === 'text') {
    const text = cleanMaterialText(input?.text);
    if (text.length < 40) return { ok: false, error: 'Paste at least a paragraph of material (40+ characters).' };
    if (text.length > MAX_TEXT_CHARS) return { ok: false, error: `That is too long (${text.length.toLocaleString('en-US')} characters). The limit is ${MAX_TEXT_CHARS.toLocaleString('en-US')}; paste one chapter at a time.` };
    data = text;
    meta = { id, kind, title: materialTitle({ title: input?.title, text, filename: input?.filename }), chars: text.length };
  } else {
    let buf = Buffer.isBuffer(input?.bytes) ? input.bytes : null;
    if (!buf) {
      const b64 = String(input?.base64 || '').replace(/^data:[^,]*,/, '');
      if (!isBase64(b64)) return { ok: false, error: 'The PDF could not be read.' };
      buf = Buffer.from(b64, 'base64');
    }
    if (buf.length > MAX_PDF_BYTES) return { ok: false, error: pdfTooLarge(buf.length) };
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, error: 'That file is not a PDF.' };
    data = buf;
    meta = { id, kind, title: materialTitle({ title: input?.title, filename: input?.filename }), bytes: buf.length };
  }
  meta.createdAt = new Date().toISOString();
  return { ok: true, meta, data };
}

export function createMaterialStore({ dir = DEFAULT_MATERIALS_DIR } = {}) {
  const mem = new Map(); // id -> {meta, data: string | Buffer}
  let index = [];
  const indexFile = dir ? path.join(/* turbopackIgnore: true */ dir, 'index.json') : null;
  const fileOf = (meta) => path.join(/* turbopackIgnore: true */ dir, `${meta.id}.${meta.kind === 'pdf' ? 'pdf' : 'txt'}`);
  const textFileOf = (id) => path.join(/* turbopackIgnore: true */ dir, `${id}.text.txt`);
  const texts = new Map(); // id -> text layer of a PDF Claude could not read (dir: null)
  if (dir) {
    try {
      const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ indexFile, 'utf8'));
      index = (Array.isArray(parsed?.items) ? parsed.items : []).filter((m) => MATERIAL_ID_RE.test(m?.id) && (m.kind === 'text' || m.kind === 'pdf'));
    } catch { index = []; }
  }
  function saveIndex() {
    if (!dir) return;
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
    const tmp = `${indexFile}.${process.pid}.tmp`;
    fs.writeFileSync(/* turbopackIgnore: true */ tmp, JSON.stringify({ version: 1, items: index }, null, 2));
    fs.renameSync(/* turbopackIgnore: true */ tmp, indexFile);
  }
  const store = {
    list: () => index.map((m) => ({ ...m })),
    meta: (id) => (MATERIAL_ID_RE.test(String(id)) ? index.find((m) => m.id === id) || null : null),
    /**
     * Add one material: {title?, kind:'text', text} or {title?, kind:'pdf', base64, filename?}.
     * Returns {ok, item} or {ok:false, error}.
     */
    add: (input) => { const prepared = prepareMaterial(input); return prepared.ok ? store.save(prepared) : prepared; },
    /** Store a material prepareMaterial() accepted. */
    save({ meta, data }) {
      const id = meta.id;
      if (dir) { fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true }); fs.writeFileSync(/* turbopackIgnore: true */ fileOf(meta), data); } else mem.set(id, data);
      index = [meta, ...index];
      while (index.length > MAX_MATERIALS) store.remove(index[index.length - 1].id);
      saveIndex();
      return { ok: true, item: { ...meta } };
    },
    /** The stored content: a string for text, a Buffer for a PDF; null when unknown. */
    read(id) {
      const meta = store.meta(id);
      if (!meta) return null;
      if (!dir) return mem.has(id) ? mem.get(id) : null;
      try { return meta.kind === 'pdf' ? fs.readFileSync(/* turbopackIgnore: true */ fileOf(meta)) : fs.readFileSync(/* turbopackIgnore: true */ fileOf(meta), 'utf8'); } catch { return null; }
    },
    /** Keep a PDF's text layer to teach from instead (meta.textFallback: {chars, pages}). */
    setTextFallback(id, text, info) {
      const meta = store.meta(id);
      if (!meta) return null;
      if (dir) fs.writeFileSync(/* turbopackIgnore: true */ textFileOf(id), text); else texts.set(id, text);
      meta.textFallback = info;
      saveIndex();
      return { ...meta };
    },
    readText(id) {
      if (!store.meta(id)?.textFallback) return null;
      if (!dir) return texts.get(id) ?? null;
      try { return fs.readFileSync(/* turbopackIgnore: true */ textFileOf(id), 'utf8'); } catch { return null; }
    },
    remove(id) {
      const meta = store.meta(id);
      if (!meta) return null;
      index = index.filter((m) => m.id !== id);
      if (dir) { for (const f of [fileOf(meta), textFileOf(id)]) { try { fs.unlinkSync(/* turbopackIgnore: true */ f); } catch {} } } else { mem.delete(id); texts.delete(id); }
      saveIndex();
      return meta;
    },
    get size() { return index.length; },
  };
  return store;
}

// Upload ids start with the time they were made (11 hex digits of ms), so old ones can be found.
export const newUploadId = (now = Date.now()) => `up-${now.toString(16).padStart(11, '0').slice(-11)}${randomUUID().replace(/-/g, '').slice(0, 5)}`;
const uploadTime = (upload) => parseInt(upload.slice(3, 14), 16);

/**
 * Upload parts held in this process (no account sync: one server, one process). Every part store
 * (this one, server/sync/user-stores.js userUploadParts) has put / get / remove by upload and
 * index, and list() of its `${upload}.${index}` keys.
 */
export function createPartStore() {
  const parts = new Map(); // `${upload}.${index}` -> Buffer
  return {
    put: async (upload, index, bytes) => { parts.set(`${upload}.${index}`, bytes); },
    get: async (upload, index) => parts.get(`${upload}.${index}`) ?? null,
    remove: async (upload, index) => { parts.delete(`${upload}.${index}`); },
    list: async () => [...parts.keys()],
  };
}

/** The part indices stored for each upload: Map upload -> [index]. */
async function storedParts(parts) {
  const out = new Map();
  for (const key of await parts.list()) {
    const [upload, index] = key.split('.');
    if (!UPLOAD_ID_RE.test(upload) || !/^\d+$/.test(index ?? '')) continue;
    out.set(upload, [...(out.get(upload) || []), Number(index)]);
  }
  return out;
}

/**
 * Before a new upload starts: remove parts of uploads that were never finished, those older than
 * UPLOAD_MAX_AGE_MS and all but the newest MAX_OPEN_UPLOADS, so abandoned uploads can't pile up.
 */
export async function pruneUploads(parts, now = Date.now()) {
  const open = [...(await storedParts(parts))].sort(([a], [b]) => uploadTime(b) - uploadTime(a));
  const stale = open.filter(([upload], i) => i >= MAX_OPEN_UPLOADS || now - uploadTime(upload) > UPLOAD_MAX_AGE_MS);
  await Promise.all(stale.flatMap(([upload, indices]) => indices.map((i) => parts.remove(upload, i))));
}

/**
 * The parts of one upload as one Buffer, or null unless exactly parts 0..count-1 are stored.
 * The parts are removed either way.
 */
export async function takeUpload(parts, upload, count) {
  const n = Number(count);
  if (!UPLOAD_ID_RE.test(String(upload)) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS) return null;
  const indices = (await storedParts(parts)).get(upload) || [];
  const complete = indices.length === n && indices.every((i) => i < n);
  const bufs = complete ? await Promise.all(indices.map((_, i) => parts.get(upload, i))) : [];
  await Promise.all(indices.map((i) => parts.remove(upload, i)));
  return complete && bufs.every(Boolean) ? Buffer.concat(bufs) : null;
}

/**
 * A PDF's text layer (what text recognition put behind a scan's page images), page by page with
 * a "[Page N]" line before each page that has text. '' when it has none.
 */
export async function extractPdfText(bytes) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => [i + 1, String(t).replace(/\s+/g, ' ').trim()]).filter(([, t]) => t).map(([n, t]) => `[Page ${n}]\n${t}`).join('\n\n');
  } finally {
    await pdf.destroy?.();
  }
}

/**
 * The material as a Claude `document` block. Citations on (they become Cite pills); cached so a
 * steer or resume of the same lesson re-reads it from the prompt cache.
 */
export function documentBlock(meta, data, { citations = true, cache = true } = {}) {
  const source = meta.kind === 'pdf'
    ? { type: 'base64', media_type: 'application/pdf', data: Buffer.isBuffer(data) ? data.toString('base64') : String(data) }
    : { type: 'text', media_type: 'text/plain', data: String(data) };
  return {
    type: 'document',
    source,
    title: meta.title,
    ...(citations ? { citations: { enabled: true } } : {}),
    ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
  };
}

export const materialUrl = (id, page) => `/api/materials/file?id=${id}${page ? `#page=${page}` : ''}`;
export const isMaterialUrl = (u) => typeof u === 'string' && /^\/api\/materials\/file\?id=mat-[0-9a-f]{12}(#page=\d+)?$/.test(u);

/**
 * Map a document citation (char_location / page_location) to the url-keyed shape the source
 * registry uses for web results: one source per text material, one per PDF page.
 * `docs[i]` is the material sent as document_index i. Other citations pass through unchanged.
 */
export function materialCitation(docs) {
  return (c) => {
    if (!c || (c.type !== 'char_location' && c.type !== 'page_location')) return c;
    const meta = docs[Number(c.document_index) || 0];
    if (!meta) return null;
    const page = c.type === 'page_location' ? Number(c.start_page_number) || null : null;
    return { type: 'material', url: materialUrl(meta.id, page), title: page ? `${meta.title}, p. ${page}` : meta.title, cited_text: c.cited_text };
  };
}
