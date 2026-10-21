// Phase 4: mid-turn steering for lessons (ChatGPT steer_turn, chatgpt-findings §1.5).
//
//   POST /api/lesson/steer {operationId, instruction}
//     -> the in-flight lesson operation aborts its current Claude (or demo) stream
//     -> the open NDJSON response emits control steering-status accepted + steering-message,
//        a `replace` content record with the kept pages (trimmed to the last complete "## ")
//     -> a continuation request streams the rest: the original lesson request + a user turn
//        holding the lesson so far + the instruction. No assistant prefill.

//
//   POST /api/lesson/stream {…, continueFrom:{markdown, instruction?, fromPage?, messageId?, sources?}}
//     -> the same records without a live stream to steer: resume an interrupted lesson (no
//        instruction), steer it after a reload, or revise a finished lesson from page N.

import {
  trimToLastPage, keptForContinue, pageCount, pageOffsets, citeRefsIn, MAX_STEER_CHARS, STEER_CHIPS,
  MAX_CONTINUE_MARKDOWN, MAX_CONTINUE_SOURCES,
} from '../public/steering-core.js';
import { stripGroundingTags, createSourceRegistry, domainOf } from './grounding.js';

export { trimToLastPage };

/** In-flight steerable operations, keyed by the NDJSON operationId. */
export function createSteeringRegistry() {
  const ops = new Map();
  return {
    /** Register an operation. `parent` is the response-close signal. */
    open(operationId, parent, { onReject } = {}) {
      let ctrl = null;
      let pendingSteer = null;
      const op = {
        operationId,
        steerCount: 0,
        /** A fresh AbortSignal for the next upstream attempt (aborted by steer or by `parent`). */
        attempt() {
          ctrl = new AbortController();
          if (parent?.aborted) ctrl.abort();
          else parent?.addEventListener('abort', () => ctrl.abort(), { once: true });
          return ctrl.signal;
        },
        steer(instruction) {
          if (!ctrl || parent?.aborted || op.closed || pendingSteer) { onReject?.(pendingSteer ? 'busy' : 'not_streaming', instruction); return false; }
          pendingSteer = instruction;
          op.steerCount++;
          ctrl.abort();
          return true;
        },
        takeSteer() { const s = pendingSteer; pendingSteer = null; return s; },
        get hasSteer() { return pendingSteer != null; },
        closed: false,
        close() { op.closed = true; ops.delete(operationId); },
      };
      ops.set(operationId, op);
      return op;
    },
    get(operationId) { return ops.get(operationId) || null; },
    get size() { return ops.size; },
  };
}

export function cleanInstruction(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STEER_CHARS);
}

/**
 * The continuation request's single user turn: the original request, the lesson so far
 * (already on screen) and the instruction. Server-inserted Cite/Sources tags are removed so
 * Claude does not imitate them. No assistant prefill.
 *   mode 'steer'  (live steer, or a steer that arrived just after Claude finished)
 *   mode 'resume' (the stream was cut; with an instruction it is a steer after a reload)
 *   mode 'revise' (a finished lesson, rewritten from page `fromPage` on)
 */
