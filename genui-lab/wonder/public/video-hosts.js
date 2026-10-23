// Which <Video/> clips may play. Shared by the server (server/videos.js resolves a YouTube id)
// and the lesson renderer (dil-surface.js lets the host embed a player only for an id the
// server resolved for a Video). The host builds the embed URL itself, always on
// youtube-nocookie.com (chatgpt-dil/src/host.js), so an id is all that crosses over.

/** A YouTube video id: 11 characters of [A-Za-z0-9_-]. */
export const isVideoId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);

/** The video ids of every found Video in an appData's componentResults. */
export function videoIdsOf(appData) {
  const out = new Set();
  for (const r of Object.values(appData?.opGenui?.componentResults || {})) {
    const s = r?.status === 'resolved' ? r.state : null;
    if (s?.found === true && isVideoId(s.videoId)) out.add(s.videoId);
  }
  return out;
}
