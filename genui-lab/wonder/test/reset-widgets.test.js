// "Reset interactive widgets" restarts server-graded quizzes: after quiz_restart (attempt 0),
// a new answer must not merge with the answers given before the reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetActionHandler } from '../server/widget-actions.js';

const q = (id, correct) => ({ id, prompt: `Question ${id}?`, question_type: 'single_select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_values: [correct], hint: '', explanation: 'Because.' });

test('quiz_restart forgets earlier answers for the same resolution id and attempt', () => {
  const handle = createWidgetActionHandler();
  const rid = 'quiz-rid-1';
  const answer = (question, v) => handle({ componentName: 'Quiz', action_type: 'quiz_answer', resolutionId: rid, payload: { question, selected_values: [v], attempt: 0 } });
  answer(q('q1', 'a'), 'a');
  const before = answer(q('q2', 'b'), 'a').body.componentResults[rid].state;
  assert.equal(before.answered, 2);

  const reset = handle({ componentName: 'Quiz', action_type: 'quiz_restart', resolutionId: rid, payload: { attempt: 0 } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.componentResults[rid].state.answered, 0);

  const after = answer(q('q1', 'a'), 'b').body.componentResults[rid].state;
  assert.equal(after.answered, 1, 'only the post-reset answer counts');
  assert.equal(after.score, 0);
});
