// <Video/>: a short real video clip from YouTube, played in a youtube-nocookie.com embed next to
// the explanation, with optional "pause and answer" questions. Claude never writes a video id or
// URL (a model's ids are often invented). It writes a search phrase and what the clip should
// show; the server searches the YouTube Data API, picks a video and the segment to play, and
// delivers it like a Figure: a server-resolved componentResults entry keyed by the Video's
// __resolutionId (server/media-resolver.js).
//
//   <Video query="rayleigh scattering explained" shows="why blue light scatters more than red"
//     caption="…" questions={[{"when":"before",…},{"prompt":"…","options":[…],"correct_values":["b"]}]}/>
//
// The segment comes from the video's own chapters (the "0:00 Intro / 1:42 …" lines in its
// description): the chapter whose title best matches `shows` plays. Without a matching chapter a
// short video plays whole and a longer one from the start, capped. Captions are not used: the
// Data API only lets a video's owner download them.

import { normalizeQuestion } from './catalog-schema.js'; // (a cycle: catalog-schema registers validateVideo; both are hoisted functions)
import { createLookupResolver, MISS_TTL_MS } from './media-resolver.js';
import { plainText } from './figures.js';
import { isVideoId } from '../public/video-hosts.js';

export const VIDEO_LIMITS = Object.freeze({ query: 100, shows: 200, caption: 300, questions: 3, after: 2 });
export const VIDEO_SETTLE_MS = 6000;
export const VIDEO_MISS_TTL_MS = MISS_TTL_MS;
export const CLIP = Object.freeze({ min: 20, short: 240, cap: 180, maxVideo: 20 * 60, minVideo: 30 }); // seconds

const API = 'https://www.googleapis.com/youtube/v3';

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const fail = (error) => ({ ok: false, error });
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const WHEN = { before: 'before', predict: 'before', start: 'before', first: 'before', after: 'after', end: 'after', pause: 'after' };

/** Normalize + validate Video props. Returns {ok, props} | {ok:false, error}. */
export function validateVideo(p) {
  for (const k of ['videoId', 'id', 'url', 'src', 'href', 'youtube']) {
    if (p[k] != null && p[k] !== '') return fail('Video takes a search phrase (query), never a video id or URL');
  }
  const query = str(p.query ?? p.search ?? p.topic, VIDEO_LIMITS.query);
  if (!query) return fail('Video needs query (a search phrase for YouTube)');
  if (query.length < 3) return fail('Video query is too short');
  if (/https?:|www\.|youtu\.?be/i.test(query)) return fail('Video query is a search phrase, not a URL');
  const props = { query };
  const shows = str(p.shows ?? p.show ?? p.focus ?? p.about, VIDEO_LIMITS.shows);
  if (shows) props.shows = shows;
  const caption = str(p.caption, VIDEO_LIMITS.caption);
  if (caption) props.caption = caption;
  const raw = Array.isArray(p.questions) ? p.questions : isObj(p.question) ? [p.question] : [];
  if (raw.length > VIDEO_LIMITS.questions) return fail(`Video takes at most ${VIDEO_LIMITS.questions} questions`);
  const questions = [];
  for (const [i, q] of raw.entries()) {
    const r = normalizeQuestion(q, i);
    if (!r.ok) return fail(`Video ${r.error[0].toLowerCase()}${r.error.slice(1)}`);
    if (r.props.question_type === 'multi_select') return fail(`Video question ${i + 1} must be single choice or true/false`);
    const when = WHEN[str(q.when ?? q.at ?? q.timing, 20).toLowerCase()] || 'after';
    const { hint: _h, ...rest } = r.props;
    if (questions.some((x) => x.id === rest.id)) rest.id = `q${i + 1}`;
    questions.push({ ...rest, when });
  }
  if (questions.filter((q) => q.when === 'before').length > 1) return fail('Video takes at most one "before" (predict) question');
  if (questions.filter((q) => q.when === 'after').length > VIDEO_LIMITS.after) return fail(`Video takes at most ${VIDEO_LIMITS.after} "after" questions`);
  if (questions.length) props.questions = questions;
  return { ok: true, props };
}

