// Phase 3: grounded lessons. Claude's web_search server tool + text-block citations become
// ChatGPT-style inline <Cite refs={["turn0search3"]}/> pills and an end-of-lesson <Sources/>
// list, with the source data delivered as server-resolved componentResults (chatgpt-findings
// §3.4, §8: Cite state = {items, active_index, sources_title}).
//
//   Claude stream ──text_delta──────────▶ CiteAssembler ──append──▶ turn writer (markdown)
//                 ──citations_delta────▶   (after the cited span, at a safe point:
//                                            not inside a tag, code, math)
//                 ──server_tool_use────▶ onSearch(query)  -> reasoning "Searching the web…"
//                 ──web_search_tool_result▶ registry.noteResults (titles / errors)
//   compile result ──citeComponentResults──▶ appData.opGenui.componentResults[resolutionId]
//
// Claude never writes Cite tags itself: the server inserts them, so the refs always resolve.

import { scanComponentTags } from './compile.js';
import { idleWatch } from './claude.js';
import { protectMath } from './math-spans.js';
import { constRef } from './dil-constants.js';
import { isMaterialUrl } from './materials.js'; // Phase 10: citations of the learner's own material

// allowed_callers ["direct"]: with the default (dynamic filtering through code execution) the
// results reach Claude as encrypted code-execution stdout and the answer carries NO text-block
// citations (verified live). Direct calls keep web_search_result_location citations.
export const WEB_SEARCH_TOOL = Object.freeze({ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] });
export const MAX_PAUSE_CONTINUATIONS = 4;

