// Search across the learner's own content: lessons, courses, deck cards and Teacher threads.
// Pure (no DOM, no Node APIs) so the browser and node:test share it.
//
// The index is plain text per field, folded once (lower case, accents stripped, same length as
// the original so match offsets map straight back for snippets). Searching scans the folded
// text with indexOf, which is a few milliseconds for ~200 lessons and ~2000 cards; the index
// is built lazily on the first query and cached until the caller's store revision changes.
//
// Ranking: every query word must match the start of a word somewhere in the item. A hit in a
// title-like field weighs more than one in the body, a whole-word hit a little more than a
// prefix, the whole query as a phrase in the title gets a bonus, and recency breaks ties.

import { pageOffsets } from './steering-core.js';

export const SEARCH_TYPES = Object.freeze(['lesson', 'course', 'card', 'thread']);
export const TYPE_LABELS = Object.freeze({ lesson: 'Lessons', course: 'Courses', card: 'Cards', thread: 'Teacher chats' });

// field weights: title-like fields first, bodies last
const W = { title: 10, topic: 6, term: 6, prompt: 8, lessonTitle: 5, answer: 4, description: 3, body: 2 };
const SNIPPET_BEFORE = 40;
const SNIPPET_LEN = 140;

// ---------------------------------------------------------------- text folding

const MARKS = /[̀-ͯ]/g;
const foldCache = new Map();
function foldChar(c) {
  let f = foldCache.get(c);
  if (f === undefined) {
    const n = c.normalize('NFD').replace(MARKS, '').toLowerCase();
    f = n.length ? n[0] : c; // keep one code unit per input code unit
    foldCache.set(c, f);
  }
  return f;
}

/** Lower case and strip accents, keeping the length (so offsets match the original). */
export function fold(text) {
  const s = String(text ?? '');
  if (!/[^\x00-\x7f]/.test(s)) return s.toLowerCase();
  let out = '';
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
  return out;
}

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Query words, folded ("Bayes' rule" -> ["bayes", "rule"]). */
export function queryTokens(query) {
  return fold(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
}

// ---------------------------------------------------------------- markdown to plain text

// attribute values that are styling or code, not words worth finding
const SKIP_ATTRS = new Set(['id', 'variant', 'color', 'background', 'size', 'radius', 'gap', 'padding', 'columns', 'fn', 'fns', 'icon', 'unit', 'tone', 'kind', 'href', 'src', 'xrange', 'yrange', 'params', 'query',
  'shows']); // <Video/>: query and shows are hidden search hints for the server, not lesson text
const SKIP_KEYS = new Set(['id', 'value', 'fn', 'icon', 'color', 'x', 'y', 'min', 'max', 'step', 'highlighted', 'correct', 'is_correct', 'iscorrect', 'correct_values', 'correct_index',
  // <Diagram/> geometry and wiring: shape kinds, path data, colors, part/step ids
  'type', 'd', 'fill', 'stroke', 'anchor', 'part', 'show', 'highlight',
  // question format codes (Quiz, Video)
  'question_type']);
// <Video/> question timing ("when":"before"); a Timeline's "when" date stays a word
const VIDEO_WHEN = /^(?:before|after|predict|start|first|end|pause)$/i;

/** The readable strings inside a component's props: `title="A" steps={[{"text":"B"}]}` -> "A B". */
function propText(attrs) {
  const out = [];
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|\{)/g;
  let m;
  while ((m = re.exec(attrs))) {
    const name = m[1].toLowerCase();
    if (m[2] != null || m[3] != null) {
      if (!SKIP_ATTRS.has(name)) out.push((m[2] ?? m[3]).replace(/\\(.)/g, '$1'));
      continue;
    }
    // {...}: balanced braces, quote-aware
    let depth = 1;
    let i = re.lastIndex;
    let inStr = false;
    for (; i < attrs.length && depth; i++) {
      const c = attrs[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
    }
    const inner = attrs.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
    if (SKIP_ATTRS.has(name)) continue;
    // JSON-ish: string values only, not keys ("label": ...) and not code-like keys
    const sre = /"((?:[^"\\]|\\.)*)"(\s*:)?/g;
    let key = '';
    let s;
    while ((s = sre.exec(inner))) {
      const v = s[1].replace(/\\(.)/g, '$1');
      if (s[2]) { key = v.toLowerCase(); continue; }
      if (!SKIP_KEYS.has(key) && /\p{L}/u.test(v) && !(key === 'when' && VIDEO_WHEN.test(v))) out.push(v);
      key = '';
    }
  }
  return out.join(' ');
}

/** Index of the ">" closing a tag whose attributes start at `i` (quote- and brace-aware), or -1. */
function tagEnd(src, i) {
  let depth = 0;
  let quote = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || (c === "'" && !depth)) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && !depth) return i;
    else if (c === '\n' && !depth && src[i + 1] === '\n') return -1; // a blank line ends any real tag
  }
  return -1;
}

