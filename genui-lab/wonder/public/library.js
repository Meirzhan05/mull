// Library (#/library): every course and lesson in this browser, with search, a status filter
// and delete. Courses get a generated cover color from their title.

import { el, icon, toast, relTime } from './ui.js';
import { courseProgress, matchScore } from './progress-core.js';

const FILTERS = [['all', 'All'], ['progress', 'In progress'], ['finished', 'Finished'], ['courses', 'Courses']];

export function coverStyle(title) {
  let h = 0;
  for (const ch of String(title || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = h % 360;
  return { background: `linear-gradient(135deg, hsl(${hue} 62% 58%) 0%, hsl(${(hue + 40) % 360} 58% 44%) 100%)` };
}

/** @param {{app: HTMLElement, store: object, actions: object}} ctx */
export function renderLibrary(ctx) {
  const { app, store, actions } = ctx;
  let filter = 'all';
  let query = '';
  try { filter = sessionStorage.getItem('wonder.libFilter') || 'all'; } catch {}

  const search = el('input', { type: 'search', placeholder: 'Search your lessons and courses', 'aria-label': 'Search library' });
  const seg = el('div', { class: 'seg', role: 'tablist', 'aria-label': 'Filter' }, ...FILTERS.map(([id, label]) => el('button', {
    class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': String(id === filter), dataset: { f: id },
    onclick: () => { filter = id; try { sessionStorage.setItem('wonder.libFilter', id); } catch {} for (const b of seg.children) b.setAttribute('aria-selected', String(b.dataset.f === id)); draw(); },
  }, label)));
  const body = el('div', { class: 'page' });
  search.addEventListener('input', () => { query = search.value; draw(); });

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

  function draw() {
    const d = store.data;
    const courses = filter === 'all' || filter === 'courses' ? d.courses.filter((c) => matchScore(c.title, query) > 0) : [];
    const lessons = filter === 'courses' ? [] : Object.values(d.lessons)
      .filter((l) => matchScore(l.title || l.topic, query) > 0)
      .filter((l) => filter === 'finished' ? l.finished : filter === 'progress' ? !l.finished : true)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const courseSec = courses.length ? el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Courses'), el('span', { class: 'muted small' }, String(courses.length))),
      el('div', { class: 'course-grid' }, ...courses.map((c) => {
        const p = courseProgress(d, c);
        return el('div', { class: 'card course-card' },
          el('a', { href: `#/course/${c.id}`, style: { display: 'grid', gap: '8px', textDecoration: 'none' } },
            el('span', { class: 'course-cover', style: coverStyle(c.title), 'aria-hidden': 'true' }, icon('layers')),
            el('strong', { class: 'course-title' }, c.title),
            el('span', { class: 'muted small' }, `${p.done} of ${p.total} lessons · ${c.level || 'beginner'}`),
            el('span', { class: 'progress small-progress' }, el('span', { class: 'progress-fill', style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%`, background: p.done === p.total && p.total ? 'var(--success)' : '' } }))),
          el('div', { class: 'row-actions', style: { position: 'absolute', top: '14px', right: '14px' } },
            el('button', { class: 'icon-btn', type: 'button', style: { background: 'rgba(255,255,255,.25)', color: '#fff' }, 'aria-label': `Delete course ${c.title}`, onclick: () => deleteCourse(c) }, icon('trash'))));
      }))) : null;

    const lessonSec = lessons.length ? el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Lessons'), el('span', { class: 'muted small' }, String(lessons.length))),
      el('ul', { class: 'lesson-list' }, ...lessons.map((l) => {
        const course = l.courseId ? d.courses.find((c) => c.id === l.courseId) : null;
        const st = l.finished ? ['done', 'Finished'] : l.status === 'complete' ? ['ready', 'In progress'] : l.status === 'failed' ? ['warn', 'Failed'] : ['warn', l.status === 'new' ? 'Not started' : 'Unfinished'];
        return el('li', { style: { display: 'flex', alignItems: 'center' } },
          el('a', { class: 'lesson-row', href: `#/lesson/${l.id}`, style: { flex: '1' } },
            el('span', { class: `status-dot ${st[0]}`, 'aria-hidden': 'true' }),
            el('span', { class: 'lesson-row-main' },
              el('span', { class: 'lesson-row-title' }, l.title || l.topic),
              el('span', { class: 'lesson-row-meta' }, el('span', null, st[1]), course ? el('span', null, `· ${course.title}`) : null, l.quizScore?.total ? el('span', null, `· Quiz ${l.quizScore.score}/${l.quizScore.total}`) : null, el('span', null, `· ${relTime(l.updatedAt)}`)))),
          el('div', { class: 'row-actions', style: { paddingRight: '10px' } },
            el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete lesson ${l.title || l.topic}`, onclick: () => deleteLesson(l) }, icon('trash'))));
      }))) : null;

    const empty = !courseSec && !lessonSec ? el('div', { class: 'card empty-state' },
      el('span', { class: 'empty-art', 'aria-hidden': 'true' }, icon(query ? 'search' : 'library', 'big-icon')),
      el('h2', { class: 'h-lg' }, query ? 'Nothing matches' : filter === 'finished' ? 'No finished lessons yet' : 'Your library is empty'),
      el('p', { class: 'muted' }, query ? `Nothing called “${query}” yet. Want a lesson on it?` : 'Lessons and courses you start show up here.'),
      query ? el('button', { class: 'btn', type: 'button', onclick: () => actions.startLesson(query.trim(), 'beginner') }, icon('play'), `Start a lesson on “${query.trim().slice(0, 40)}”`)
        : el('a', { class: 'btn', href: '#/' }, icon('play'), 'Start a lesson')) : null;

    body.replaceChildren(...[courseSec, lessonSec, empty].filter(Boolean));
  }

  app.replaceChildren(el('div', { class: 'page', style: { maxWidth: '980px', margin: '0 auto' } },
    el('header', { class: 'page-head' }, el('div', null, el('h1', { class: 'h-xl' }, 'Library'), el('p', { class: 'muted' }, 'Everything you have learned or started, in this browser.'))),
    el('div', { class: 'lib-tools' }, el('label', { class: 'search-box' }, icon('search'), search), seg),
    body));
  draw();
}
