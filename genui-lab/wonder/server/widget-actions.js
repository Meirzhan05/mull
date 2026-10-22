// POST /api/widget_action: server actions dispatched by DIL widgets through
// GenUI.dispatchWidgetAction (ChatGPT's /backend-api/widget_server_action analogue,
// findings §3.6). Results come back as appData.opGenui.componentResults entries that the
// client merges and re-renders with.

import { normalizeQuestion } from './catalog-schema.js';
import { normalizePracticeItem, gradePracticeItem } from '../public/practice-core.js';
import { TEACHER_ACTIONS, handleTeacherAction, createCardStore } from './teacher.js';
import { createMemoryStore } from './memory.js';
import { validateExplainBack, gradeDeterministic, gradeRating, MIN_ANSWER } from './grader.js'; // Phase 8

const MAX_TRACKED = 2000;

/**
 * @param {{cards?: ReturnType<typeof createCardStore>, memory?: ReturnType<typeof createMemoryStore>, grade?: Function}} [deps]
 *   Teacher card state (per resolution id) and the learner memory store, shared with /api/teacher/stream;
 *   `grade` (server/grader.js createGrader) grades free-response answers (Phase 8). Without it,
 *   the keyword grader is used. Free-response actions return a Promise; the rest are synchronous.
 */
export function createWidgetActionHandler({ cards = createCardStore(), memory = createMemoryStore({ file: null }), grade = null } = {}) {
  const gradeAnswer = grade || (async (item) => (String(item.answer || '').trim().length < MIN_ANSWER ? { ok: false, error: 'Write a sentence or two first.' } : { ok: true, grade: gradeDeterministic(item) }));
  const states = new Map(); // resolutionId -> quiz state

  function quizState(rid, attempt) {
    let s = states.get(rid);
    if (!s || (Number.isInteger(attempt) && attempt !== s.attempt)) {
      s = { attempt: Number.isInteger(attempt) ? attempt : 0, answers: {}, score: 0, answered: 0 };
      states.set(rid, s);
      if (states.size > MAX_TRACKED) states.delete(states.keys().next().value);
    }
    return s;
  }

  return function handle(body) {
    const { componentName, action_type: type, payload = {}, resolutionId } = body || {};
    if (typeof type !== 'string' || !type) return { status: 400, body: { ok: false, error: 'action_type is required' } };

    if (type === 'quiz_answer') {
      if (typeof resolutionId !== 'string' || !resolutionId) return { status: 400, body: { ok: false, error: 'resolutionId is required' } };
      const q = normalizeQuestion(payload.question);
      if (!q.ok) return { status: 400, body: { ok: false, error: q.error } };
      const question = q.props;
      const selected = (Array.isArray(payload.selected_values) ? payload.selected_values : []).map(String);
      if (!selected.length || selected.some((v) => !question.options.some((o) => o.value === v))) {
        return { status: 400, body: { ok: false, error: 'selected_values must name options of the question' } };
      }
      const isCorrect = selected.length === question.correct_values.length && selected.every((v) => question.correct_values.includes(v));
      const s = quizState(resolutionId, payload.attempt);
      s.answers[question.id] = { selected_values: selected, is_correct: isCorrect, correct_values: question.correct_values, explanation: question.explanation || '' };
      s.answered = Object.keys(s.answers).length;
      s.score = Object.values(s.answers).filter((a) => a.is_correct).length;
      return {
        status: 200,
        body: {
          ok: true,
          result: { is_correct: isCorrect, correct_values: question.correct_values, explanation: question.explanation || '' },
          componentResults: { [resolutionId]: { status: 'resolved', state: structuredClone(s) } },
        },
      };
    }

    if (type === 'quiz_restart') {
      if (typeof resolutionId !== 'string' || !resolutionId) return { status: 400, body: { ok: false, error: 'resolutionId is required' } };
      const s = { attempt: Number.isInteger(payload.attempt) ? payload.attempt : 0, answers: {}, score: 0, answered: 0 };
      states.set(resolutionId, s);
      return { status: 200, body: { ok: true, componentResults: { [resolutionId]: { status: 'resolved', state: structuredClone(s) } } } };
    }

    if (type === 'explain_more') {
      const topic = String(payload.topic || payload.term || componentName || 'this').slice(0, 200);
      const message = String(payload.query || `Can you explain ${topic} in more detail, with an example?`).slice(0, 2000);
      return { status: 200, body: { ok: true, issueTurn: { message } } };
    }

    if (TEACHER_ACTIONS.has(type)) return handleTeacherAction({ cards, memory }, { action_type: type, payload, resolutionId });

    // Phase 8: free-response answer for an ExplainBack widget, graded against its rubric
    if (type === 'explain_grade') {
      if (typeof resolutionId !== 'string' || !resolutionId) return { status: 400, body: { ok: false, error: 'resolutionId is required' } };
      const v = validateExplainBack(payload.item || {});
      if (!v.ok) return { status: 400, body: { ok: false, error: v.error } };
      const attempt = Number.isInteger(payload.attempt) && payload.attempt >= 0 ? payload.attempt : 0;
      const answer = String(payload.answer ?? '').slice(0, 1500);
      return gradeAnswer({ ...v.props, answer }).then((r) => {
        const state = r.ok ? { attempt, answer, grade: r.grade } : { attempt, answer, error: r.error };
        return { status: 200, body: { ok: true, ...(r.ok ? { result: r.grade } : {}), componentResults: { [resolutionId]: { status: 'resolved', state } } } };
      });
    }

    if (type === 'practice_grade') {
      const item = normalizePracticeItem(payload.item);
      if (!item) return { status: 400, body: { ok: false, error: 'invalid practice item' } };
      if (item.type === 'explain') {
        return gradeAnswer({ prompt: item.prompt, rubric: item.rubric, sampleAnswer: item.sampleAnswer, answer: String(payload.answer ?? '') }).then((r) => (r.ok
          ? { status: 200, body: { ok: true, result: { correct: r.grade.score >= 2, rating: gradeRating(r.grade.score), expected: item.sampleAnswer || '', grade: r.grade } } }
          : { status: 400, body: { ok: false, error: r.error } }));
      }
      return { status: 200, body: { ok: true, result: gradePracticeItem(item, payload.answer) } };
    }

    return { status: 400, body: { ok: false, error: `Unknown action ${type}` } };
  };
}