/**
 * Lesson / message markdown (with DIL components) to plain text plus its KeyTerms.
 * Components keep the words in their props (titles, step text, quiz questions); layout
 * primitives (lowercase tags) and markdown syntax disappear.
 */
export function markdownToText(markdown) {
  const terms = [];
  const src = String(markdown ?? '');
  let s = '';
  let pos = 0;
  const open = /<([A-Za-z][\w.-]*)/g;
  let m;
  while ((m = open.exec(src))) {
    const end = tagEnd(src, open.lastIndex);
    if (end < 0) continue; // a stray "<": plain text
    const name = m[1];
    const attrs = src.slice(open.lastIndex, end).replace(/\/$/, '');
    s += src.slice(pos, m.index);
    if (name === 'KeyTerm') {
      const term = /\bterm\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attrs)?.[1] || '';
      const def = /\bdefinition\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attrs)?.[1] || '';
      if (term) terms.push(term);
      s += ` ${term}${def ? ` (${def})` : ''} `;
    } else if (/^[a-z]/.test(name)) s += ' '; // box, text, grid, math...: keep their children only
    else s += ` ${propText(attrs)} `;
    pos = end + 1;
    open.lastIndex = pos;
  }
  s += src.slice(pos);
  s = s.replace(/<\/[A-Za-z][\w.-]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\^?\d+\]/g, '')
    .replace(/^[ \t]*(```|~~~).*$/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+(.*?)[ \t]*$/gm, (all, h) => (/[.!?:]$/.test(h) ? h : `${h} ·`)) // headings read as headings in snippets
    .replace(/^[ \t]*(>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
    .replace(/\\([*_`[\]()#|\\])/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([.,;:!?)])/g, '$1');
  const text = s.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  return { text, terms };
}

/** A lesson's body as plain text with the offset where each "## " page starts (page n = index n-1). */
export function lessonText(markdown) {
  const md = String(markdown ?? '');
  const heads = pageOffsets(md);
  const cuts = [0, ...heads, md.length];
  let text = '';
  const pages = [];
  const terms = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    let part = md.slice(cuts[i], cuts[i + 1]);
    if (i === 0) part = part.replace(/^[ \t]*#\s+.*$/m, ''); // the "# Title" is indexed as the title
    const r = markdownToText(part);
    terms.push(...r.terms);
    if (i > 0) pages.push(text.length + (text && r.text ? 1 : 0));
    if (r.text) text += (text ? ' ' : '') + r.text;
  }
  return { text, pages, terms };
}

// ---------------------------------------------------------------- index

const field = (name, text, extra) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t ? { name, text: t, folded: fold(t), ...extra } : null;
};
const time = (...isos) => Math.max(0, ...isos.map((x) => Date.parse(x || '') || 0));

function lessonDoc(l) {
  const { text, pages, terms } = lessonText(l.markdown);
  const title = l.title || l.topic || 'Untitled lesson';
  return {
    type: 'lesson', id: l.id, title, href: `#/lesson/${l.id}`, time: time(l.updatedAt, l.createdAt),
    sub: l.finished ? 'Finished' : '',
    fields: [
      field('title', title),
      l.topic && fold(l.topic) !== fold(title) ? field('topic', l.topic) : null,
      terms.length ? field('term', [...new Set(terms)].join(' · ')) : null,
      field('body', text, { pages }),
    ].filter(Boolean),
  };
}

function courseDoc(c) {
  const lessons = (c.sections || []).flatMap((s) => (s.lessons || []).map((x) => x.title)).filter(Boolean);
  return {
    type: 'course', id: c.id, title: c.title || 'Untitled course', href: `#/course/${c.id}`, time: time(c.updatedAt, c.createdAt),
    sub: `${lessons.length} lesson${lessons.length === 1 ? '' : 's'}`,
    fields: [
      field('title', c.title),
      field('lessonTitle', lessons.join(' · ')),
      field('description', c.description),
    ].filter(Boolean),
  };
}

const cardPlain = (s) => String(s ?? '').replace(/____/g, '…').replace(/[*_`]/g, '');
function cardAnswer(it) {
  if (it.type === 'mcq') return (it.choices || []).filter((c) => c.isCorrect).map((c) => c.text).join(' · ');
  if (it.type === 'binary_choice') return it.answer === true ? 'True' : it.answer === false ? 'False' : '';
  if (it.type === 'flashcard') return it.back;
  if (it.type === 'explain') return it.sampleAnswer;
  return it.answer;
}

function cardDoc(e) {
  const it = e.item || {};
  const prompt = cardPlain(it.prompt || it.front);
  return {
    type: 'card', id: e.id, title: prompt || 'Card', lessonId: e.lessonId || null,
    href: e.lessonId ? `#/review/lesson/${e.lessonId}` : '#/review',
    time: time(e.card?.last_review, e.addedAt), sub: e.lessonTitle || '',
    fields: [
      field('prompt', prompt),
      field('answer', cardPlain(cardAnswer(it))),
      field('body', cardPlain(it.explanation)),
    ].filter(Boolean),
  };
}

