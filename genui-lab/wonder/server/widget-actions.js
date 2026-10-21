// POST /api/widget_action: server actions dispatched by DIL widgets through
// GenUI.dispatchWidgetAction (ChatGPT's /backend-api/widget_server_action analogue,
// findings §3.6). Results come back as appData.opGenui.componentResults entries that the
// client merges and re-renders with.

import { normalizeQuestion } from './catalog-schema.js';
import { normalizePracticeItem, gradePracticeItem } from '../public/practice-core.js';

const MAX_TRACKED = 2000;

export function createWidgetActionHandler() {
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

    if (type === 'practice_grade') {
      const item = normalizePracticeItem(payload.item);
      if (!item) return { status: 400, body: { ok: false, error: 'invalid practice item' } };
      return { status: 200, body: { ok: true, result: gradePracticeItem(item, payload.answer) } };
    }

    return { status: 400, body: { ok: false, error: `Unknown action ${type}` } };
  };
}
