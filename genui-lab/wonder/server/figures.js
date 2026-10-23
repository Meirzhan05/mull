// <Figure/>: a real, freely licensed image from Wikimedia Commons. Claude never writes an image
// URL (a model's URLs are often invented). It writes a search phrase, optionally an exact Commons
// file title, and the server resolves it to an image, its size, license and author. The result is
// delivered like a Cite: a server-resolved componentResults entry keyed by the Figure's
// __resolutionId, so it rides in every dil revision and is saved with the lesson.
//
//   <Figure query="cumulus clouds blue sky" file="File:….jpg" caption="…" alt="…"
//     question="What do you notice…?" answer="…"/>
//
//   compile result ──figures.componentResults(r)──▶ {rid: {status:'pending'}}  (lookup starts)
//   lookup settles ──onUpdate──▶ writer.refresh()  ──▶ {rid: {status:'resolved', state:{found, src, …}}}
//   before complete: figures.settle(ms) then figures.finalize()  (anything still pending -> not found)
//
// Vision check (optional, `verify`): Claude wrote the caption without seeing the image, so after a
// lookup succeeds a small structured call shows Claude the thumbnail (an image block by URL) with
// the caption, alt, question and answer. An image that does not fit is treated as not found. The
// verdict is cached with the lookup; a failed or timed-out check keeps the image for that stream
// only (not cached), so the next stream checks again.

import { FIGURE_IMAGE_HOSTS, isFigureImageUrl } from '../public/figure-hosts.js';
import { constRef } from './dil-constants.js';
import { buildStructuredParams, createStructured } from './claude.js';

export { FIGURE_IMAGE_HOSTS };
export const FIGURE_LIMITS = Object.freeze({ query: 100, file: 200, caption: 300, alt: 200, question: 200, answer: 400 });
export const FIGURE_SETTLE_MS = 6000;
export const FIGURE_MISS_TTL_MS = 10 * 60 * 1000; // a "nothing found" is retried after this
export const FIGURE_CHECK_TIMEOUT_MS = 15_000; // one vision check; a slower one keeps the image unchecked
export const FIGURE_CHECK_TRIES = 3; // images checked per figure: a rejected one makes way for the next-best result

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'WonderLessons/1.0 (educational app; Wikimedia Commons image lookup)';
const MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);
const FILE_RE = /^(?:File|Image):[^\n<>[\]{}|#]{1,190}\.(?:jpe?g|png|gif|webp|svg|tiff?)$/i;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const fail = (error) => ({ ok: false, error });

/** Normalize + validate Figure props. Returns {ok, props} | {ok:false, error}. */
export function validateFigure(p) {
  const query = str(p.query ?? p.search ?? p.subject, FIGURE_LIMITS.query);
  // `title` is not an alias: other catalog components use it for a heading, and so may Claude here
  let file = str(p.file ?? p.commons, FIGURE_LIMITS.file).replace(/^image:/i, 'File:');
  if (file && !/^file:/i.test(file)) file = `File:${file}`;
  if (file && !FILE_RE.test(file)) return fail('Figure file must be a Wikimedia Commons file title like "File:Name.jpg"');
  if (!query && !file) return fail('Figure needs query (a search phrase for Wikimedia Commons)');
  if (query && query.length < 3) return fail('Figure query is too short');
  if (/https?:|www\./i.test(query)) return fail('Figure query is a search phrase, not a URL');
  const props = {};
  if (query) props.query = query;
  if (file) props.file = file.replace(/^file:/i, 'File:');
  const caption = str(p.caption, FIGURE_LIMITS.caption);
  if (caption) props.caption = caption;
  const alt = str(p.alt ?? p.description, FIGURE_LIMITS.alt);
  props.alt = alt || caption.slice(0, FIGURE_LIMITS.alt) || query;
  const question = str(p.question ?? p.prompt, FIGURE_LIMITS.question);
  const answer = str(p.answer, FIGURE_LIMITS.answer);
  if (!!question !== !!answer) return fail('Figure question and answer go together');
  if (question) Object.assign(props, { question, answer });
  return { ok: true, props };
}

/** Fallback markdown: the caption (the image itself cannot be shown without the server). */
export function figureFallback(p) {
  const o = isObj(p) ? p : {};
  const caption = str(o.caption, FIGURE_LIMITS.caption).replace(/</g, '‹');
  return caption ? `*${caption}*` : '';
}

// ---------------------------------------------------------------- Wikimedia Commons lookup

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
// an out-of-range numeric entity stays as written (String.fromCodePoint would throw)
const codePoint = (n, raw) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);
/** Commons extmetadata values are HTML snippets: keep the text. */
export function plainText(html, n = 80) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)), m) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

