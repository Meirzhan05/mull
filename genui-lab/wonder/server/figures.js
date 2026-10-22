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

import { FIGURE_IMAGE_HOSTS, isFigureImageUrl } from '../public/figure-hosts.js';
import { constRef } from './dil-constants.js';

export { FIGURE_IMAGE_HOSTS };
export const FIGURE_LIMITS = Object.freeze({ query: 100, file: 200, caption: 300, alt: 200, question: 200, answer: 400 });
export const FIGURE_SETTLE_MS = 6000;
export const FIGURE_MISS_TTL_MS = 10 * 60 * 1000; // a "nothing found" is retried after this

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

/** Pick the best usable result: search rank order, English/neutral labels first. */
export function pickFigure(pages) {
  const ranked = (Array.isArray(pages) ? pages : []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const usable = ranked.map((p) => ({ p, s: figureFromPage(p) })).filter((x) => x.s);
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
  return async function lookup({ file, query }, { signal } = {}) {
    if (file) {
      const hit = pickFigure(await call({ titles: file }, signal));
      if (hit || !query) return hit;
    }
    return pickFigure(await call({ generator: 'search', gsrsearch: `${query} filetype:bitmap|drawing`, gsrnamespace: '6', gsrlimit: '8' }, signal));
  };
}

// ---------------------------------------------------------------- per-stream resolver

const FIGURE_RE = /__dil\.jsx\(Figure,\{([^{}]*)\}/g;
const constOf = (result, body, key) => {
  const i = constRef(body, key);
  return i == null ? undefined : result.constants?.[i];
};
const keyOf = ({ file, query }) => `${file || ''}\u0000${(query || '').toLowerCase()}`;

const CACHE_MAX = 300;
const remember = (cache, k, state, now) => { cache.delete(k); cache.set(k, { state, at: now }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };
/** A cache entry ({state}) that is still good: found images stay, a miss expires after missTtlMs. */
const cached = (cache, k, now, missTtlMs) => {
  const e = cache.get(k);
  if (!e) return undefined;
  if (e.state == null && now - e.at > missTtlMs) { cache.delete(k); return undefined; }
  return e;
};

/**
 * One stream's figures. `lookup` is createCommonsLookup()'s function, or null to resolve every
 * figure as not found (no network: tests, WONDER_FIGURES=off). `cache` (key -> {state, at}) is
 * shared by the server's streams, so a steer or a later revision does not look a figure up again.
 * A failed or aborted lookup is not cached (the next stream retries it), and a "nothing found"
 * expires after missTtlMs. `signal` (the stream's) cancels lookups when the learner leaves.
 */
export function createFigureResolver({ lookup, logger = console, cache = new Map(), signal, missTtlMs = FIGURE_MISS_TTL_MS, now = () => Date.now() } = {}) {
  const inflight = new Map(); // key -> Promise
  const failed = new Set(); // keys whose lookup threw in this stream
  const listeners = new Set();
  let final = false;

  function start(ref) {
    const k = keyOf(ref);
    if (cached(cache, k, now(), missTtlMs) || inflight.has(k) || failed.has(k)) return;
    if (!lookup || signal?.aborted) { failed.add(k); return; }
    const p = Promise.resolve()
      .then(() => lookup(ref, { signal }))
      .then((state) => remember(cache, k, state || null, now()), (err) => {
        if (!signal?.aborted) logger.warn?.(`[wonder] figure lookup failed (${ref.file || ref.query}): ${err?.message || err}`);
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
      if (!result?.code || !result.code.includes('Figure,')) return out;
      FIGURE_RE.lastIndex = 0;
      let m;
      while ((m = FIGURE_RE.exec(result.code))) {
        const rid = constOf(result, m[1], '__resolutionId');
        const ref = { file: constOf(result, m[1], 'file'), query: constOf(result, m[1], 'query') };
        if (typeof rid !== 'string' || (typeof ref.file !== 'string' && typeof ref.query !== 'string')) continue;
        const k = keyOf(ref);
        start(ref);
        const hit = cached(cache, k, now(), missTtlMs);
        if (hit) out[rid] = { status: 'resolved', state: hit.state || { found: false } };
        else out[rid] = final || failed.has(k) ? { status: 'resolved', state: { found: false } } : { status: 'pending' };
      }
      return out;
    },
    /** Wait (at most `ms`) for the lookups in flight. */
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
