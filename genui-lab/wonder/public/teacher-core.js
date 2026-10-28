// Pure helpers for the Teacher screen (no DOM): the progress snapshot sent with each request,
// and the text history sent back to the model (cards become short "[Card: …]" notes so the
// model knows what it showed and what the learner did, without ever seeing card markup).

import { deckStats, currentStreak, dateKey } from './deck.js';
import { allOutcomes, outcomeSnapshot, RECALL_MIN } from './outcomes-core.js'; // Phase 9
import { courseMemory, courseIsFading } from './course-review-core.js';

function courseProgress(data, course) {
  let done = 0;
  let total = 0;
  for (const s of course.sections || []) for (const l of s.lessons || []) { total++; if (l.lessonId && data.lessons?.[l.lessonId]?.finished) done++; }
  return { done, total };
}

/** Snapshot of the learner's progress, assembled from the local store (deck, lessons, courses, plans). */
export function progressSnapshot(data, now = new Date()) {
  const st = deckStats(data.deck || { items: [] }, now);
  const lessons = Object.values(data.lessons || {}).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  const outcomes = new Map(allOutcomes(data, now).map((o) => [o.lessonId, o]));
  const plans = (data.plans || []).slice(0, 3).map((p) => {
    const items = (p.days || []).flatMap((d) => d.items || []);
    return { goal: p.goal, days: (p.days || []).length, opened: items.filter((i) => i.opened).length, total: items.length };
  });
  return {
    today: dateKey(now),
    streak: currentStreak(data.stats || {}, now),
    deck: { total: st.total, due: st.due, mastered: st.review, nextDue: st.nextDue },
    recentLessons: lessons.map((l) => {
      const o = outcomes.get(l.id);
      return {
        title: l.title || l.topic,
        finished: !!l.finished,
        ...(l.quizScore ? { quiz: { score: l.quizScore.score, total: l.quizScore.total } } : {}),
        ...(o && o.recall.n >= RECALL_MIN ? { recall: Math.round(o.recall.rate * 100), recallReviews: o.recall.n } : {}),
        when: l.updatedAt || '',
      };
    }),
    courses: (data.courses || []).slice(0, 5).map((c) => {
      const m = courseMemory(data, c, now); // course review: due cards and fading memory across its lessons
      return { title: c.title, ...courseProgress(data, c), cardsDue: m.due, ...(m.memory != null ? { memory: Math.round(m.memory * 100) } : {}), ...(courseIsFading(m) ? { reviewSuggested: true } : {}) };
    }),
    plans,
    outcomes: outcomeSnapshot(data, now), // Phase 9: what faded, what works
  };
}

/**
 * Phase 10: the Teacher speaks first. A check-in turn sends this fixed, clearly marked user turn
 * (the server substitutes its own copy; the client never shows it as a learner bubble).
 */
export const TEACHER_OPENER = '[Wonder: the learner just opened the Teacher. This is an automatic check-in, not a message they typed. Call get_progress, then greet them in one or two sentences and propose the single best next step for today (a review, the next plan item, a refresher for a fading lesson, or a new lesson) with a card. Keep it short.]';

const CARD_RE = /<TeacherCard\b[^>]*?__resolutionId="([^"]+)"[^>]*\/>/g;

/** Assistant markdown with each TeacherCard replaced by a note built from its latest state. */
export function cardNotes(markdown, componentResults = {}) {
  return String(markdown || '')
    .replace(CARD_RE, (_, rid) => `[Card: ${componentResults?.[rid]?.state?.summary || 'an interactive card'}]`)
    .replace(/<\/?TeacherCard\b[^>]*>/g, '');
}

/** Thread messages -> [{role, content}] for /api/teacher/stream (last `max`). */
export function historyForModel(messages, max = 12) {
  return (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-max)
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? cardNotes(m.content, m.componentResults) : m.content }));
}

export function threadTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t || 'New chat';
}
