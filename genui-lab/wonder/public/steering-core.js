// Phase 4: mid-turn steering, shared by the server and the browser (no DOM, no Node APIs).
//
// ChatGPT steers a running turn with /backend-api/f/steer_turn and reports the outcome as
// `steering-status: accepted|rejected` and `steering-message` control records on the same
// stream (chatgpt-findings §1.5). Wonder does the same for lessons: the server keeps every
// complete "## " page, replaces the message tail (a `replace` content record with a higher
// revision), and continues with the learner's instruction applied.

export const STEER_CHIPS = Object.freeze([
  { label: 'Simpler', instruction: 'Make it simpler: plainer words, shorter sentences, one idea at a time.' },
  { label: 'More examples', instruction: 'Add more concrete, everyday examples.' },
  { label: 'Go deeper', instruction: 'Go deeper: more precise detail and the "why" behind each idea.' },
  { label: 'Shorter', instruction: 'Make the rest shorter: keep only the essentials.' },
]);

export const MAX_STEER_CHARS = 300;

/**
 * Keep everything before the "## " page that is still being written. With no page heading
 * yet, keep only a finished "# Title" line. Never cuts inside a code fence.
 */
export function trimToLastPage(markdown) {
  const md = String(markdown ?? '');
  const heads = [];
  let inFence = false;
  let pos = 0;
  for (const line of md.split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^## /.test(line)) heads.push(pos);
    pos += line.length + 1;
  }
  if (heads.length) return md.slice(0, heads[heads.length - 1]);
  const m = /^# [^\n]+\n/.exec(md);
  return m ? m[0] : '';
}