/** Fallback markdown: the caption (the clip itself cannot be shown without the server). */
export function videoFallback(p) {
  const caption = str(isObj(p) ? p.caption : '', VIDEO_LIMITS.caption).replace(/</g, '‹');
  return caption ? `*${caption}*` : '';
}

// ---------------------------------------------------------------- picking a video and a segment

/** ISO 8601 duration ("PT4M13S", "PT1H2M", "P0D") -> seconds, or NaN. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso || ''));
  if (!m || iso === 'P' || iso === 'PT') return NaN;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Math.floor(Number(m[4] || 0));
}

const tsSeconds = (ts) => ts.split(':').reduce((n, x) => n * 60 + Number(x), 0);
const TS = '((?:\\d{1,2}:)?\\d{1,2}:\\d{2})';
const LEAD_RE = new RegExp(`^[\\s\\-–—•▶►*]*\\(?${TS}\\)?\\s*[\\-–—:|.)\\]]*\\s*(.+)$`);
const TRAIL_RE = new RegExp(`^[\\s\\-–—•▶►*]*(.+?)\\s*[\\-–—:|(\\[]*\\s*${TS}\\)?\\]?\\s*$`);

/**
 * Chapters from a video description, by YouTube's own rules: timestamped lines in order, the
 * first at 0:00, at least three, each at least 10 s long. Returns [{start, end, title}] or [].
 */
export function parseChapters(description, duration) {
  const out = []; // the run of ascending timestamped lines that starts at 0:00
  for (const line of String(description || '').split(/\r?\n/).slice(0, 400)) {
    let m = LEAD_RE.exec(line);
    let ts;
    let title;
    if (m) { ts = m[1]; title = m[2]; } else if ((m = TRAIL_RE.exec(line))) { ts = m[2]; title = m[1]; } else { if (out.length && line.trim()) break; continue; }
    title = title.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!title || new RegExp(`^${TS}$`).test(title)) continue;
    const start = tsSeconds(ts);
    if (!out.length) { if (start === 0) out.push({ start, title }); continue; }
    if (start <= out.at(-1).start) break;
    out.push({ start, title });
  }
  if (out.length < 3) return [];
  for (let i = 1; i < out.length; i++) if (out[i].start - out[i - 1].start < 10) return [];
  const total = Number.isFinite(duration) ? duration : out.at(-1).start + 60;
  if (out.at(-1).start >= total) return [];
  return out.map((c, i) => ({ ...c, end: i + 1 < out.length ? out[i + 1].start : total }));
}

