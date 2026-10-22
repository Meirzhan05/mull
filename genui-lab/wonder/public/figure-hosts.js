// Where <Figure/> images may come from. Shared by the server (server/figures.js keeps only
// Commons results served from these hosts) and the lesson renderer (dil-surface.js loads a
// remote image only when the server resolved that exact URL for a Figure).

export const FIGURE_IMAGE_HOSTS = Object.freeze(['upload.wikimedia.org', 'thumb.wikimedia.org']);

/** An absolute https URL on a Wikimedia image host. */
export function isFigureImageUrl(src) {
  try { const u = new URL(src); return u.protocol === 'https:' && FIGURE_IMAGE_HOSTS.includes(u.hostname); } catch { return false; }
}

/** The image URLs of every found Figure in an appData's componentResults. */
export function figureImageSrcs(appData) {
  const out = new Set();
  for (const r of Object.values(appData?.opGenui?.componentResults || {})) {
    const s = r?.status === 'resolved' ? r.state : null;
    if (s?.found === true && typeof s.src === 'string' && isFigureImageUrl(s.src)) out.add(s.src);
  }
  return out;
}