// Commons thumbnail URLs carry utm_* analytics parameters; the image does not need them.
const withoutTracking = (u) => {
  try { const x = new URL(u); for (const k of [...x.searchParams.keys()]) if (k.startsWith('utm_')) x.searchParams.delete(k); return x.href; } catch { return ''; }
};

/** One Commons page (formatversion=2) -> figure state, or null when it is unusable. */
export function figureFromPage(page) {
  const info = page?.imageinfo?.[0];
  if (!info || !MIMES.has(info.mime)) return null;
  const meta = info.extmetadata || {};
  if (meta.NonFree?.value && String(meta.NonFree.value).toLowerCase() === 'true') return null;
  const license = plainText(meta.LicenseShortName?.value, 40);
  if (!license) return null;
  const src = withoutTracking(info.thumburl || info.url);
  if (!isFigureImageUrl(src)) return null;
  const width = Number(info.thumbwidth || info.width);
  const height = Number(info.thumbheight || info.height);
  if (!(width > 0 && height > 0)) return null;
  if (info.mime !== 'image/svg+xml' && Number(info.width) < 320) return null;
  if (width / height > 4 || height / width > 3) return null;
  const title = String(page.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/_/g, ' ');
  const author = plainText(meta.Artist?.value, 80) || plainText(meta.Credit?.value, 80) || 'Unknown author';
  const state = { found: true, src, width, height, title: title.slice(0, 120), license, author };
  if (typeof info.descriptionurl === 'string' && /^https:\/\/commons\.wikimedia\.org\//.test(info.descriptionurl)) state.pageUrl = info.descriptionurl;
  const licenseUrl = plainText(meta.LicenseUrl?.value, 200);
  if (/^https?:\/\//.test(licenseUrl)) state.licenseUrl = licenseUrl.replace(/^http:/, 'https:');
  return state;
}

// Language-specific copies of a diagram ("…-ru.svg", "…-zh-hans.svg") carry labels in that
// language. Only real language codes count, so "World-map.svg" or "Cell-art.svg" are not demoted.
const LANG_CODES = 'ar|ast|az|be|bg|bn|ca|cs|cy|da|de|el|eo|es|et|eu|fa|fi|fr|ga|gl|he|hi|hr|hu|hy|id|is|it|ja|ka|kk|ko|la|lt|lv|mk|ml|ms|nb|nl|nn|no|pl|pt|ro|ru|sk|sl|sq|sr|sv|ta|th|tr|uk|ur|uz|vi|zh';
const LOCALIZED_RE = new RegExp(`-(?:${LANG_CODES})(?:-[a-z]{2,4})?\\.svg$`, 'i');
export const localized = (title) => LOCALIZED_RE.test(String(title));

/** Pick the best usable result: search rank order, English/neutral labels first. `exclude`: image srcs to skip. */
export function pickFigure(pages, exclude) {
  const ranked = (Array.isArray(pages) ? pages : []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const usable = ranked.map((p) => ({ p, s: figureFromPage(p) })).filter((x) => x.s && !exclude?.has(x.s.src));
  return (usable.find((x) => !localized(x.p.title)) || usable[0])?.s || null;
}

/** Look up a file title or a search phrase on Wikimedia Commons. Resolves to a state or null. */
export function createCommonsLookup({ fetch = globalThis.fetch, timeoutMs = 5000 } = {}) {
  async function call(params, signal) {
    const u = new URL(COMMONS_API);
    const all = {
      action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '960',
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit|NonFree', origin: '*', ...params,
    };
    for (const [k, v] of Object.entries(all)) u.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(u, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT }, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
    const json = await res.json();
    return json?.query?.pages || [];
  }
  // `exclude` (a Set of image srcs) asks for the next-best image after the vision check rejected one
  return async function lookup({ file, query }, { signal, exclude } = {}) {
    if (file) {
      const hit = pickFigure(await call({ titles: file }, signal), exclude);
      if (hit || !query) return hit;
    }
    return pickFigure(await call({ generator: 'search', gsrsearch: `${query} filetype:bitmap|drawing`, gsrnamespace: '6', gsrlimit: '8' }, signal), exclude);
  };
}

// ---------------------------------------------------------------- vision check (Claude)

// Haiku is plenty for "does this picture show what the caption says" and answers in ~1-2 s (see
// README, "Diagrams and real images"); WONDER_FIGURE_CHECK_MODEL or figureCheckModel overrides it.
export const FIGURE_CHECK_MODEL = 'claude-haiku-5-5';

export const FIGURE_CHECK_SYSTEM_PROMPT = `
You check images for Wonder, an app whose lessons are written by an AI model. The lesson's author asked for a picture with a short search phrase and wrote the caption, alt text and an optional question and answer without ever seeing the image. An image search then picked the image you are shown. Decide whether it fits the text the learner will read next to it.

fits = true when the image shows the subject the text describes and the details the caption, alt text, question or answer point at are visible in it (or plainly would be). Differences of style are fine: a drawing or diagram instead of a photo, another angle, color, season or specimen of the same thing, labels in another language when the question does not depend on reading them.

fits = false when the image shows a different subject (another organ, object, process, place or event; a logo, map, chart, book cover or portrait that the text does not describe), when the caption, question or answer refers to something the image does not show (a labeled part, an arrow, a color, a stage, a number), or when the image contradicts the text.

depicts: one short sentence on what the image actually shows. problem: when fits is false, one sentence on what does not match; otherwise an empty string.
`.trim();

export const FIGURE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['depicts', 'fits', 'problem'],
  properties: { depicts: { type: 'string' }, fits: { type: 'boolean' }, problem: { type: 'string' } },
};

/** The check request: the thumbnail as an image block (by URL, or `image` when given), then the figure's text. */
export function figureCheckParams(state, ref, { model = FIGURE_CHECK_MODEL, image } = {}) {
  const line = (label, v, n) => (v ? `${label}: ${str(v, n)}` : null);
  const text = [
    line('Search phrase', ref.query, FIGURE_LIMITS.query),
    line('Commons file', state.title || ref.file, 200),
    line('Caption', ref.caption, FIGURE_LIMITS.caption),
    line('Alt text', ref.alt, FIGURE_LIMITS.alt),
    line('Question', ref.question, FIGURE_LIMITS.question),
    line('Answer', ref.answer, FIGURE_LIMITS.answer),
  ].filter(Boolean).join('\n');
  return buildStructuredParams({
    model,
    system: FIGURE_CHECK_SYSTEM_PROMPT,
    schema: FIGURE_CHECK_SCHEMA,
    user: [{ type: 'image', source: image || { type: 'url', url: state.src } }, { type: 'text', text }],
    effort: 'low',
    maxTokens: 4000,
  });
}

// The API fetches the URL itself, and Wikimedia sometimes refuses its fetcher (HTTP 400 "Unable to
// download the file"). Then the server downloads the same thumbnail (allow-listed hosts only, our
// User-Agent, at most 4 MB) and sends it inline once.
const CHECK_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CHECK_MAX_BYTES = 4 * 1024 * 1024;
const isDownloadError = (err) => err?.status === 400 && /download|fetch|retriev/i.test(String(err?.error?.error?.message || err?.message));
async function inlineImage(src, fetchImpl, signal) {
  if (!isFigureImageUrl(src)) throw new Error('not a figure image URL');
  const res = await fetchImpl(src, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT }, signal });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!CHECK_MIMES.has(mime)) throw new Error(`image type ${mime || 'unknown'}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > CHECK_MAX_BYTES) throw new Error('image too large to check');
  return { type: 'base64', media_type: mime, data: bytes.toString('base64') };
}

/**
 * A `verify` function for createFigureResolver: (state, ref, {signal}) -> {fits, depicts, problem}.
 * Throws on API errors, refusals and timeouts; the resolver then keeps the image unchecked.
 * `client` is the Anthropic client or a function returning it (the core's client can change).
 */
export function createFigureCheck({ client, model = FIGURE_CHECK_MODEL, timeoutMs = FIGURE_CHECK_TIMEOUT_MS, fetch = globalThis.fetch } = {}) {
  return async function verify(state, ref, { signal } = {}) {
    const c = typeof client === 'function' ? client() : client;
    if (!c) throw new Error('no Claude client');
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const ask = (image) => createStructured(c, figureCheckParams(state, ref, { model, image }), { signal: sig, maxRetries: 1 });
    let raw;
    try {
      raw = await ask();
    } catch (err) {
      if (!isDownloadError(err)) throw err;
      raw = await ask(await inlineImage(state.src, fetch, sig));
    }
    if (typeof raw?.fits !== 'boolean') throw new Error('figure check returned no verdict');
    return { fits: raw.fits, depicts: str(raw.depicts, 300), problem: str(raw.problem, 300) };
  };
}

// ---------------------------------------------------------------- per-stream resolver

const FIGURE_RE = /__dil\.jsx\(Figure,\{([^{}]*)\}/g;
const constOf = (result, body, key) => {
  const i = constRef(body, key);
  return i == null ? undefined : result.constants?.[i];
};
const TEXT_KEYS = ['caption', 'alt', 'question', 'answer'];
/** Every Figure in a compiled program (or a dil payload): [{rid, file, query, caption, alt, question, answer}]. */
export function figureRefs(result) {
  const out = [];
  if (typeof result?.code !== 'string' || !result.code.includes('Figure,')) return out;
  for (const m of result.code.matchAll(FIGURE_RE)) {
    const rid = constOf(result, m[1], '__resolutionId');
    const ref = { rid, file: constOf(result, m[1], 'file'), query: constOf(result, m[1], 'query') };
    if (typeof rid !== 'string' || (typeof ref.file !== 'string' && typeof ref.query !== 'string')) continue;
    for (const k of TEXT_KEYS) { const v = constOf(result, m[1], k); if (typeof v === 'string') ref[k] = v; }
    out.push(ref);
  }
  return out;
}
// With a vision check the verdict depends on the figure's text too, so it is part of the key.
const keyOf = ({ file, query, ...text }, withText) => `${file || ''}\u0000${(query || '').toLowerCase()}${withText ? TEXT_KEYS.map((k) => `\u0000${text[k] || ''}`).join('') : ''}`;

const CACHE_MAX = 300;
const remember = (cache, k, state, now) => { cache.delete(k); cache.set(k, { state, at: now }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };
/** A cache entry ({state}) that is still good: found images stay, a miss (or a rejected image) expires after missTtlMs. */
const cached = (cache, k, now, missTtlMs) => {
  const e = cache.get(k);
  if (!e) return undefined;
  if (!e.state?.found && now - e.at > missTtlMs) { cache.delete(k); return undefined; }
  return e;
};

/**
 * One stream's figures. `lookup` is createCommonsLookup()'s function, or null to resolve every
 * figure as not found (no network: tests, WONDER_FIGURES=off). `cache` (key -> {state, at}) is
 * shared by the server's streams, so a steer or a later revision does not look a figure up again.
 * A failed or aborted lookup is not cached (the next stream retries it), and a "nothing found"
 * expires after missTtlMs. `signal` (the stream's) cancels lookups when the learner leaves.
 * `verify` (createFigureCheck()'s function, optional) runs after a lookup finds an image, inside
 * the same pending lookup, so settle() bounds it too. An image that does not fit makes way for
 * the next-best result (lookup with `exclude`), up to `tries` images; a kept one is
 * {…, checked:true, choice} (choice > 1: not the first result). When none fits the figure is
 * cached as {found:false, rejected, tried}. A check that fails keeps that image for this stream only.
 */
export function createFigureResolver({ lookup, verify = null, tries = FIGURE_CHECK_TRIES, logger = console, cache = new Map(), signal, missTtlMs = FIGURE_MISS_TTL_MS, now = () => Date.now() } = {}) {
  const inflight = new Map(); // key -> Promise
  const failed = new Set(); // keys whose lookup threw in this stream
  const unchecked = new Map(); // key -> {state}: found, but the check failed (this stream only)
  const listeners = new Set();
  let final = false;
  const label = (ref) => ref.file || ref.query;

  async function check(k, first, ref) {
    const seen = new Set();
    let rejected = null;
    for (let state = first, choice = 1; state && !seen.has(state.src); choice++) {
      seen.add(state.src);
      let verdict;
      try {
        verdict = await verify(state, ref, { signal });
      } catch (err) {
        if (!signal?.aborted) logger.warn?.(`[wonder] figure check failed (${label(ref)}): ${err?.message || err}`);
        unchecked.set(k, { state });
        return;
      }
      if (verdict.fits) return remember(cache, k, { ...state, checked: true, ...(choice > 1 ? { choice } : {}) }, now());
      logger.info?.(`[wonder] figure rejected (${label(ref)}, image ${choice}): ${verdict.problem || verdict.depicts}`);
      rejected = { title: state.title, depicts: verdict.depicts, problem: verdict.problem };
      if (choice >= tries || signal?.aborted) break;
      state = await lookup({ file: ref.file, query: ref.query }, { signal, exclude: seen }).catch(() => null);
    }
    remember(cache, k, { found: false, rejected, tried: seen.size }, now());
  }

  function start(ref) {
    const k = keyOf(ref, !!verify);
    if (cached(cache, k, now(), missTtlMs) || inflight.has(k) || failed.has(k) || unchecked.has(k)) return;
    if (!lookup || signal?.aborted) { failed.add(k); return; }
    const p = Promise.resolve()
      .then(() => lookup({ file: ref.file, query: ref.query }, { signal }))
      .then((state) => (state && verify ? check(k, state, ref) : remember(cache, k, state || null, now())), (err) => {
        if (!signal?.aborted) logger.warn?.(`[wonder] figure lookup failed (${label(ref)}): ${err?.message || err}`);
        failed.add(k);
      })
      .then(() => {
        inflight.delete(k);
        if (!final) for (const fn of listeners) fn();
      });
    inflight.set(k, p);
  }

  return {
    /** componentResults for every Figure in a compiled program; starts lookups it has not seen. */
    componentResults(result) {
      const out = {};
      for (const ref of figureRefs(result)) {
        const k = keyOf(ref, !!verify);
        start(ref);
        const hit = cached(cache, k, now(), missTtlMs) || unchecked.get(k);
        if (hit) out[ref.rid] = { status: 'resolved', state: hit.state || { found: false } };
        else out[ref.rid] = final || failed.has(k) ? { status: 'resolved', state: { found: false } } : { status: 'pending' };
      }
      return out;
    },
    /** Wait (at most `ms`) for the lookups (and their checks) in flight. */
    async settle(ms = FIGURE_SETTLE_MS) {
      if (!inflight.size) return;
      let timer;
      await Promise.race([Promise.allSettled([...inflight.values()]), new Promise((r) => { timer = setTimeout(r, ms); })]);
      clearTimeout(timer);
    },
    /** From now on an unresolved figure reports "not found" instead of "pending". */
    finalize() { final = true; listeners.clear(); },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get pending() { return inflight.size; },
  };
}

/** Merge the figures' componentResults into another appData factory's output. */
export function withFigures(appDataFor, figures) {
  return (result) => {
    const base = appDataFor ? appDataFor(result) : null;
    const op = base?.opGenui || {};
    return { ...(base || {}), opGenui: { modelDataBindings: {}, ...op, componentResults: { ...(op.componentResults || {}), ...figures.componentResults(result) } } };
  };
}