export function steeringUserContent(originalRequest, keptMarkdown, instruction, { mode = 'steer', fromPage } = {}) {
  const kept = stripGroundingTags(keptMarkdown).trim();
  const ask = instruction ? `"${instruction}"` : '';
  const finishLine = 'Keep the lesson format, and still finish with the "## Check your understanding" page and its Quiz.';
  const lines = [];
  if (mode === 'revise') {
    lines.push(
      `The learner finished reading this lesson and asked you to rewrite it from page ${fromPage} on. Here are the pages they keep, unchanged:`,
      `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
      instruction ? `Their request for the rewritten pages: ${ask}` : 'Rewrite those pages with fresh explanations and examples.',
      kept
        ? `Write page ${fromPage} and every page after it again, applying that request to each of them. Start directly with the next "## " page heading. Do not repeat or rewrite anything above, and do not acknowledge the request in prose. ${finishLine}`
        : 'Write the whole lesson again with that request applied, following the lesson format.',
    );
  } else if (mode === 'resume' && !instruction) {
    lines.push(
      'You already started this lesson, but the connection dropped before you finished. Here is everything the learner can see so far:',
      `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
      kept
        ? `Continue the lesson from where it stopped. Start directly with the next "## " page heading. Do not repeat or rewrite anything above, and do not mention the interruption. ${finishLine}`
        : 'Write the whole lesson now, following the lesson format.',
    );
  } else {
    lines.push(
      mode === 'resume'
        ? 'You already started this lesson, but it stopped before you finished. Here is everything shown so far:'
        : 'You already started this lesson and the learner is reading it. Here is everything shown so far:',
      `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
      mode === 'resume' ? `The learner asked you to change course for the rest: ${ask}` : `While it was streaming, the learner asked you to change course: ${ask}`,
      kept
        ? `Continue the lesson from here, applying that request to every remaining page. Start directly with the next "## " page heading. Do not repeat or rewrite anything above, and do not acknowledge the request in prose. ${finishLine}`
        : 'Write the whole lesson now with that request applied, following the lesson format.',
    );
  }
  return [{ type: 'text', text: String(originalRequest) }, { type: 'text', text: lines.join('\n\n') }];
}

// ---------------------------------------------------------------- continueFrom

const MESSAGE_ID_RE = /^[\w-]{8,80}$/;
const REF_RE = /^turn(\d{1,3})search(\d{1,4})$/;
const clip = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) : t; };

/**
 * Validate `continueFrom` from the client. Returns null (absent), {error, status} or
 * {markdown, kept, instruction, fromPage, messageId, sources, mode}.
 */
export function normalizeContinueFrom(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'continueFrom must be an object', status: 400 };
  if (typeof raw.markdown !== 'string') return { error: 'continueFrom.markdown must be a string', status: 400 };
  if (raw.markdown.length > MAX_CONTINUE_MARKDOWN) return { error: 'continueFrom.markdown is too large', status: 413 };
  const markdown = raw.markdown.replace(/\r\n?/g, '\n');
  const instruction = cleanInstruction(raw.instruction);
  let fromPage = null;
  if (raw.fromPage != null) {
    const n = Number(raw.fromPage);
    const pages = pageCount(markdown);
    if (!Number.isInteger(n) || n < 1 || n > pages) return { error: `continueFrom.fromPage must be a page number from 1 to ${pages}`, status: 400 };
    fromPage = n;
  }
  const messageId = typeof raw.messageId === 'string' && MESSAGE_ID_RE.test(raw.messageId) ? raw.messageId : undefined;
  const kept = keptForContinue(markdown, fromPage);
  const sources = cleanSources(raw.sources, citeRefsIn(kept));
  return { markdown, kept, instruction, fromPage, messageId, sources, mode: fromPage ? 'revise' : 'resume' };
}

/** Client-sent source items, limited to refs the kept pages actually cite. */
function cleanSources(raw, keptRefs) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const urls = new Set();
  for (const s of raw.slice(0, MAX_CONTINUE_SOURCES)) {
    if (!s || typeof s !== 'object' || typeof s.ref !== 'string' || !REF_RE.test(s.ref) || !keptRefs.has(s.ref)) continue;
    if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url) || s.url.length > 2000 || urls.has(s.url)) continue;
    if (out.some((o) => o.ref === s.ref)) continue;
    urls.add(s.url);
    const n = Number(REF_RE.exec(s.ref)[2]);
    out.push({
      ref: s.ref,
      index: n + 1, // ref N <-> pill N+1, as createSourceRegistry numbers them
      url: s.url,
      title: clip(s.title, 160) || domainOf(s.url),
      domain: domainOf(s.url),
      snippet: clip(s.snippet, 300),
      ...(typeof s.page_age === 'string' && s.page_age.length <= 60 ? { page_age: s.page_age } : {}),
    });
  }
  return out;
}

/**
 * A source registry for a continued lesson (same interface as grounding.js
 * createSourceRegistry). The kept pages' sources are seeded so their Cite pills resolve on the
 * server, and the Sources list covers old and new. New refs continue after the highest ref in
 * the kept markdown (`turn0search<N+1>`, pill N+2), so ids never collide with kept Cite tags;
 * a URL that was already cited reuses its old ref and number.
 */
export function createContinuationSources({ turnIndex = 0, kept = '', seed = [] } = {}) {
  const inner = createSourceRegistry({ turnIndex }); // titles/snippets normalised by grounding.js
  const byRef = new Map();
  const byUrl = new Map();
  const innerToOuter = new Map();
  let next = 0;
  const bump = (ref) => { const m = REF_RE.exec(ref); if (m) next = Math.max(next, Number(m[2]) + 1); };
  for (const r of citeRefsIn(kept)) bump(r);
  for (const s of seed) { byRef.set(s.ref, { ...s }); byUrl.set(s.url, byRef.get(s.ref)); bump(s.ref); }
  const reg = {
    turnIndex,
    cite(c) {
      if (!c || typeof c.url !== 'string') return null;
      const known = byUrl.get(c.url);
      if (known) {
        if (!known.snippet && c.cited_text) known.snippet = clip(c.cited_text, 300);
        return known.ref;
      }
      const innerRef = inner.cite(c);
      if (!innerRef) return null;
      const meta = inner.get(innerRef);
      const s = { ...meta, ref: `turn${turnIndex}search${next}`, index: next + 1 };
      next++;
      innerToOuter.set(innerRef, s.ref);
      byRef.set(s.ref, s);
      byUrl.set(s.url, s);
      return s.ref;
    },
    noteResults(content) { inner.noteResults(content); },
    get(ref) { return byRef.get(ref) || null; },
    list() { return [...byRef.values()].sort((a, b) => a.index - b.index); },
    get size() { return byRef.size; },
    get searches() { return inner.searches; },
    toJSON() { return { turnIndex, sources: reg.list() }; },
  };
  return reg;
}

// ---------------------------------------------------------------- demo mode

const isProse = (block) => !/^\s*[<|>#-]/.test(block) && !/^\s*\d+\.\s/.test(block);

function shorten(paragraph) {
  if (/[<{]/.test(paragraph)) return paragraph; // tags inside: keep intact
  const sentences = paragraph.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return sentences.slice(0, 2).join(' ');
}

/**
 * Deterministic "steered" rewrite of the remaining demo pages: each page keeps its heading,
 * its first prose paragraph (two sentences at most) and every visual; extra prose is dropped.
 * The quiz page is kept as is. A tip callout acknowledges the request on the first page.
 */
export function steerDemoRemainder(remaining, instruction) {
  const text = String(remaining ?? '');
  const pages = text.split(/\n(?=## )/);
  const chip = STEER_CHIPS.find((c) => c.instruction === instruction || c.label.toLowerCase() === String(instruction || '').trim().toLowerCase());
  const label = (chip ? chip.label : String(instruction || 'Simpler')).replace(/["<>{}\\]/g, '').slice(0, 60);
  let acknowledged = false;
  const out = pages.map((page) => {
    const lines = page.split('\n');
    if (!/^## /.test(lines[0]) || /^## Check your understanding/i.test(lines[0])) return page;
    const blocks = lines.slice(1).join('\n').split(/\n{2,}/);
    const kept = [];
    let prose = 0;
    for (const b of blocks) {
      if (!b.trim()) continue;
      if (isProse(b)) { if (prose++ === 0) kept.push(shorten(b.trim())); continue; }
      kept.push(b.trim());
    }
    if (!acknowledged) acknowledged = true, kept.unshift(`<Callout title="Steered: ${label}" tone="tip">Got it. The rest of this lesson keeps each page to its core idea, in fewer words.</Callout>`);
    return `${lines[0]}\n\n${kept.join('\n\n')}\n`;
  });
  return out.join('\n');
}

/**
 * Demo continuation (deterministic): the sample's pages after the kept ones, grounded with the
 * continuation registry, rewritten with steerDemoRemainder when there is an instruction.
 * A revise rewrites from `fromPage`; a resume continues after the last kept page.
 */
export function demoContinuation(sample, keptMarkdown, instruction, { ground } = {}) {
  const pages = pageCount(keptMarkdown);
  const md = String(sample ?? '');
  const heads = pageOffsets(md);
  let rest = pages < heads.length ? md.slice(heads[pages]) : '';
  if (!rest && heads.length) rest = md.slice(heads[heads.length - 1]); // every page kept: redo the last one
  if (ground) rest = ground(rest);
  return instruction ? steerDemoRemainder(rest, instruction) : rest;
}