function threadDoc(t) {
  const msgs = (t.messages || []).filter((m) => typeof m?.content === 'string' && m.content.trim());
  return {
    type: 'thread', id: t.id, title: t.title || 'Teacher chat', href: `#/teacher/${t.id}`, time: time(t.updatedAt, t.createdAt),
    sub: `${msgs.length} message${msgs.length === 1 ? '' : 's'}`,
    fields: [
      field('title', t.title),
      field('body', msgs.map((m) => markdownToText(m.content).text).join(' · ')),
    ].filter(Boolean),
  };
}

/** Build the searchable documents for a Wonder state. */
export function buildIndex(data) {
  const d = data || {};
  const docs = [];
  for (const l of Object.values(d.lessons || {})) if (l?.id) docs.push(lessonDoc(l));
  for (const c of d.courses || []) if (c?.id) docs.push(courseDoc(c));
  for (const e of d.deck?.items || []) if (e?.id) docs.push(cardDoc(e));
  for (const t of d.teacherThreads || []) if (t?.id) docs.push(threadDoc(t));
  return { docs };
}

// ---------------------------------------------------------------- matching

/** Word-start occurrences of `tok` in folded text (at most `cap`). */
function wordHits(folded, tok, cap = 4) {
  const out = [];
  let i = folded.indexOf(tok);
  while (i >= 0 && out.length < cap) {
    if (!isWordChar(folded[i - 1])) out.push(i);
    i = folded.indexOf(tok, i + 1);
  }
  return out;
}

function scoreDoc(doc, tokens, phrase) {
  let score = 0;
  const hits = new Map(); // field -> [[start, end]] for highlighting
  for (const tok of tokens) {
    let best = 0;
    for (const f of doc.fields) {
      const at = wordHits(f.folded, tok);
      if (!at.length) continue;
      const whole = at.some((i) => !isWordChar(f.folded[i + tok.length]));
      const s = W[f.name] * (whole ? 1.2 : 1) * (at[0] === 0 && f.name !== 'body' ? 1.25 : 1) + Math.min(at.length - 1, 3) * 0.25;
      if (s > best) best = s;
      const list = hits.get(f) || [];
      for (const i of at) list.push([i, i + tok.length]);
      hits.set(f, list);
    }
    if (!best) return null; // every word must match somewhere
    score += best;
  }
  if (tokens.length > 1) {
    for (const f of doc.fields) if (f.name !== 'body' && f.folded.includes(phrase)) { score += 5; break; }
  }
  const titleF = doc.fields.find((f) => f.name === 'title' || f.name === 'prompt');
  if (titleF && titleF.folded === phrase) score += 8;
  return { score, hits };
}

function mergeRanges(ranges) {
  const r = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([x[0], x[1]]);
  }
  return out;
}

/** Split `text[from, to)` into [{text, hit}] parts given match ranges. */
function parts(text, ranges, from = 0, to = text.length) {
  const out = [];
  let pos = from;
  for (const [a, b] of mergeRanges(ranges)) {
    if (b <= from || a >= to) continue;
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < to) out.push({ text: text.slice(pos, to), hit: false });
  return out;
}

/**
 * Highlight ranges in folded text: the whole query as a phrase, plus each word (words of one
 * or two letters only when the query has nothing longer, so "rule of 72" does not light up
 * every "of").
 */
function highlights(folded, tokens, phrase) {
  const long = tokens.some((t) => t.length > 2);
  const out = [];
  for (const t of tokens.length > 1 ? [phrase, ...tokens] : tokens) {
    if (long && t.length <= 2) continue;
    for (const i of wordHits(folded, t, 200)) out.push([i, i + t.length]);
  }
  return out;
}

/** A short window of `f.text` around `first` (a match offset), cut at word boundaries. */
function snippetOf(f, ranges, first = 0) {
  const text = f.text;
  let from = Math.max(0, first - SNIPPET_BEFORE);
  if (from > 0) { const sp = text.indexOf(' ', from); from = sp >= 0 && sp < first ? sp + 1 : from; }
  let to = Math.min(text.length, from + SNIPPET_LEN);
  if (to < text.length) { const sp = text.lastIndexOf(' ', to); if (sp > first) to = sp; }
  const p = parts(text, ranges, from, to);
  if (from > 0) p.unshift({ text: '…', hit: false });
  if (to < text.length) p.push({ text: '…', hit: false });
  return p;
}

