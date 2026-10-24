// Account sync: the Wonder state (store.js) as per-record units, and how two versions of one
// record merge. Pure, shared by the browser (sync-client.js) and the server (server/sync/), and
// tested under node:test.
//
// A record is {kind, id, data}. The store's shape maps onto kinds like this:
//   courses[] -> course     lessons{} -> lesson      teacherThreads[] -> thread
//   plans[] -> plan          teacherLessons{} -> teacherLesson    mastery{} -> concept
//   deck.items[] -> card     deck.logs[] -> reviewLog (immutable, id entryId@review)
//   every other top-level key (settings, stats, awarded, deck's other fields as `deck`, and any
//   key a later phase adds) -> one `state` record whose id is the key.
// `memory` and `material` records belong to the server (learner memory, uploaded material):
// they share the per-user table but never travel to or from the browser state.
//
// Merge (server side, when a change was made against an older revision than the stored one):
//   deletes and plain records: the later edit (client updatedAt) wins
//   concept: union of evidence events     reviewLog: immutable
//   state/stats: max XP per day           state/awarded: union        state/settings: shallow merge

export const SERVER_KINDS = Object.freeze(['memory', 'material']);
export const CLIENT_KINDS = Object.freeze(['course', 'lesson', 'thread', 'plan', 'teacherLesson', 'concept', 'card', 'reviewLog', 'state']);
const LIST_SLOTS = { course: 'courses', thread: 'teacherThreads', plan: 'plans' };
const MAP_SLOTS = { lesson: 'lessons', teacherLesson: 'teacherLessons', concept: 'mastery' };
const SLOT_KEYS = new Set([...Object.values(LIST_SLOTS), ...Object.values(MAP_SLOTS)]);
const SKIP_KEYS = new Set(['version']);
const MAX_CONCEPT_EVENTS = 30;

export const recordKey = (kind, id) => `${kind}:${id}`;
export const logId = (log) => `${log?.entryId}@${log?.review}`;

/** Every record in a Wonder state, keyed by recordKey. */
export function toRecords(data) {
  const out = new Map();
  const put = (kind, id, value) => { if (typeof id === 'string' && id && value != null) out.set(recordKey(kind, id), { kind, id, data: value }); };
  for (const [kind, slot] of Object.entries(LIST_SLOTS)) for (const x of Array.isArray(data?.[slot]) ? data[slot] : []) put(kind, x?.id, x);
  for (const [kind, slot] of Object.entries(MAP_SLOTS)) for (const [id, v] of Object.entries(data?.[slot] || {})) put(kind, id, v);
  const deck = data?.deck || {};
  for (const e of Array.isArray(deck.items) ? deck.items : []) put('card', e?.id, e);
  for (const l of Array.isArray(deck.logs) ? deck.logs : []) put('reviewLog', logId(l), l);
  const { items: _i, logs: _l, ...deckRest } = deck;
  if (Object.keys(deckRest).length) put('state', 'deck', deckRest);
  for (const [k, v] of Object.entries(data || {})) {
    if (SKIP_KEYS.has(k) || SLOT_KEYS.has(k) || k === 'deck') continue;
    put('state', k, v);
  }
  return out;
}

/** The data of one record in a state (undefined when absent), without building every record. */
export function recordData(data, kind, id) {
  if (LIST_SLOTS[kind]) return (data?.[LIST_SLOTS[kind]] || []).find((x) => x?.id === id);
  if (MAP_SLOTS[kind]) return data?.[MAP_SLOTS[kind]]?.[id];
  if (kind === 'card') return (data?.deck?.items || []).find((e) => e?.id === id);
  if (kind === 'reviewLog') return (data?.deck?.logs || []).find((l) => logId(l) === id);
  if (kind === 'state') {
    if (id === 'deck') { const { items: _i, logs: _l, ...rest } = data?.deck || {}; return Object.keys(rest).length ? rest : undefined; }
    return SKIP_KEYS.has(id) || SLOT_KEYS.has(id) ? undefined : data?.[id] ?? undefined;
  }
  return undefined;
}

/**
 * Write records ({kind, id, data, deleted}) into a state, in place. New list items go first
 * (Wonder lists are newest first); new cards and logs go last. Unknown and server kinds are
 * ignored. Returns the state.
 */
export function applyRecords(data, records) {
  for (const r of records) {
    const { kind, id } = r;
    const gone = !!r.deleted || r.data === undefined || r.data === null;
    if (LIST_SLOTS[kind]) {
      const slot = LIST_SLOTS[kind];
      const list = Array.isArray(data[slot]) ? data[slot] : (data[slot] = []);
      const i = list.findIndex((x) => x?.id === id);
      if (gone) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = r.data; else list.unshift(r.data);
    } else if (MAP_SLOTS[kind]) {
      const slot = MAP_SLOTS[kind];
      const map = data[slot] && typeof data[slot] === 'object' ? data[slot] : (data[slot] = {});
      if (gone) delete map[id]; else map[id] = r.data;
    } else if (kind === 'card' || kind === 'reviewLog') {
      const deck = data.deck && typeof data.deck === 'object' ? data.deck : (data.deck = { items: [], logs: [] });
      const field = kind === 'card' ? 'items' : 'logs';
      const list = Array.isArray(deck[field]) ? deck[field] : (deck[field] = []);
      const match = kind === 'card' ? (x) => x?.id === id : (x) => logId(x) === id;
      const i = list.findIndex(match);
      if (gone) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = r.data;
      else if (kind === 'reviewLog') {
        const at = String(r.data?.review || '');
        let j = list.length;
        while (j > 0 && String(list[j - 1]?.review || '') > at) j--;
        list.splice(j, 0, r.data);
      } else list.push(r.data);
    } else if (kind === 'state') {
      if (SKIP_KEYS.has(id) || SLOT_KEYS.has(id)) continue;
      if (id === 'deck') {
        const deck = data.deck && typeof data.deck === 'object' ? data.deck : (data.deck = { items: [], logs: [] });
        for (const k of Object.keys(deck)) if (k !== 'items' && k !== 'logs') delete deck[k];
        if (!gone) Object.assign(deck, r.data, { items: deck.items || [], logs: deck.logs || [] });
      } else if (gone) delete data[id];
      else data[id] = r.data;
    }
  }
  return data;
}