/** Add the web_search server tool to stream params (never code_execution). */
export function withWebSearch(params, enabled = true) {
  if (!enabled) return params;
  const tools = (params.tools || []).filter((t) => t?.name !== 'web_search');
  return { ...params, tools: [...tools, { ...WEB_SEARCH_TOOL }] };
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const isSourceUrl = (u) => isHttp(u) || isMaterialUrl(u);

/**
 * Sources cited in one assistant turn. Each distinct URL gets a stable ChatGPT-style ref id
 * `turn<T>search<N>` in first-cited order; `index` (1-based) is the number on its pill.
 */
export function createSourceRegistry({ turnIndex = 0 } = {}) {
  const byUrl = new Map();
  const byRef = new Map();
  const seen = new Map(); // url -> {title, page_age} from search results (cited or not)
  let searches = 0;
  const reg = {
    turnIndex,
    /** Register one web_search_result_location citation; returns its ref id (or null). */
    cite(c) {
      if (!c || !isSourceUrl(c.url)) return null;
      let s = byUrl.get(c.url);
      if (!s) {
        const n = byUrl.size;
        const meta = seen.get(c.url) || {};
        s = {
          ref: `turn${turnIndex}search${n}`,
          index: n + 1,
          url: c.url,
          title: clip(c.title || meta.title || domainOf(c.url), 160),
          domain: isHttp(c.url) ? domainOf(c.url) : 'Your material',
          snippet: clip(c.cited_text, 300),
          ...(meta.page_age ? { page_age: meta.page_age } : {}),
        };
        byUrl.set(c.url, s);
        byRef.set(s.ref, s);
      } else if (!s.snippet && c.cited_text) s.snippet = clip(c.cited_text, 300);
      return s.ref;
    },
    /** Remember titles from a web_search_tool_result content list. */
    noteResults(content) {
      searches++;
      if (!Array.isArray(content)) return;
      for (const r of content) if (r?.type === 'web_search_result' && isHttp(r.url) && !seen.has(r.url)) seen.set(r.url, { title: r.title, page_age: r.page_age });
    },
    get(ref) { return byRef.get(ref) || null; },
    list() { return [...byUrl.values()]; },
    get size() { return byUrl.size; },
    get searches() { return searches; },
    toJSON() { return { turnIndex, sources: reg.list() }; },
  };
  return reg;
}

// ---------------------------------------------------------------- safe insertion points

/** True when a tag can be appended at the end of `md` without landing inside markup. */
export function isSafeInsertionPoint(md) {
  const src = String(md ?? '');
  // inside a code fence?
  let fenceOpen = false;
  for (const line of src.split('\n')) if (/^[ \t]*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
  if (fenceOpen) return false;
  const para = src.slice(src.lastIndexOf('\n\n') + 1);
  if (((para.match(/`/g) || []).length % 2) === 1) return false; // inline code span
  if ((para.match(/\\\(/g) || []).length > (para.match(/\\\)/g) || []).length) return false; // inline math
  if ((src.match(/<math\b/g) || []).length > (src.match(/<\/math>/g) || []).length) return false;
  // an unfinished $…$ / $$…$$ / \[…\] span: streaming mode holds it back, so the two passes differ
  if (protectMath(src, { partial: true }).source !== protectMath(src).source) return false;
  // a known catalog tag still being written (string/brace aware)
  const tags = scanComponentTags(src);
  if (tags.length && tags[tags.length - 1].kind === 'incomplete') return false;
  // any other half-written tag: "<box padding={4" or "<Cite refs="
  const tail = src.slice(src.lastIndexOf('>') + 1);
  if (/<\/?[A-Za-z][\w.-]*(\s[^<>]*)?$/.test(tail)) return false;
  return true;
}

export const citeTag = (refs) => `<Cite refs={${JSON.stringify(refs)}}/>`;

/**
 * Turns streamed text + citations into markdown with inline <Cite/> tags.
 * Trailing whitespace is held back so a cite lands right after the cited words
 * ("…in 1916<Cite/>.\n\n" rather than after the paragraph break).
 */
export function createCiteAssembler({ emit, registry }) {
  let out = '';
  let held = '';
  let blockRefs = null;
  let pending = [];
  const write = (s) => { if (s) { out += s; emit(s); } };
  const addPending = (refs) => { for (const r of refs) if (!pending.includes(r)) pending.push(r); };
  function tryInsert() {
    if (!pending.length || !isSafeInsertionPoint(out)) return false;
    write(citeTag(pending));
    pending = [];
    return true;
  }
  const api = {
    get markdown() { return out + held; },
    blockStart() { blockRefs = []; },
    citation(c) {
      const ref = registry.cite(c);
      if (!ref) return;
      if (blockRefs) { if (!blockRefs.includes(ref)) blockRefs.push(ref); } else addPending([ref]);
    },
    text(t) {
      if (!t) return;
      const all = held + t;
      const m = /\s+$/.exec(all);
      const body = m ? all.slice(0, m.index) : all;
      held = m ? m[0] : '';
      if (body && pending.length) {
        // deferred refs: insert at the first safe tag end / word boundary inside this chunk
        for (let i = 0; i < body.length; i++) {
          const cut = body[i] === '>' ? i + 1 : /\s/.test(body[i]) && i > 0 && !/\s/.test(body[i - 1]) ? i : -1;
          if (cut < 0 || !isSafeInsertionPoint(out + body.slice(0, cut))) continue;
          write(body.slice(0, cut));
          tryInsert();
          write(body.slice(cut));
          return;
        }
      }
      if (body) write(body);
      if (held) tryInsert(); // only at a word boundary
    },
    blockStop() {
      if (blockRefs?.length) addPending(blockRefs);
      blockRefs = null;
      tryInsert();
    },
    /** End of stream: drop refs that never found a safe spot inside markup, emit held text. */
    flush() {
      tryInsert();
      pending = [];
      const h = held;
      held = '';
      write(h);
    },
  };
  return api;
}

// ---------------------------------------------------------------- streaming with web search

const queryOf = (input) => (input && typeof input === 'object' && typeof input.query === 'string' ? input.query : null);

/**
 * Stream a grounded turn. Handles text/citation deltas, server_tool_use queries,
 * web_search_tool_result errors (they are result blocks, not exceptions) and pause_turn
 * (append the paused assistant content and re-send; no extra user message).
 * Throws SDK errors to the caller like streamText.
 */
const normPara = (t) => String(t).replace(/<Cite\b[^>]*\/>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const STOP = new Set('a an the of to in on and or but is are was were be been it its this that these those for with as at by from you your we our they their there here so than then just very can will would'.split(' '));
const tokens = (t) => normPara(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/**
 * Is `para` a repeat of `prev`? Exact after normalization, or a light rewording: most content
 * words shared (Jaccard >= 0.6), or almost all of `para`'s words present in `prev`.
 * Headings must match more strictly (they are short).
 */
export function isRepeat(para, prev) {
  const a = normPara(para);
  const b = normPara(prev);
  if (!a || !b) return false;
  if (a === b) return true;
  const heading = /^#{1,6}\s/.test(a) || /^#{1,6}\s/.test(b);
  if (heading && (!/^#{1,6}\s/.test(a) || !/^#{1,6}\s/.test(b))) return false;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size < 3 || tb.size < 3) return heading && [...ta].join(' ') === [...tb].join(' ');
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  // containment is measured on the NEW text: a paragraph that adds a sentence to an old one is
  // not a repeat (its repeated lead sentence is trimmed by trimRepeatedLead instead)
  const containment = inter / ta.size;
  return heading ? jaccard >= 0.8 : jaccard >= 0.6 || containment >= 0.85;
}

/** Split prose into sentences (keeps each sentence's trailing punctuation and spacing). */
export function splitSentences(text) {
  return String(text).match(/[^.!?]+(?:[.!?]+(?:["')\]]+)?\s*|$)/g)?.filter((x) => x) ?? [];
}

/** Is `sentence` a repeat of one of `prior` (normalized equal, or a light rewording)? */
function sentenceRepeats(sentence, prior) {
  const n = normPara(sentence);
  if (!n) return false;
  const ta = new Set(tokens(n));
  for (const p of prior) {
    if (normPara(p) === n) return true;
    if (ta.size < 5) continue;
    const tb = new Set(tokens(p));
    if (tb.size < 5) continue;
    let inter = 0;
    for (const w of ta) if (tb.has(w)) inter++;
    if (inter / (ta.size + tb.size - inter) >= 0.7) return true;
  }
  return false;
}

/**
 * Drop the leading sentences of `para` that repeat sentences of `priorText` (a model resuming
 * after a search or an interruption sometimes restates the last thing it wrote, then goes on).
 * Headings, markup and component tags are never trimmed. Returns the trimmed paragraph.
 */
export function trimRepeatedLead(para, priorText) {
  const text = String(para);
  if (!text.trim() || /^\s*(#|<|[-*+]\s|\d+[.)]\s|>|\||```|~~~|\$\$)/.test(text)) return text;
  const prior = splitBlocksForRepeat(priorText).flatMap(splitSentences).slice(-80);
  if (!prior.length) return text;
  const lead = /^\s*/.exec(text)[0];
  const sents = splitSentences(text.slice(lead.length));
  let k = 0;
  while (k < sents.length - 1 && sentenceRepeats(sents[k], prior)) k++; // always keep the last sentence for the paragraph check
  return k ? lead + sents.slice(k).join('') : text;
}
const splitBlocksForRepeat = (md) => String(md ?? '').split(/\n\s*\n/).filter((b) => b.trim() && !/^\s*(#|<|```|~~~)/.test(b));

/**
 * After a web search Claude sometimes starts over, re-writing the title and hook it already
 * streamed. This filter sits in front of the cite assembler: right after a search it buffers
 * text paragraph by paragraph and drops any paragraph (heading included) identical to one
 * already emitted (or a light rewording of one, see isRepeat), then passes everything through
 * once new text appears.
 */
export function createRepeatFilter(asm) {
  let emitted = '';
  let checking = false;
  let buf = '';
  let sep = ''; // blank lines held while checking (kept if the following text is new)
  let cites = [];
  const seen = () => emitted.split(/\n\s*\n|\n(?=#)/).filter((p) => normPara(p));
  const pass = (t) => { emitted += t; asm.text(t); };
  const release = () => {
    if (sep || buf) pass(sep + buf);
    sep = '';
    for (const c of cites) asm.citation(c);
    buf = ''; cites = []; checking = false;
  };
  const drain = (final) => {
    for (;;) {
      const m = /\n\s*\n|\n(?=#)/.exec(buf);
      const para = m ? buf.slice(0, m.index) : final ? buf : null;
      if (para === null) return;
      const n = normPara(para);
      if (!n) { if (!m) return; sep += buf.slice(0, m.index + m[0].length); buf = buf.slice(m.index + m[0].length); continue; }
      if (!seen().some((p) => isRepeat(para, p))) {
        const trimmed = trimRepeatedLead(para, emitted);
        if (trimmed !== para) buf = trimmed + buf.slice(para.length);
        return release();
      }
      buf = m ? buf.slice(m.index + m[0].length) : '';
      cites = [];
      if (!m) return;
    }
  };
  // A new text block (e.g. after a search) can start with block markup without the blank
  // line it needs: "…far side.## The Moon" would not render as a heading.
  let blockHead = null; // leading text of the current block, until its first non-space char
  const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<[A-Z]|```|~~~|\$\$)/;
  const separate = (t) => {
    if (blockHead === null) return t;
    blockHead += t;
    const lead = /^\s*/.exec(blockHead)[0];
    if (lead.length === blockHead.length) return ''; // only whitespace so far: hold it
    const body = blockHead.slice(lead.length);
    if (/^(#{1,6}|[-*+]|\d{1,3}[.)]?|<|`{1,2}|~{1,2}|\$)$/.test(body)) return ''; // could still open a block: wait
    const prev = emitted + sep + buf;
    blockHead = null;
    if (!prev.trim() || !BLOCK_START.test(body)) return lead + body;
    const have = (/\n*$/.exec(prev)[0] + (lead.match(/\n/g) || []).join('')).length;
    return (have >= 2 ? lead : '\n'.repeat(2 - Math.min(have, 2)) + lead) + body;
  };
  return {
    afterSearch() { if (emitted.trim()) checking = true; },
    blockStart() { blockHead = ''; asm.blockStart(); },
    text(t0) {
      const t = separate(t0);
      if (!t) return;
      if (!checking) return pass(t);
      buf += t;
      if (/^\s*$/.test(buf)) return;
      drain(false);
    },
    citation(c) { if (checking) cites.push(c); else asm.citation(c); },
    blockStop() { if (blockHead) { const t = blockHead; blockHead = null; if (checking) buf += t; else pass(t); } if (checking) { drain(true); if (checking) release(); } asm.blockStop(); },
    flush() { if (checking) release(); },
  };
}

export async function streamGrounded(client, params, { onText, onSearch, onSearchError, signal, registry, mapCitation, maxContinuations = MAX_PAUSE_CONTINUATIONS, idleMs } = {}) {
  const sources = registry || createSourceRegistry();
  // mapCitation (Phase 10): document citations of the learner's material -> url-keyed sources
  const reg = mapCitation ? { ...sources, cite: (c) => { const m = mapCitation(c); return m ? sources.cite(m) : null; } } : sources;
  const asm0 = createCiteAssembler({ emit: (s) => onText?.(s), registry: reg });
  const asm = createRepeatFilter(asm0); // drops a re-written title/hook after a search
  let p = params;
  let message = null;
  let continuations = 0;
  for (;;) {
    const watch = idleWatch(signal, idleMs);
    const stream = client.beta.messages.stream(p, { signal: watch.signal });
    const blocks = new Map();
    try {
    for await (const ev of stream) {
      watch.touch();
      if (ev.type === 'content_block_start') {
        const b = ev.content_block || {};
        blocks.set(ev.index, { type: b.type, name: b.name, json: '' });
        if (b.type === 'text') {
          asm.blockStart();
          for (const c of b.citations || []) asm.citation(c);
          if (b.text) asm.text(b.text);
        } else if (b.type === 'server_tool_use') {
          const q = queryOf(b.input);
          asm.afterSearch();
          if (q || b.name !== 'web_search') { blocks.get(ev.index).reported = true; onSearch?.(q, b.name); }
        } else if (b.type === 'web_search_tool_result') {
          if (b.content && !Array.isArray(b.content)) onSearchError?.(b.content.error_code || 'unavailable');
          else sources.noteResults(b.content);
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta') asm.text(d.text);
        else if (d.type === 'citations_delta') asm.citation(d.citation);
        else if (d.type === 'input_json_delta') { const b = blocks.get(ev.index); if (b) b.json += d.partial_json || ''; }
      } else if (ev.type === 'content_block_stop') {
        const b = blocks.get(ev.index);
        if (b?.type === 'text') asm.blockStop();
        else if (b?.type === 'server_tool_use' && !b.reported) {
          let input = null;
          try { input = JSON.parse(b.json || '{}'); } catch {}
          onSearch?.(queryOf(input), b.name);
        }
      }
    }
    message = await stream.finalMessage();
    } catch (err) {
      watch.rethrow(err);
    } finally {
      watch.done();
    }
    if (message.stop_reason === 'pause_turn' && continuations < maxContinuations) {
      continuations++;
      const msgs = [...p.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') msgs[msgs.length - 1] = { role: 'assistant', content: [...(Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }]), ...message.content] };
      else msgs.push({ role: 'assistant', content: message.content });
      p = { ...p, messages: msgs };
      continue;
    }
    break;
  }
  asm.flush();
  asm0.flush();
  return { stopReason: message.stop_reason, message, continuations, sources };
}

// ---------------------------------------------------------------- componentResults

const OBJ_RE = /__dil\.jsx\((Cite|Sources),\{([^{}]*)\}/g;
const item = (s) => ({ ref: s.ref, ref_id: s.ref, index: s.index, url: s.url, title: s.title, domain: s.domain, source_label: s.domain, snippet: s.snippet || null, ...(s.page_age ? { page_age: s.page_age } : {}) });

/** Resolved state for every Cite/Sources in a compiled program (keyed by __resolutionId). */
export function citeComponentResults(result, registry) {
  const out = {};
  if (!result?.code || !registry?.size) return out;
  OBJ_RE.lastIndex = 0;
  let m;
  while ((m = OBJ_RE.exec(result.code))) {
    const rid = result.constants?.[constRef(m[2], '__resolutionId')];
    if (typeof rid !== 'string') continue;
    if (m[1] === 'Cite') {
      const refs = result.constants?.[constRef(m[2], 'refs')];
      const items = (Array.isArray(refs) ? refs : []).map((r) => registry.get(String(r))).filter(Boolean).map(item);
      if (items.length) out[rid] = { status: 'resolved', state: { items, active_index: 0, sources_title: `${items.length} source${items.length === 1 ? '' : 's'}` } };
    } else {
      const items = registry.list().map(item);
      out[rid] = { status: 'resolved', state: { items, sources_title: `Sources (${items.length})` } };
    }
  }
  return out;
}

/** appData factory for the turn writer: merges static appData with resolved citations. */
export function citationAppData(registry, base) {
  return (result) => {
    const op = base?.opGenui || {};
    return { ...(base || {}), opGenui: { modelDataBindings: {}, ...op, componentResults: { ...(op.componentResults || {}), ...citeComponentResults(result, registry) } } };
  };
}

export const SOURCES_TAG = '<Sources/>';
/** Remove server-inserted grounding tags (for prompts that quote a lesson back to Claude). */
export function stripGroundingTags(md) {
  return String(md ?? '').replace(/<Cite\s+refs=\{[^{}]*\}\s*\/>/g, '').replace(/\n*<Sources\s*\/>\n*/g, '\n');
}