const PREFERRED_SNIPPET = ['body', 'answer', 'term', 'lessonTitle', 'description', 'topic'];

/** Where a field's snippet should center: the whole query as a phrase, else the longest word's first hit. */
function anchorOf(f, ranges, tokens, phrase) {
  if (tokens.length > 1) {
    const at = wordHits(f.folded, phrase, 1)[0];
    if (at !== undefined) return at;
  }
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a), '');
  const r = ranges.filter((x) => x[1] - x[0] === longest.length && f.folded.startsWith(longest, x[0]));
  return Math.min(...(r.length ? r : ranges).map((x) => x[0]));
}

function toResult(doc, { score, hits }, tokens, phrase) {
  const titleF = doc.fields.find((f) => f.name === 'title' || f.name === 'prompt');
  const title = titleF ? parts(titleF.text, highlights(titleF.folded, tokens, phrase)) : [{ text: doc.title, hit: false }];
  // snippet: the best non-title field that matched, else the start of the body
  let snip = null;
  let page = 0;
  for (const name of PREFERRED_SNIPPET) {
    const f = doc.fields.find((x) => x.name === name && hits.has(x));
    if (!f) continue;
    const ranges = hits.get(f);
    const first = anchorOf(f, ranges, tokens, phrase);
    snip = snippetOf(f, highlights(f.folded, tokens, phrase), first);
    if (f.pages) page = f.pages.filter((p) => p <= first).length; // 0 = before the first "## " page
    break;
  }
  if (!snip) {
    const f = doc.fields.find((x) => x !== titleF && (x.name === 'body' || x.name === 'answer' || x.name === 'description'));
    if (f) snip = snippetOf(f, []);
  }
  return {
    type: doc.type, id: doc.id, href: doc.href, score, time: doc.time, sub: doc.sub,
    title, snippet: snip || [], page, ...(doc.lessonId !== undefined ? { lessonId: doc.lessonId } : {}),
  };
}

/**
 * Search an index. Returns results sorted by score, then recency:
 * {type, id, href, title: [{text, hit}], snippet: [{text, hit}], sub, page, score, time, lessonId?}.
 * `page` (lessons) is the 1-based "## " page holding the first body match, or 0.
 */
export function searchIndex(index, query, { limit = 50, types = SEARCH_TYPES } = {}) {
  const { scored, tokens, phrase } = rank(index, query, types);
  return scored.slice(0, limit).map(([doc, s]) => toResult(doc, s, tokens, phrase));
}

function rank(index, query, types = SEARCH_TYPES) {
  const tokens = queryTokens(query);
  const phrase = tokens.join(' ');
  const scored = [];
  if (!tokens.length || !index) return { scored, tokens, phrase };
  const want = new Set(types);
  for (const doc of index.docs) {
    if (!want.has(doc.type)) continue;
    const s = scoreDoc(doc, tokens, phrase);
    if (s) scored.push([doc, s]);
  }
  scored.sort((a, b) => b[1].score - a[1].score || b[0].time - a[0].time);
  return { scored, tokens, phrase };
}

/**
 * Search, grouped by type in SEARCH_TYPES order: [{type, label, total, results}] with at most
 * `perType` results each. Totals count every match; snippets are built only for those shown.
 */
export function searchGroups(index, query, { perType = 5, types = SEARCH_TYPES } = {}) {
  const { scored, tokens, phrase } = rank(index, query, types);
  return SEARCH_TYPES.map((type) => {
    const all = scored.filter(([doc]) => doc.type === type);
    return { type, label: TYPE_LABELS[type], total: all.length, results: all.slice(0, perType).map(([doc, s]) => toResult(doc, s, tokens, phrase)) };
  }).filter((g) => g.total);
}

/** Already-built results grouped the same way. */
export function groupResults(results, perType = 5) {
  return SEARCH_TYPES.map((type) => {
    const all = results.filter((r) => r.type === type);
    return { type, label: TYPE_LABELS[type], total: all.length, results: all.slice(0, perType) };
  }).filter((g) => g.results.length);
}

/**
 * A searcher that builds the index lazily and keeps it until `revision` changes (or the state
 * object is replaced). The UI bumps the revision on every store update.
 */
export function createSearcher() {
  let cache = null;
  return {
    index(data, revision) {
      if (!cache || cache.data !== data || cache.revision !== revision) cache = { data, revision, index: buildIndex(data) };
      return cache.index;
    },
    search(data, query, { revision, ...opts } = {}) {
      if (!queryTokens(query).length) return [];
      return searchIndex(this.index(data, revision), query, opts);
    },
    groups(data, query, { revision, ...opts } = {}) {
      if (!queryTokens(query).length) return [];
      return searchGroups(this.index(data, revision), query, opts);
    },
    clear() { cache = null; },
  };
}