export const pageCount = (markdown) => (('\n' + String(markdown ?? '')).match(/\n## /g) || []).length;

/** Client reducer for steering controls: {status:'idle'|'pending'|'accepted'|'rejected', instruction, count}. */
export function steerReducer(state, event) {
  const s = state || { status: 'idle', instruction: '', count: 0 };
  switch (event?.type) {
    case 'request': return { ...s, status: 'pending', instruction: String(event.instruction || '') };
    case 'control':
      if (event.detail?.kind === 'steering-status') {
        const ok = event.detail.status === 'accepted';
        return { ...s, status: ok ? 'accepted' : 'rejected', count: s.count + (ok ? 1 : 0), reason: event.detail.reason };
      }
      return s;
    case 'rejected': return { ...s, status: 'rejected', reason: event.reason };
    case 'complete': return { ...s, status: 'idle' };
    default: return s;
  }
}

// ---------------------------------------------------------------- continueFrom (resume / revise)
//
// A lesson can be continued without its original stream: POST /api/lesson/stream with
// `continueFrom: {markdown, instruction?, fromPage?, messageId?, sources?}`. The server keeps
// the complete pages (or the pages before `fromPage`), sends them as a `replace` record and
// streams the rest. The helpers below are shared by the server, the client and the tests.

export const MAX_CONTINUE_MARKDOWN = 200000;
export const MAX_CONTINUE_SOURCES = 60;

/** Offsets of every "## " page heading (fence-aware). */
export function pageOffsets(markdown) {
  const md = String(markdown ?? '');
  const heads = [];
  let inFence = false;
  let pos = 0;
  for (const line of md.split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^## /.test(line)) heads.push(pos);
    pos += line.length + 1;
  }
  return heads;
}

/** Everything before page `n` (1-based): page 1 keeps only the title and hook. */
export function trimBeforePage(markdown, n) {
  const md = String(markdown ?? '');
  const heads = pageOffsets(md);
  const i = Math.max(1, Math.floor(n)) - 1;
  return i < heads.length ? md.slice(0, heads[i]) : md;
}

/** Page `n` (1-based) and everything after it ('' when the lesson has fewer pages). */
export function sliceFromPage(markdown, n) {
  const md = String(markdown ?? '');
  const heads = pageOffsets(md);
  const i = Math.max(1, Math.floor(n)) - 1;
  return i < heads.length ? md.slice(heads[i]) : '';
}

/** "## " headings in order (page titles), fence-aware. */
export function pageTitles(markdown) {
  const md = String(markdown ?? '');
  return pageOffsets(md).map((at) => md.slice(at + 3, (md.indexOf('\n', at) + 1 || md.length + 1) - 1).trim());
}

/** The kept part of a continuation: pages before `fromPage`, else the last complete page. */
export function keptForContinue(markdown, fromPage) {
  return fromPage ? trimBeforePage(markdown, fromPage) : trimToLastPage(markdown);
}

/** Every __resolutionId in a compiled program (constants-referenced or inline). */
export function resolutionIdsOf(dil) {
  const ids = new Set();
  const code = String(dil?.code ?? '');
  const re = /"__resolutionId":(?:__dilConstants\["(\d+)"\]|"([^"\\]+)")/g;
  let m;
  while ((m = re.exec(code))) {
    const id = m[1] != null ? dil?.constants?.[m[1]] : m[2];
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

const resultsOf = (appData) => (appData && typeof appData === 'object' && appData.opGenui?.componentResults) || {};

/** Only the componentResults whose resolution id is in `ids`. */
export function keepResults(componentResults, ids) {
  const out = {};
  for (const [k, v] of Object.entries(componentResults || {})) if (ids.has(k)) out[k] = v;
  return out;
}

/**
 * appData for a continued lesson: results carried over from the kept pages, overlaid with the
 * new stream's own results (new wins for the same resolution id).
 */
export function mergeContinuedAppData(carried, appData) {
  const base = appData && typeof appData === 'object' ? appData : {};
  const op = base.opGenui || {};
  return { ...base, opGenui: { modelDataBindings: {}, ...op, componentResults: { ...(carried || {}), ...resultsOf(base) } } };
}

/**
 * Client side of a continuation, given the first program of the new stream (the kept pages):
 * keep the old citation results (`dilAppData`) and widget results (`widgetAppData`) only for
 * components that survive, so old Cite pills keep working and rewritten widgets start fresh.
 */
export function carryOver({ dilAppData, widgetAppData } = {}, keptDil) {
  const ids = resolutionIdsOf(keptDil);
  const carried = keepResults(resultsOf(dilAppData), ids);
  const widget = widgetAppData && typeof widgetAppData === 'object'
    ? { ...widgetAppData, opGenui: { ...(widgetAppData.opGenui || {}), componentResults: keepResults(resultsOf(widgetAppData), ids) } }
    : widgetAppData ?? null;
  return { ids, carried, widgetAppData: widget };
}

/** Source items behind the Cite/Sources results (sent back so kept pills keep their numbers). */
export function sourcesFromAppData(appData) {
  const byRef = new Map();
  for (const r of Object.values(resultsOf(appData))) {
    for (const it of r?.state?.items || []) {
      if (it && typeof it.ref === 'string' && typeof it.url === 'string' && !byRef.has(it.ref)) {
        byRef.set(it.ref, { ref: it.ref, index: it.index, url: it.url, title: it.title, domain: it.domain, snippet: it.snippet ?? null, ...(it.page_age ? { page_age: it.page_age } : {}) });
      }
    }
  }
  return [...byRef.values()].sort((a, b) => (a.index || 0) - (b.index || 0)).slice(0, MAX_CONTINUE_SOURCES);
}

/** The refs of every server-inserted <Cite refs={[…]}/> in a lesson. */
export function citeRefsIn(markdown) {
  const refs = new Set();
  for (const m of String(markdown ?? '').matchAll(/<Cite\s+refs=\{(\[[^{}]*\])\}\s*\/>/g)) {
    try { for (const r of JSON.parse(m[1])) if (typeof r === 'string') refs.add(r); } catch {}
  }
  return refs;
}

// ---------------------------------------------------------------- persisted lesson states
//
// lesson.status: 'new' (never streamed) | 'streaming' (a page is writing it: streamOwner = that
// page's id) | 'interrupted' (stopped before the end, markdown = what was shown) | 'complete'
// | 'failed' (an error before anything was written). A 'streaming' lesson whose owner is not
// the current page was left by a reload or a closed tab, so it counts as interrupted, unless
// another tab still holds the lesson's lock (public/lesson-lock.js): then it is 'elsewhere'.

/** Failure codes that mean "the stream was cut", not "the request was bad": resumable. */
export const RESUMABLE_FAILURES = Object.freeze(['stalled', 'network']);
export const isResumableFailure = (code) => RESUMABLE_FAILURES.includes(String(code || ''));

/**
 * 'complete' | 'streaming' | 'interrupted' | 'new' | 'elsewhere' for a persisted lesson.
 * `lockedElsewhere`: another tab holds this lesson's lock (it is streaming, resuming or
 * revising it), so this page must neither mark it interrupted nor start its own stream.
 */
export function lessonPhase(lesson, { pageId, lockedElsewhere = false } = {}) {
  if (!lesson) return 'new';
  if (lockedElsewhere) return 'elsewhere';
  const hasText = !!String(lesson.markdown || '').trim();
  if (lesson.status === 'complete' && lesson.dil) return 'complete';
  if (lesson.status === 'streaming' && pageId && lesson.streamOwner === pageId) return 'streaming';
  if (hasText && (lesson.status === 'streaming' || lesson.status === 'interrupted')) return 'interrupted';
  return 'new';
}

/** The persisted status after a stream ends without completing. */
export function statusAfterStop({ markdown, failureCode, aborted } = {}) {
  const hasText = !!String(markdown || '').trim();
  if (aborted) return hasText ? 'interrupted' : 'new';
  if (hasText && (failureCode == null || isResumableFailure(failureCode))) return 'interrupted';
  return 'failed';
}
