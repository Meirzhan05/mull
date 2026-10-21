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
//        An interrupted lesson (resume, with or without an instruction) keeps every complete
//        paragraph/block of the page it stopped on (trimToLastBlock), not just complete pages,
//        and the continuation stream is passed through createContinuationGuard so a repeated
//        heading/paragraph at its start is dropped.

import {
  trimToLastPage, trimBeforePage, pageCount, pageOffsets, pageTitles, citeRefsIn, MAX_STEER_CHARS, STEER_CHIPS,
  MAX_CONTINUE_MARKDOWN, MAX_CONTINUE_SOURCES,
} from '../public/steering-core.js';
import { stripGroundingTags, isRepeat, trimRepeatedLead, splitSentences, createSourceRegistry, domainOf } from './grounding.js';
import { scanComponentTags } from './compile.js';
import { protectMath } from './math-spans.js';
import { PRIMITIVE_TAGS } from '../../chatgpt-dil/src/compiler.js';

export { trimToLastPage };

// ---------------------------------------------------------------- paragraph-boundary trimming
//
// Resume keeps everything up to the last complete block: a cut point is the start of a line
// that follows a blank line, and it is only accepted when the kept prefix
//   - is outside a code fence,
//   - has no half-written component tag (scanComponentTags: an "incomplete" tag, e.g. JSON
//     props still streaming) and no component or primitive element left open (<Callout>…,
//     <grid>…),
//   - has no math span left open ($…$, $$…$$, \[…\], \(…\), <math>…</math>: protectMath in
//     partial mode holds nothing back),
//   - does not end in a list, table or blockquote that may still continue (the text after the
//     cut must already have started a different kind of block).
// The page-level cut (trimToLastPage) is the floor: never keep less than that.

const RAW_PRIMITIVES = new Set(['math', 'code', 'markdown', 'text-only-markdown']);
const LISTISH = /^[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|\|)/;
const CONTINUES_LIST = /^(?:[ \t]+\S|[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|\|))/;

/** End (exclusive) of the tag at src[i] === '<' (quote- and brace-aware), or -1 if unterminated. */
function tagEnd(src, i) {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || (depth > 0 && c === '`')) {
      let k = j + 1;
      while (k < src.length && src[k] !== c) k += depth > 0 && src[k] === '\\' ? 2 : 1;
      if (k >= src.length) return -1;
      j = k;
    } else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return j + 1;
  }
  return -1;
}

