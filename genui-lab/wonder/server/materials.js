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
      if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return { ok: false, error: 'The PDF could not be read.' };
      buf = Buffer.from(b64, 'base64');
    }
    if (buf.length > MAX_PDF_BYTES) return { ok: false, error: `That PDF is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${MAX_PDF_BYTES / 1048576} MB.` };
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
    add(input) {
      const prepared = prepareMaterial(input);
      if (!prepared.ok) return prepared;
      const { meta, data } = prepared;
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
    remove(id) {
      const meta = store.meta(id);
      if (!meta) return null;
      index = index.filter((m) => m.id !== id);
      if (dir) { try { fs.unlinkSync(/* turbopackIgnore: true */ fileOf(meta)); } catch {} } else mem.delete(id);
      saveIndex();
      return meta;
    },
    get size() { return index.length; },
  };
  return store;
}

export const newUploadId = () => `up-${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Upload parts held in this process (no account sync: one server, one process). */
export function createPartStore({ max = MAX_PARTS * 8 } = {}) {
  const parts = new Map(); // `${upload}.${index}` -> Buffer, oldest first
  return {
    async put(upload, index, bytes) {
      parts.set(`${upload}.${index}`, bytes);
      for (const k of parts.keys()) { if (parts.size <= max) break; parts.delete(k); } // abandoned uploads
    },
    get: async (upload, index) => parts.get(`${upload}.${index}`) ?? null,
    remove: async (upload, index) => { parts.delete(`${upload}.${index}`); },
  };
}

/** The stored parts of one upload as one Buffer (and removed), or null when one is missing. */
export async function takeUpload(parts, upload, count) {
  const n = Number(count);
  if (!UPLOAD_ID_RE.test(String(upload)) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS) return null;
  const bufs = [];
  for (let i = 0; i < n; i++) bufs.push(await parts.get(upload, i));
  for (let i = 0; i < n; i++) await parts.remove(upload, i);
  return bufs.every(Boolean) ? Buffer.concat(bufs) : null;
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

/**
 * Demo mode (no Claude): a deterministic lesson from text material, its headings or paragraph
 * groups as pages, so the material flow works without credentials.
 */
export function demoMaterialLesson(meta, text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let cur = null;
  for (const raw of lines) {
    const h = /^#{1,3}\s+(.+)/.exec(raw.trim());
    if (h) { cur = { title: h[1].trim(), body: [] }; sections.push(cur); continue; }
    if (!cur) { cur = { title: '', body: [] }; sections.push(cur); }
    cur.body.push(raw);
  }
  let pages = sections.map((s) => ({ title: s.title, paras: s.body.join('\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean) })).filter((s) => s.paras.length);
  if (pages.length <= 1) {
    const paras = pages[0]?.paras || [];
    const per = Math.max(1, Math.ceil(paras.length / 3));
    pages = [0, 1, 2].map((i) => ({ title: '', paras: paras.slice(i * per, (i + 1) * per) })).filter((p) => p.paras.length);
  }
  pages = pages.slice(0, 4);
  const words = (s, n) => { const w = s.split(' '); return w.length > n ? `${w.slice(0, n).join(' ')}…` : s; };
  const out = [`# ${meta.title}`, '', `*Demo mode: a page-by-page outline of your material. With Claude connected, this becomes a full interactive lesson that cites your text.*`, ''];
  pages.forEach((p, i) => {
    out.push(`## ${p.title || `Part ${i + 1}`}`, '', words(p.paras.slice(0, 2).join(' '), 150), '');
    const key = p.paras[0].split(/(?<=[.!?])\s/)[0];
    out.push(`<Callout title="Key idea" tone="insight">${key.replace(/[<>{}]/g, '')}</Callout>`, '');
  });
  return `${out.join('\n').trim()}\n`;
}

/** Demo mode: a course whose lessons follow the material's headings (or its parts). */
export function demoMaterialCourse(meta, text, level = 'beginner') {
  const heads = String(text || '').split('\n').map((l) => /^#{1,3}\s+(.+)/.exec(l.trim())?.[1]?.trim()).filter(Boolean).slice(0, 9);
  const titles = heads.length >= 2 ? heads : ['The big picture', 'The key details', 'Putting it together'];
  const lessons = titles.map((t) => ({ title: t, summary: `Explain “${t}” in your own words, as your material puts it.` }));
  const sections = [];
  for (let i = 0; i < lessons.length; i += 3) sections.push({ title: i === 0 ? 'Getting started' : `Part ${sections.length + 1}`, lessons: lessons.slice(i, i + 3) });
  return { title: meta.title, description: `A course that follows your material “${meta.title}”.`, level, sections };
}