const STOP = new Set('a an and are as at be by can do does for from has have how in into is it its of on or that the their them then there these this to was what when where which who why will with you your about more than explained explanation video lesson'.split(' '));
const stem = (w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
export const words = (s) => [...new Set(String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
const overlap = (a, b) => { const B = new Set(b); return a.filter((w) => B.has(w)).length; };
const FILLER_RE = /^(intro(?:duction)?|outro|sponsor|ad|credits|end ?screen|subscribe|summary|recap|conclusion|thanks?)\b/i;

/** The segment to play: a matching chapter, else the whole short video, else its start (capped). */
export function pickSegment({ duration, chapters, query, shows }) {
  const want = words(shows || query);
  let best = null;
  for (const c of chapters || []) {
    if (FILLER_RE.test(c.title) || c.end - c.start < CLIP.min) continue;
    const score = overlap(want, words(c.title));
    if (score > 0 && (!best || score > best.score)) best = { ...c, score };
  }
  if (best) return { start: best.start, end: Math.min(best.end, best.start + CLIP.short), chapter: best.title };
  if (duration <= CLIP.short) return { start: 0, end: duration };
  return { start: 0, end: CLIP.cap };
}

/** One videos.list item -> {state, score}, or null when it cannot be used. `rank` is its search position. */
export function videoCandidate(item, rank, { query, shows } = {}) {
  const id = item?.id;
  const sn = item?.snippet || {};
  const cd = item?.contentDetails || {};
  const st = item?.status || {};
  if (!isVideoId(id) || st.embeddable !== true || st.privacyStatus !== 'public') return null;
  if (st.uploadStatus && st.uploadStatus !== 'processed') return null;
  if (sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none') return null;
  if (cd.contentRating?.ytRating === 'ytAgeRestricted' || cd.regionRestriction) return null;
  const duration = parseDuration(cd.duration);
  if (!(duration >= CLIP.minVideo && duration <= CLIP.maxVideo)) return null;
  const title = plainText(sn.title, 120);
  if (!title || /#shorts?\b/i.test(`${sn.title} ${String(sn.description || '').slice(0, 300)}`)) return null;
  const chapters = parseChapters(sn.description, duration);
  const seg = pickSegment({ duration, chapters, query, shows });
  let score = 10 - rank;
  if (seg.chapter) score += 6;
  else if (duration <= CLIP.short) score += 4;
  else score -= duration > 480 ? 4 : 1; // only its first few minutes would play
  if (cd.caption === 'true') score += 1;
  const lang = String(sn.defaultAudioLanguage || sn.defaultLanguage || '');
  if (lang && !/^en\b/i.test(lang)) score -= 6;
  score += Math.min(2, overlap(words(shows || query), words(title)));
  const state = { found: true, videoId: id, start: seg.start, end: seg.end, duration, title, channel: plainText(sn.channelTitle, 80) || 'YouTube' };
  if (seg.chapter) state.chapter = seg.chapter;
  state.pageUrl = `https://www.youtube.com/watch?v=${id}${seg.start ? `&t=${seg.start}s` : ''}`;
  return { state, score };
}

/** Best usable video among videos.list items given in search-rank order, or null. */
export function pickVideo(items, ref) {
  let best = null;
  (Array.isArray(items) ? items : []).forEach((it, rank) => {
    const c = videoCandidate(it, rank, ref);
    if (c && (!best || c.score > best.score)) best = c;
  });
  return best?.state || null;
}

/**
 * Search YouTube for a clip. Resolves to a state or null. The key travels in a header (never in
 * a URL or a log line). Search costs 100 quota units and videos.list 1, of 10,000 a day.
 */
export function createYouTubeLookup({ apiKey, fetch = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (!apiKey) return null;
  async function call(path, params, signal) {
    const u = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(u, { headers: { 'X-Goog-Api-Key': apiKey, Accept: 'application/json' }, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    if (!res.ok) {
      let reason = '';
      try { reason = String((await res.json())?.error?.errors?.[0]?.reason || '').replace(/[^\w]/g, '').slice(0, 40); } catch {}
      throw new Error(`YouTube HTTP ${res.status}${reason ? ` (${reason})` : ''}`);
    }
    return res.json();
  }
  return async function lookup({ query, shows }, { signal } = {}) {
    const found = await call('search', {
      part: 'snippet', type: 'video', q: query, maxResults: '10', safeSearch: 'strict', videoEmbeddable: 'true', videoSyndicated: 'true', relevanceLanguage: 'en',
      fields: 'items(id(videoId))',
    }, signal);
    const ids = [...new Set((found?.items || []).map((it) => it?.id?.videoId).filter(isVideoId))];
    if (!ids.length) return null;
    const details = await call('videos', {
      part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: '10',
      fields: 'items(id,snippet(title,description,channelTitle,liveBroadcastContent,defaultAudioLanguage,defaultLanguage),contentDetails(duration,caption,contentRating,regionRestriction),status(embeddable,privacyStatus,uploadStatus))',
    }, signal);
    const byId = new Map((details?.items || []).map((v) => [v.id, v]));
    return pickVideo(ids.map((id) => byId.get(id)).filter(Boolean), { query, shows });
  };
}

// ---------------------------------------------------------------- per-stream resolver

const keyOf = ({ query, shows }) => `${query.toLowerCase()}\u0000${(shows || '').toLowerCase()}`;

/** One stream's videos (server/media-resolver.js); `lookup` null -> every Video is not found. */
export function createVideoResolver({ lookup, missTtlMs = VIDEO_MISS_TTL_MS, ...opts } = {}) {
  return createLookupResolver({
    component: 'Video',
    label: 'Finding a video…',
    refOf: (get) => {
      const query = get('query');
      if (typeof query !== 'string') return null;
      const shows = get('shows');
      return { query, ...(typeof shows === 'string' ? { shows } : {}) };
    },
    keyOf,
    lookup,
    missTtlMs,
    ...opts,
  });
}
