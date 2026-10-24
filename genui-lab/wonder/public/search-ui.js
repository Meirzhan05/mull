// Search UI pieces shared by the command palette (shell.js) and the Library: a per-store
// searcher whose index is rebuilt only after the store changes, result rows with highlighted
// matches, and opening a result (a lesson opens scrolled to the match).

import { el, icon } from './ui.js';
import { createSearcher, fold } from './search-core.js';

export const TYPE_ICON = Object.freeze({ lesson: 'book', course: 'layers', card: 'cards', thread: 'chat' });
export const TYPE_HINT = Object.freeze({ lesson: 'Lesson', course: 'Course', card: 'Card', thread: 'Teacher chat' });

const searchers = new WeakMap();

function searcherFor(store) {
  let s = searchers.get(store);
  if (!s) {
    s = { searcher: createSearcher(), revision: 0 };
    store.subscribe?.(() => { s.revision++; });
    searchers.set(store, s);
  }
  return s;
}

/** Search the learner's content. The index is cached until the next store update. */
export function searchStore(store, query, opts = {}) {
  const s = searcherFor(store);
  return s.searcher.search(store.data, query, { ...opts, revision: s.revision });
}

/** The same, grouped by type with full totals (search-core searchGroups). */
export function searchStoreGroups(store, query, opts = {}) {
  const s = searcherFor(store);
  return s.searcher.groups(store.data, query, { ...opts, revision: s.revision });
}

/** [{text, hit}] parts as text with <mark> around the hits. */
export function hitText(parts, cls) {
  return el('span', { class: cls }, ...parts.map((p) => (p.hit ? el('mark', { class: 'search-hit' }, p.text) : p.text)));
}

export const hasTitleHit = (r) => r.title.some((p) => p.hit);

/** Title, optional snippet and a meta line for one result (used inside a row or option). */
export function resultBody(r) {
  const meta = [TYPE_HINT[r.type], r.sub, r.type === 'lesson' && r.page ? `page ${r.page}` : ''].filter(Boolean).join(' · ');
  return el('span', { class: 'search-result-body' },
    hitText(r.title, 'search-result-title'),
    r.snippet.length ? hitText(r.snippet, 'search-result-snippet') : null,
    el('span', { class: 'search-result-meta' }, meta));
}

/** A result as a link row (Library). */
export function resultLink(r) {
  return el('a', { class: 'search-row', href: r.href, onclick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); openResult(r); } },
    icon(TYPE_ICON[r.type]), resultBody(r));
}

let pending = null;

/** Go to a result. Lessons open scrolled to the page (and the words) that matched. */
export function openResult(r) {
  pending?.cancel();
  pending = null;
  if (location.hash !== r.href) location.hash = r.href;
  if (r.type !== 'lesson') return;
  const hit = r.snippet.find((p) => p.hit)?.text || '';
  if (!r.page && !hit) return;
  pending = revealInLesson(r.href, r.page, hit);
}

/**
 * Wait for the lesson to render (route() scrolls to the top first), then scroll to the first
 * occurrence of `words` on page `page` (1-based "## " page; 0 = before the first one), falling
 * back to the page heading. The match is highlighted briefly where the browser supports it.
 */
function revealInLesson(href, page, words) {
  let timer = 0;
  let tries = 0;
  let done = false;
  const cancel = () => { done = true; clearTimeout(timer); };
  const tick = () => {
    if (done || location.hash !== href) return;
    const mount = document.querySelector('.lesson-dil');
    const heads = mount ? [...mount.querySelectorAll(':scope > h2[data-d-component="title"]')] : [];
    const ready = mount && (page ? heads.length >= page : mount.textContent.trim());
    if (!ready) { if (++tries < 40) timer = setTimeout(tick, 100); return; }
    done = true;
    const start = page ? heads[page - 1] : mount.firstChild;
    const range = words ? findText(mount, start, heads[page] || null, words) : null;
    if (range) {
      const box = range.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + box.top - window.innerHeight * 0.3, behavior: 'smooth' });
      flash(range);
    } else heads[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  timer = setTimeout(tick, 60);
  return { cancel };
}

/** A Range over the first case/accent-insensitive occurrence of `words` between two nodes. */
function findText(root, from, until, words) {
  const want = fold(words);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let started = !from;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!started) { if (from.contains(n) || from.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) started = true; else continue; }
    if (until && (until.contains(n) || until.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    const i = fold(n.data).indexOf(want);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, i + want.length);
    return range;
  }
  return null;
}

function flash(range) {
  const H = globalThis.Highlight;
  if (!H || !globalThis.CSS?.highlights) return;
  CSS.highlights.set('search-found', new H(range));
  setTimeout(() => CSS.highlights.delete('search-found'), 2600);
}

export const resultCount = (n) => `${n} result${n === 1 ? '' : 's'}`;