/** True when every primitive element (<grid>, <box>, <math>…) opened in `src` is closed. */
function primitivesClosed(src) {
  const stack = [];
  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    const c = src[i];
    if (atLineStart) {
      const fm = /^[ \t]*(`{3,}|~{3,})/.exec(src.slice(i, i + 64));
      if (fm) {
        const re = new RegExp('\\n[ \\t]*' + fm[1][0] + '{' + fm[1].length + ',}[ \\t]*(?=\\n|$)', 'g');
        re.lastIndex = i + fm[0].length;
        const em = re.exec(src);
        if (!em) return false; // open fence
        i = em.index + em[0].length;
        atLineStart = false;
        continue;
      }
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i, i + 16))[0];
      const close = src.indexOf(run, i + run.length);
      const para = src.indexOf('\n\n', i);
      if (close >= 0 && (para < 0 || close < para)) { i = close + run.length; atLineStart = false; continue; }
    }
    if (c === '<') {
      const m = /^<(\/?)([a-z][\w-]*)/.exec(src.slice(i, i + 40));
      if (m && PRIMITIVE_TAGS.has(m[2])) {
        const end = tagEnd(src, i);
        if (end < 0) return false; // half-written tag
        const name = m[2];
        if (m[1]) {
          const at = stack.lastIndexOf(name);
          if (at >= 0) stack.length = at;
        } else if (src[end - 2] !== '/') {
          if (RAW_PRIMITIVES.has(name)) {
            const close = src.indexOf(`</${name}>`, end);
            if (close < 0) return false;
            i = close + name.length + 3;
            atLineStart = false;
            continue;
          }
          stack.push(name);
        }
        i = end;
        atLineStart = false;
        continue;
      }
    }
    atLineStart = c === '\n';
    i++;
  }
  return stack.length === 0;
}

/** True when no component tag is half-written or left open in `src`. */
function componentsClosed(src) {
  const depth = new Map();
  for (const t of scanComponentTags(src)) {
    if (t.kind === 'incomplete') return false;
    if (t.kind === 'open' && !t.selfClosing) depth.set(t.name, (depth.get(t.name) || 0) + 1);
    if (t.kind === 'close') depth.set(t.name, Math.max(0, (depth.get(t.name) || 0) - 1));
  }
  for (const n of depth.values()) if (n > 0) return false;
  return true;
}

const mathClosed = (src) => protectMath(src, { partial: true }).source === protectMath(src, { partial: false }).source;

// Prefix checks are pure in the prefix; resuming (and the every-prefix tests) re-check the same
// prefixes, so keep a small memo.
const prefixMemo = new Map();
function prefixSafe(prefix) {
  let v = prefixMemo.get(prefix);
  if (v === undefined) {
    v = componentsClosed(prefix) && primitivesClosed(prefix) && mathClosed(prefix);
    if (prefixMemo.size > 512) prefixMemo.clear();
    prefixMemo.set(prefix, v);
  }
  return v;
}

/** Cut points: offsets of lines that follow a blank line, outside code fences. */
function blockStarts(md) {
  const out = [];
  let fence = null;
  let prevBlank = false;
  let pos = 0;
  for (const line of md.split('\n')) {
    if (!fence && prevBlank && pos > 0 && pos <= md.length) out.push(pos);
    const fm = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) { if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !line.trim().slice(fm[1].length).trim()) fence = null; }
    else if (fm) fence = fm[1];
    prevBlank = !fence && line.trim() === '';
    pos += line.length + 1;
  }
  return out;
}

/** The last non-blank block before `p` (lines since the previous blank line). */
function blockBefore(md, p) {
  const lines = md.slice(0, p).replace(/\s+$/, '').split('\n');
  let i = lines.length - 1;
  while (i > 0 && lines[i - 1].trim() !== '') i--;
  return lines.slice(i);
}

function cutIsSafe(md, p) {
  const last = blockBefore(md, p);
  if (!last.length || !last.join('').trim()) return false;
  if (last.some((l) => LISTISH.test(l))) {
    // a list / table / blockquote is only finished once a different block has started after it
    const next = md.slice(p).split('\n').find((l) => l.trim() !== '');
    if (next === undefined || CONTINUES_LIST.test(next)) return false;
  }
  return prefixSafe(md.slice(0, p));
}

/**
 * Everything up to the last complete paragraph/block (see above), never less than
 * trimToLastPage. The result ends at a line start after a blank line (or is the page floor).
 */
export function trimToLastBlock(markdown) {
  const md = String(markdown ?? '');
  const floor = trimToLastPage(md);
  const cuts = blockStarts(md).filter((p) => p > floor.length);
  for (let k = cuts.length - 1; k >= 0; k--) if (cutIsSafe(md, cuts[k])) return md.slice(0, cuts[k]);
  return floor;
}

/** The kept part of a continuation: pages before `fromPage` (revise), else complete blocks (resume). */
export function keptForResume(markdown, fromPage) {
  return fromPage ? trimBeforePage(markdown, fromPage) : trimToLastBlock(markdown);
}

/** Heading text of the page the kept text stops on ('' before the first "## "). */
export function currentPageTitle(kept) {
  const t = pageTitles(kept);
  return t.length ? t[t.length - 1] : '';
}

// ---------------------------------------------------------------- duplicate guard
//
// The continuation is asked not to repeat anything, but a model resuming mid-page sometimes
// re-emits the page heading or the last paragraph. The guard buffers the start of the stream
// and drops every leading block that matches (exactly, or after whitespace/case normalisation
// and with Cite tags removed) a block of the kept text, then passes everything through.

const normBlock = (s) => stripGroundingTags(s).replace(/\s+/g, ' ').trim().toLowerCase();

function splitBlocks(md) {
  return String(md ?? '').split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean);
}

export function createContinuationGuard(kept) {
  const k = String(kept ?? '');
  const cands = new Set(splitBlocks(k).map(normBlock).filter(Boolean));
  let open = cands.size > 0;
  let buf = '';
  let started = false;
  let dropped = 0;
  const keptEndsLine = !k || k.endsWith('\n');
  const release = (s) => {
    if (!started && keptEndsLine) s = s.replace(/^\n+/, ''); // the kept text already ends the block
    if (s) started = true;
    return s;
  };
  const isPrefixOfCandidate = (n) => { for (const c of cands) if (c.startsWith(n)) return true; return false; };
  const blocks = splitBlocks(k);
  // the continuation may also open by restating one of the kept text's last sentences
  const sentCands = splitSentences(stripGroundingTags(k).split(/\n[ \t]*\n/).filter((b) => b.trim() && !/^\s*(#|<)/.test(b)).slice(-3).join(' ')).map(normBlock).filter((x) => x.length > 12);
  const isPrefixOfSentence = (n) => sentCands.some((c) => c.startsWith(n) || n.startsWith(c) && n.length < c.length + 3);
  // a block repeats the kept text exactly (normalized) or as a light rewording (isRepeat)
  const isCand = (b) => cands.has(normBlock(b)) || blocks.some((c) => isRepeat(stripGroundingTags(b), stripGroundingTags(c)));
  // the first new block may still open by restating the kept text's last sentences
  const trimLead = (s) => {
    const m = /\n[ \t]*\n/.exec(s);
    const first = m ? s.slice(0, m.index) : s;
    const t = trimRepeatedLead(first, stripGroundingTags(k));
    return t === first ? s : t + s.slice(first.length);
  };
  return {
    get dropped() { return dropped; },
    /** Feed streamed text; returns the text to emit now ('' while undecided). */
    push(text) {
      if (!open) return release(String(text));
      buf += String(text);
      for (;;) {
        const body = buf.replace(/^\s+/, '');
        const m = /\n[ \t]*\n/.exec(body);
        if (m) {
          if (isCand(body.slice(0, m.index))) {
            buf = body.slice(m.index + m[0].length);
            dropped++;
            continue;
          }
        } else {
          const n = normBlock(body.replace(/<[^<>]*$/, '')); // a tag still arriving (e.g. a Cite pill)
          if (!n || isPrefixOfCandidate(n) || isPrefixOfSentence(n)) return ''; // could still be a repeat: wait
        }
        open = false;
        const out = trimLead(buf);
        buf = '';
        return release(out);
      }
    },
    /** End of stream: a buffered block that is a full repeat is dropped, anything else emitted. */
    flush() {
      if (!open) return '';
      open = false;
      const out = buf;
      buf = '';
      if (isCand(out)) { dropped++; return ''; }
      return release(trimLead(out));
    },
  };
}

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
 *   mode 'steer'  (live steer, or a steer that arrived just after Claude finished): page level
 *   mode 'resume' (the stream was cut; with an instruction it is a steer after a reload): the
 *                 kept text ends at a paragraph boundary, so Claude continues seamlessly from
 *                 the very next sentence of the page it stopped on
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
  } else if (mode === 'resume') {
    // an interrupted lesson: the kept text ends at a paragraph boundary, possibly mid-page
    const page = currentPageTitle(kept);
    const where = page ? `, possibly partway through the page "## ${page}"` : '';
    const seamless = kept
      ? `It stopped right after the last line above${where}. Continue from the very next sentence; do not repeat or rewrite anything above; keep the same page structure. ${page ? `If that page is not finished, finish it first without writing its "## " heading again, then write the remaining pages.` : 'Then write the pages.'} ${finishLine}`
      : '';
    if (!instruction) {
      lines.push(
        'You already started this lesson, but the connection dropped before you finished. Here is everything the learner can see so far:',
        `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
        kept ? `${seamless} Do not mention the interruption.` : 'Write the whole lesson now, following the lesson format.',
      );
    } else {
      lines.push(
        'You already started this lesson, but it stopped before you finished. Here is everything shown so far:',
        `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
        `The learner asked you to change course for the rest: ${ask}`,
        kept
          ? `Apply that request to everything you write from here on. ${seamless} Do not acknowledge the request in prose.`
          : 'Write the whole lesson now with that request applied, following the lesson format.',
      );
    }
  } else {
    lines.push(
      'You already started this lesson and the learner is reading it. Here is everything shown so far:',
      `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
      `While it was streaming, the learner asked you to change course: ${ask}`,
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
  const kept = keptForResume(markdown, fromPage);
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
 * Demo continuation (deterministic): the sample's text after the kept part, grounded with the
 * continuation registry, rewritten with steerDemoRemainder when there is an instruction.
 * When the kept text (Cite tags removed) is a prefix of the sample, the continuation starts
 * exactly at that paragraph boundary, mid-page included; otherwise it continues after the kept
 * text's last block if the sample contains it, else from the page after the last kept heading.
 * A complete lesson (nothing left) redoes its last page.
 */
export function demoContinuation(sample, keptMarkdown, instruction, { ground } = {}) {
  const md = String(sample ?? '');
  const kept = String(keptMarkdown ?? '');
  const raw = stripGroundingTags(kept);
  const heads = pageOffsets(md);
  let rest;
  if (md.startsWith(raw)) rest = md.slice(raw.length);
  else {
    const lastBlock = splitBlocks(raw).pop();
    const at = lastBlock && !/^#{1,2} /.test(lastBlock) ? md.indexOf(lastBlock) : -1;
    if (at >= 0) rest = md.slice(at + lastBlock.length).replace(/^[ \t]*\n(?:[ \t]*\n)*/, '');
    else {
      const pages = pageCount(kept);
      rest = pages < heads.length ? md.slice(heads[pages]) : '';
    }
  }
  if (!rest.trim() && heads.length) rest = md.slice(heads[heads.length - 1]); // every page kept: redo the last one
  if (ground) rest = ground(rest);
  return instruction ? steerDemoRemainder(rest, instruction) : rest;
}