/** A stable 53-bit string hash (cyrb53), so a sync base can remember records without copies. */
/** UTF-8 size of a string (request and response limits are in bytes, not characters). */
export const byteLength = (str) => (typeof Buffer !== 'undefined' ? Buffer.byteLength(str) : new TextEncoder().encode(str).length);

export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const DELETED_HASH = '-';
/** Hash of a record's data, or DELETED_HASH for an absent / deleted one. */
export const hashData = (value) => (value === undefined || value === null ? DELETED_HASH : hashString(JSON.stringify(value)));

/**
 * What changed since the last sync. `base` maps recordKey -> {rev, h} (h: hashData of the synced
 * version). Returns [{kind, id, data?, deleted?, baseRev, updatedAt}]: new or edited records, and
 * a tombstone for each synced record that is gone now.
 */
export function diffRecords(base, current, updatedAt = Date.now()) {
  const changes = [];
  for (const [key, r] of current) {
    const b = base.get(key);
    const h = hashData(r.data);
    if (!b || b.h !== h) changes.push({ kind: r.kind, id: r.id, data: r.data, baseRev: b?.rev || 0, updatedAt, h });
  }
  for (const [key, b] of base) {
    if (current.has(key) || b.h === DELETED_HASH) continue;
    const i = key.indexOf(':');
    changes.push({ kind: key.slice(0, i), id: key.slice(i + 1), deleted: true, baseRev: b.rev || 0, updatedAt, h: DELETED_HASH });
  }
  return changes;
}

// ---------------------------------------------------------------- merge rules

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeStats(a, b) {
  const days = { ...(a?.days || {}) };
  for (const [k, v] of Object.entries(b?.days || {})) days[k] = Math.max(Number(days[k]) || 0, Number(v) || 0);
  const sa = a?.streak || {};
  const sb = b?.streak || {};
  const later = String(sb.lastDate || '') > String(sa.lastDate || '') || (sb.lastDate === sa.lastDate && (sb.count || 0) > (sa.count || 0)) ? sb : sa;
  return {
    ...a, ...b,
    xp: Math.max(Number(a?.xp) || 0, Number(b?.xp) || 0),
    streak: { ...later, best: Math.max(Number(sa.best) || 0, Number(sb.best) || 0, Number(later.count) || 0) },
    days,
  };
}

function mergeConcept(older, newer) {
  const seen = new Set();
  const events = [];
  for (const e of [...(older?.events || []), ...(newer?.events || [])]) {
    const k = `${e?.at}|${e?.source}|${e?.score}`;
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(e);
  }
  events.sort((x, y) => String(x?.at || '').localeCompare(String(y?.at || '')));
  return { ...older, ...newer, events: events.slice(-MAX_CONCEPT_EVENTS) };
}

/**
 * Merge two versions of one record: `stored` {data, deleted, updatedAt} and `incoming` (same
 * shape), made concurrently. Returns {data, deleted, updatedAt}.
 */
export function mergeRecord(kind, id, stored, incoming) {
  const sAt = Number(stored?.updatedAt) || 0;
  const iAt = Number(incoming?.updatedAt) || 0;
  const [older, newer] = iAt >= sAt ? [stored, incoming] : [incoming, stored];
  const updatedAt = Math.max(sAt, iAt);
  const pick = (r) => ({ data: r.deleted ? null : r.data, deleted: !!r.deleted, updatedAt });
  if (stored?.deleted || incoming?.deleted || !isObj(stored?.data) || !isObj(incoming?.data)) return pick(newer);
  if (kind === 'reviewLog') return pick(stored);
  if (kind === 'concept') return { data: mergeConcept(older.data, newer.data), deleted: false, updatedAt };
  if (kind === 'state' && id === 'stats') return { data: mergeStats(older.data, newer.data), deleted: false, updatedAt };
  if (kind === 'state' && id === 'awarded') return { data: { ...older.data, ...newer.data }, deleted: false, updatedAt };
  if (kind === 'state' && id === 'settings') return { data: { ...older.data, ...newer.data }, deleted: false, updatedAt };
  return pick(newer);
}

/** Records -> a whole state (server side: the reminder cron reads a learner's state). */
export function recordsToState(records, empty = () => ({ version: 1, courses: [], lessons: {}, deck: { items: [], logs: [] }, stats: { xp: 0, streak: { count: 0, lastDate: null, best: 0 }, days: {} }, awarded: {}, teacherThreads: [], teacherLessons: {}, plans: [], mastery: {}, settings: {} })) {
  const live = records.filter((r) => !r.deleted && CLIENT_KINDS.includes(r.kind));
  // in revision order: applyRecords puts each new list item first, so lists end newest first
  return applyRecords(empty(), live.slice().sort((a, b) => (Number(a.rev) || 0) - (Number(b.rev) || 0)));
}

/** Does this state hold anything worth keeping (lessons, courses, cards, chats, plans, XP)? */
export function hasLearnerData(data) {
  return !!(Object.keys(data?.lessons || {}).length || data?.courses?.length || data?.deck?.items?.length || data?.teacherThreads?.length || data?.plans?.length || Number(data?.stats?.xp) > 0 || Object.keys(data?.mastery || {}).length);
}
