// Whole-course review (#/review/course/<id>): the review screen (review.js) run on an interleaved
// queue from course-review-core.js, ending with recall per lesson and the weakest lesson, with
// the Phase 9 Refresh / Relearn actions. Ratings go through review.js, so they write ordinary
// FSRS logs and Phase 6 mastery evidence like any other review.

import { el, icon, inlineMd } from './ui.js';
import { renderReview } from './review.js';
import { courseReviewSession, courseReviewSummary, courseMemory, courseIsFading } from './course-review-core.js';
import { relearnLesson } from './insights-panel.js';

const pct = (r) => `${Math.round(r * 100)}%`;

/** "Review whole course" for the course view, or null while the course has no cards. */
export function courseReviewButton(store, course) {
  const m = courseMemory(store.data, course);
  if (!m.cards) return null;
  const note = [m.memory != null ? `~${pct(m.memory)} remembered` : null, m.due ? `${m.due} due` : null].filter(Boolean).join(' · ');
  return el('a', { class: `btn btn-secondary btn-lg course-review-btn ${courseIsFading(m) ? 'is-fading' : ''}`, href: `#/review/course/${course.id}`, title: 'Cards from every lesson in this course, mixed together' },
    el('span', { class: 'course-review-label' }, icon('layers'), 'Review whole course'), note ? el('span', { class: 'course-review-note' }, note) : null);
}

function summaryNode(ctx, course, results) {
  const s = courseReviewSummary(ctx.store.data, course, results);
  if (!s.lessons.length) return null;
  const rows = el('ul', { class: 'mastery-items' }, ...s.lessons.map((l) => {
    const v = Math.round(l.rate * 100);
    return el('li', { class: `mastery-item works-item ${s.weakest?.lessonId === l.lessonId ? 'is-weakest' : ''}` },
      el('div', { class: 'mastery-text' }, el('strong', null, l.title || 'Untitled lesson'), el('span', { class: 'muted small' }, `${l.correct} of ${l.n} recalled`)),
      el('div', { class: 'mastery-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(v), 'aria-label': `${l.title}: ${v}% recalled` },
        el('span', { class: 'mastery-fill', style: { width: `${v}%` } })),
      el('span', { class: 'mastery-pct' }, `${v}%`));
  }));
  const w = s.weakest;
  const lesson = w ? ctx.store.data.lessons[w.lessonId] : null;
  const weakest = w
    ? el('div', { class: 'course-review-weakest' },
      el('p', null, 'Weakest: ', el('strong', null, inlineMd(w.title || 'Untitled lesson')), ` · ${w.correct} of ${w.n} recalled`),
      el('div', { class: 'works-actions' },
        el('a', { class: 'btn btn-secondary btn-sm', href: `#/review/lesson/${w.lessonId}` }, 'Refresh'),
        lesson ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => relearnLesson(ctx, lesson) }, 'Relearn') : null))
    : el('p', { class: 'muted small' }, 'Every lesson held up. Mixed recall like this is the real test.');
  return el('section', { class: 'course-review-sum', 'aria-label': 'Recall by lesson' },
    el('h2', { class: 'rubric' }, 'By lesson'), rows, weakest);
}

export function renderCourseReview(ctx, courseId) {
  const { app, store, teardown, shell, refresh } = ctx;
  const course = (store.data.courses || []).find((c) => c.id === courseId);
  const back = course ? `#/course/${course.id}` : '#/library';
  const { entries } = course ? courseReviewSession(store.data, course) : { entries: [] };
  if (!entries.length) {
    app.replaceChildren(el('div', { class: 'review-wrap' }, el('div', { class: 'card empty-review' },
      el('p', { class: 'kicker' }, 'Course review'),
      el('h1', { class: 'h-lg' }, course ? 'No cards in this course yet' : 'Not found'),
      el('p', { class: 'muted' }, course ? 'Finish a lesson and collect its cards. A course review mixes the cards of all its lessons.' : 'This course is no longer stored in this browser.'),
      el('a', { class: 'btn', href: back }, course ? 'Back to the course' : 'Library'))));
    return;
  }
  const inner = el('div');
  app.replaceChildren(el('div', { class: 'review-wrap' },
    el('p', { class: 'kicker course-review-kicker' }, el('a', { href: back }, icon('arrow-left'), course.title), ' · Course review, all lessons mixed'),
    inner));
  const cleanup = renderReview(inner, {
    store,
    entries,
    onExit: () => { location.hash = back; },
    onXp: () => { refresh(); shell.bump(); },
    summary: (results) => summaryNode(ctx, course, results),
  });
  if (typeof cleanup === 'function') teardown.push(cleanup);
}
