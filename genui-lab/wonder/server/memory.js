// Learner memory (Wondering's learner_memory_items / teacher_memory lines, findings §5):
// short facts about the learner that personalize every lesson, tutor reply and Teacher turn.
//
// One JSON file (genui-lab/wonder/data/memory.json, git-ignored) holding
//   {version:1, items:[{id, fact, kind: goal|preference|struggle|background, source: teacher|lesson|user, createdAt}]}
// Writes are atomic (temp file + rename). Caps: at most 100 items (oldest dropped), facts at
// most 200 characters. `file: null` keeps the store in memory (tests).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MEMORY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'memory.json');
export const MEMORY_KINDS = Object.freeze(['goal', 'preference', 'struggle', 'background']);
export const MEMORY_SOURCES = Object.freeze(['teacher', 'lesson', 'user']);
export const MAX_ITEMS = 100;
export const MAX_FACT_CHARS = 200;
export const PROMPT_ITEMS = 15;

/** Collapse whitespace, strip control characters and markup-ish brackets, cap the length. */
export function cleanFact(fact) {
  const s = String(fact ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= MAX_FACT_CHARS) return s;
  return s.slice(0, MAX_FACT_CHARS - 1).replace(/\s+\S*$/, '') + '…';
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
// words longer than two letters, plus every number (numbers distinguish otherwise-similar facts)
const tokens = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 || /\d/.test(w)));

/** Same fact in other words? Exact normalized match or high token overlap. */
export function isDuplicateFact(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size < 3 || tb.size < 3) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.8;
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fact = cleanFact(raw.fact);
  if (!fact) return null;
  return {
    id: typeof raw.id === 'string' && /^[\w-]{4,64}$/.test(raw.id) ? raw.id : `mem-${randomUUID().slice(0, 8)}`,
    fact,
    kind: MEMORY_KINDS.includes(raw.kind) ? raw.kind : 'background',
    source: MEMORY_SOURCES.includes(raw.source) ? raw.source : 'user',
    createdAt: typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date().toISOString(),
  };
}

/**
 * @param {{file?: string|null, now?: () => Date, maxItems?: number, logger?: Console}} [opts]
 */
export function createMemoryStore({ file = DEFAULT_MEMORY_FILE, now = () => new Date(), maxItems = MAX_ITEMS, logger = console } = {}) {
  let items = null; // newest last

  function load() {
    if (items) return items;
    items = [];
    if (!file) return items;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed?.items) ? parsed.items : [];
      const seen = new Set();
      for (const raw of list) {
        const it = sanitizeItem(raw);
        if (it && !seen.has(it.id)) { seen.add(it.id); items.push(it); }
      }
      items = items.slice(-maxItems);
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn?.(`[wonder] memory file unreadable (${e.code || 'parse error'}); starting empty`);
    }
    return items;
  }

  function save() {
    if (!file) return;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.memory-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const api = {
    /** Newest first. */
    list() { return load().slice().reverse().map((i) => ({ ...i })); },
    get(id) { const it = load().find((i) => i.id === id); return it ? { ...it } : null; },
    get size() { return load().length; },
    /**
     * Add a fact. Returns {ok, item, duplicate} or {ok:false, error}.
     * A duplicate returns the existing item (and does not write).
     */
    add({ fact, kind, source = 'user' } = {}) {
      const clean = cleanFact(fact);
      if (!clean) return { ok: false, error: 'fact is required' };
      if (!MEMORY_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${MEMORY_KINDS.join(', ')}` };
      const list = load();
      const dup = list.find((i) => isDuplicateFact(i.fact, clean));
      if (dup) return { ok: true, item: { ...dup }, duplicate: true };
      const item = { id: `mem-${randomUUID().slice(0, 8)}`, fact: clean, kind, source: MEMORY_SOURCES.includes(source) ? source : 'user', createdAt: now().toISOString() };
      list.push(item);
      while (list.length > maxItems) list.shift();
      save();
      return { ok: true, item: { ...item }, duplicate: false };
    },
    /** Put back a previously removed item (undo), keeping its id and timestamp. */
    restore(raw) {
      const item = sanitizeItem(raw);
      if (!item) return { ok: false, error: 'invalid item' };
      const list = load();
      if (list.some((i) => i.id === item.id)) return { ok: true, item: { ...item }, duplicate: true };
      list.push(item);
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      while (list.length > maxItems) list.shift();
      save();
      return { ok: true, item: { ...item }, duplicate: false };
    },
    remove(id) {
      const list = load();
      const idx = list.findIndex((i) => i.id === id);
      if (idx < 0) return null;
      const [item] = list.splice(idx, 1);
      save();
      return { ...item };
    },
    clear() {
      const n = load().length;
      items = [];
      save();
      return n;
    },
    /**
     * Compact "About this learner" system block (newest PROMPT_ITEMS items), or '' when empty.
     * `withIds` adds the item ids so the Teacher can call forget{id}.
     */
    promptBlock({ withIds = false, limit = PROMPT_ITEMS } = {}) {
      const list = api.list().slice(0, limit);
      if (!list.length) return '';
      const lines = list.map((i) => `- ${withIds ? `(${i.id}) ` : ''}[${i.kind}] ${i.fact}`);
      return [
        'About this learner (from Wonder\'s learner memory; personalize with it quietly, never recite it back or mention "memory" unless the learner asks):',
        ...lines,
      ].join('\n');
    },
  };
  return api;
}
