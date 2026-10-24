// Library (#/library): every course and lesson in this browser as sortable tables, with search,
// a status filter and delete. On phones each table row collapses into a two-line entry.
// Search is full text (search-core.js): it filters the tables to lessons and courses that
// mention the query, best match first, and lists matching cards and Teacher chats below.

import { el, icon, toast, relTime } from './ui.js';
import { courseProgress, readingMinutes } from './progress-core.js';
import { pageCount } from './steering-core.js';
import { searchStoreGroups, hitText, resultLink, openResult, resultCount } from './search-ui.js';

const MORE_LIMIT = 20; // cards / chats listed under the tables
const FILTERS = [['all', 'All'], ['progress', 'In progress'], ['finished', 'Finished'], ['courses', 'Courses']];
const SORTS = { recent: 'Last opened', title: 'Title', length: 'Length' };

const lessonState = (l) => (l.finished ? ['done', 'Finished'] : l.status === 'complete' ? ['ready', l.readPage > 1 ? `Page ${l.readPage}` : 'In progress'] : l.status === 'failed' ? ['warn', 'Failed'] : ['', l.status === 'new' ? 'Not started' : 'Unfinished']);

/** @param {{app: HTMLElement, store: object, actions: object}} ctx */
export function renderLibrary(ctx) {
  const { app, store, actions } = ctx;
  let filter = 'all';
  let sort = 'recent';
  let query = '';
  let sorted = false; // picked a sort while searching: use it instead of best match
  try { filter = sessionStorage.getItem('wonder.libFilter') || 'all'; sort = sessionStorage.getItem('wonder.libSort') || 'recent'; } catch {}
  try { query = sessionStorage.getItem('wonder.libQuery') || ''; sessionStorage.removeItem('wonder.libQuery'); } catch {} // "See all results" from the palette

  const search = el('input', { type: 'search', placeholder: 'Search lessons, cards and chats', 'aria-label': 'Search library', value: query || null });
  const live = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const seg = el('div', { class: 'seg', role: 'tablist', 'aria-label': 'Filter' }, ...FILTERS.map(([id, label]) => el('button', {
    class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': String(id === filter), dataset: { f: id },
    onclick: () => { filter = id; try { sessionStorage.setItem('wonder.libFilter', id); } catch {} for (const b of seg.children) b.setAttribute('aria-selected', String(b.dataset.f === id)); draw(); },
  }, label)));
  const body = el('div', { class: 'lib-body' });
  search.addEventListener('input', () => { query = search.value; sorted = false; draw(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; query = ''; draw(); } });
  const counts = el('p', { class: 'page-count' });

  function setSort(k) {
    sort = k;
    sorted = true;
    try { sessionStorage.setItem('wonder.libSort', k); } catch {}
    sortSel.value = k;
    draw();
  }

  function deleteLesson(l) {
    if (!confirm(`Delete “${l.title || l.topic}”? Its tutor chat goes too. Practice cards stay in your deck.`)) return;
    store.update((d) => {
      delete d.lessons[l.id];
      for (const c of d.courses) for (const s of c.sections) for (const x of s.lessons) if (x.lessonId === l.id) x.lessonId = null;
      return d;
    });
    toast('Lesson deleted');
    draw();
  }
  function deleteCourse(c) {
    if (!confirm(`Delete the course “${c.title}” and its lessons? Practice cards stay in your deck.`)) return;
    store.update((d) => {
      d.courses = d.courses.filter((x) => x.id !== c.id);
      for (const l of Object.values(d.lessons)) if (l.courseId === c.id) delete d.lessons[l.id];
      return d;
    });
    toast('Course deleted');
    draw();
  }

  const th = (label, key, cls = '') => {
    if (!key) return el('span', { class: `th ${cls}`, role: 'columnheader' }, label);
    return el('button', { class: `th th-sort ${cls} ${sort === key ? 'on' : ''}`, type: 'button', role: 'columnheader', 'aria-sort': sort === key ? (key === 'title' ? 'ascending' : 'descending') : 'none', onclick: () => setSort(key) },
      label, sort === key ? icon('chevron-down') : null);
  };

  function draw() {
    const d = store.data;
    const q = query.trim();
    // every matching lesson and course (they filter the tables), but snippets for only the cards and chats shown
    const groups = q ? [...searchStoreGroups(store, q, { perType: 1000, types: ['lesson', 'course'] }), ...searchStoreGroups(store, q, { perType: MORE_LIMIT, types: ['card', 'thread'] })] : [];
    const group = (type) => groups.find((g) => g.type === type) || { total: 0, results: [] };
    const hit = { lesson: new Map(), course: new Map() };
    for (const type of ['lesson', 'course']) group(type).results.forEach((r, i) => hit[type].set(r.id, { r, i }));
    const byRank = (type) => (a, b) => hit[type].get(a.id).i - hit[type].get(b.id).i;
    const courses = filter === 'all' || filter === 'courses' ? d.courses.filter((c) => !q || hit.course.has(c.id)) : [];
    if (q) courses.sort(byRank('course'));
    const lessons = filter === 'courses' ? [] : Object.values(d.lessons)
      .filter((l) => !q || hit.lesson.has(l.id))
      .filter((l) => (filter === 'finished' ? l.finished : filter === 'progress' ? !l.finished : true))
      .sort(q && !sorted ? byRank('lesson') : (a, b) => (sort === 'title' ? String(a.title || a.topic).localeCompare(String(b.title || b.topic))
        : sort === 'length' ? readingMinutes(b.markdown) - readingMinutes(a.markdown)
          : (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    const more = q && filter === 'all' ? ['card', 'thread'].map((type) => [type, group(type)]) : [];
    live.textContent = q ? `${resultCount(groups.reduce((n, g) => n + g.total, 0))} for “${q}”` : '';
    // a matching lesson or course row shows where it matched
    const matchLine = (type, id, fallback) => {
      const r = hit[type].get(id)?.r;
      return r?.snippet.some((p) => p.hit) ? hitText(r.snippet, 'td-sub td-snippet') : fallback;
    };
    const titleOf = (type, id, text) => {
      const r = hit[type].get(id)?.r;
      return r ? hitText(r.title, 'td-title-text') : text;
    };
    const open = (type, id) => (e) => {
      const r = hit[type].get(id)?.r;
      if (!r || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      openResult(r);
    };
    const nl = Object.keys(d.lessons).length;
    counts.textContent = `${nl} lesson${nl === 1 ? '' : 's'} · ${d.courses.length} course${d.courses.length === 1 ? '' : 's'}`;

    const courseTable = courses.length ? el('section', { class: 'panel-section' },
      el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, 'Courses', el('span', { class: 'count' }, String(courses.length)))),
      el('div', { class: 'table t-courses', role: 'table', 'aria-label': 'Courses' },
        el('div', { class: 'tr thead', role: 'row' }, th('Title'), th('Progress'), th('Level', null, 'hide-sm'), th('', null, 'th-act')),
        ...courses.map((c) => {
          const p = courseProgress(d, c);
          return el('div', { class: 'tr', role: 'row' },
            el('a', { class: 'td td-title', role: 'cell', href: `#/course/${c.id}` }, el('strong', null, titleOf('course', c.id, c.title)), matchLine('course', c.id, c.description ? el('span', { class: 'td-sub' }, c.description) : null)),
            el('span', { class: 'td td-progress', role: 'cell' },
              el('span', { class: 'ledger-bar', 'aria-hidden': 'true' }, el('i', { style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })),
              el('span', { class: 'mono' }, `${p.done}/${p.total}`)),
            el('span', { class: 'td hide-sm mono', role: 'cell' }, c.level || 'beginner'),
            el('span', { class: 'td td-act', role: 'cell' }, el('button', { class: 'icon-btn plain', type: 'button', 'aria-label': `Delete course ${c.title}`, onclick: () => deleteCourse(c) }, icon('trash'))));
        }))) : null;

    const lessonTable = lessons.length ? el('section', { class: 'panel-section' },
      el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, 'Lessons', el('span', { class: 'count' }, String(lessons.length)))),
      el('div', { class: 'table t-lessons', role: 'table', 'aria-label': 'Lessons' },
        el('div', { class: 'tr thead', role: 'row' }, th('Title', 'title'), th('Status'), th('Length', 'length', 'hide-sm'), th('Quiz', null, 'hide-sm'), th('Opened', 'recent', 'hide-sm'), th('', null, 'th-act')),
        ...lessons.map((l) => {
          const [cls, label] = lessonState(l);
          const course = l.courseId ? d.courses.find((c) => c.id === l.courseId) : null;
          const mins = readingMinutes(l.markdown);
          const pages = pageCount(l.markdown);
          return el('div', { class: 'tr', role: 'row' },
            el('a', { class: 'td td-title', role: 'cell', href: `#/lesson/${l.id}`, onclick: open('lesson', l.id) }, el('strong', null, titleOf('lesson', l.id, l.title || l.topic)), matchLine('lesson', l.id, course ? el('span', { class: 'td-sub' }, course.title) : null)),
            el('span', { class: 'td', role: 'cell' }, el('span', { class: `status ${cls}` }, el('i', { 'aria-hidden': 'true' }), label)),
            el('span', { class: 'td hide-sm mono', role: 'cell' }, pages ? `${pages} pp · ${mins} min` : '—'),
            el('span', { class: 'td hide-sm mono', role: 'cell' }, l.quizScore?.total ? `${l.quizScore.score}/${l.quizScore.total}` : '—'),
            el('span', { class: 'td hide-sm mono faint', role: 'cell' }, relTime(l.updatedAt)),
            el('span', { class: 'td td-act', role: 'cell' }, el('button', { class: 'icon-btn plain', type: 'button', 'aria-label': `Delete lesson ${l.title || l.topic}`, onclick: () => deleteLesson(l) }, icon('trash'))));
        }))) : null;

    const moreLists = more.filter(([, g]) => g.total).map(([type, g]) => el('section', { class: 'panel-section' },
      el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, type === 'card' ? 'Cards' : 'Teacher chats', el('span', { class: 'count' }, String(g.total)))),
      el('ul', { class: 'search-list', 'aria-label': type === 'card' ? 'Matching cards' : 'Matching Teacher chats' },
        ...g.results.slice(0, MORE_LIMIT).map((r) => el('li', null, resultLink(r)))),
      g.total > MORE_LIMIT ? el('p', { class: 'search-list-more muted small' }, `${g.total - MORE_LIMIT} more. Add a word to narrow it down.`) : null));

    const empty = !courseTable && !lessonTable && !moreLists.length ? el('div', { class: 'empty-state' },
      el('h2', { class: 'h-lg' }, query ? 'Nothing matches' : filter === 'finished' ? 'No finished lessons yet' : 'Your library is empty'),
      el('p', { class: 'muted' }, query ? `Nothing in your lessons, cards or chats mentions “${query}” yet. Want a lesson on it?` : 'Lessons and courses you start show up here.'),
      query ? el('button', { class: 'btn', type: 'button', onclick: () => actions.startLesson(query.trim(), 'beginner') }, `Start a lesson on “${query.trim().slice(0, 40)}”`, icon('arrow-right'))
        : el('a', { class: 'btn', href: '#/' }, 'Start a lesson', icon('arrow-right'))) : null;

    body.replaceChildren(...[courseTable, lessonTable, ...moreLists, empty].filter(Boolean));
  }

  const sortSel = el('select', { class: 'cmd-level', 'aria-label': 'Sort lessons', onchange: (e) => setSort(e.target.value) }, ...Object.entries(SORTS).map(([k, v]) => el('option', { value: k }, `Sort: ${v}`)));
  sortSel.value = sort;
  app.replaceChildren(el('div', { class: 'page lib' },
    el('header', { class: 'page-head' }, el('h1', { class: 'h-xl' }, 'Library'), counts),
    el('div', { class: 'lib-tools', role: 'search' }, el('label', { class: 'search-box' }, icon('search'), search), seg, sortSel),
    live, body));
  draw();
}
