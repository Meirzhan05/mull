// Practice answer validation: ports of parseMCQOptions / validateMCQ / validateCloze /
// validateBinaryChoice / validatePracticeAnswer (@4337205-@4339400). DOM-free.

export const PRACTICE_TYPES = Object.freeze({
  FLASHCARD: "flashcard",
  MCQ: "mcq",
  BINARY_CHOICE: "binary_choice",
  CLOZE: "cloze",
  POOL_CLOZE: "pool_cloze",
  DRAG_ORDER_STEPS: "drag_order_steps",
  OPEN_ENDED_EXPLANATION: "open_ended_explanation",
  COMPARE_CONTRAST: "compare_contrast",
  MATCHING_PAIRS: "matching_pairs",
  VISUAL: "visual",
});

export const NEEDS_ASYNC_GRADING = "needs_async_grading";

export function parseMCQOptions(options) {
  if (!options || !options.choices) return [];
  return options.choices.map((c, i) => ({ id: c.id || String.fromCharCode(97 + i), text: c.text || c.choice || "", isCorrect: c.isCorrect || c.correct || false }));
}

/** answer: Set of choice ids (multi-select uses a Set). */
export function validateMCQ(options, answer) {
  const picked = answer instanceof Set ? Array.from(answer) : [];
  const correct = parseMCQOptions(options).filter((c) => c.isCorrect).map((c) => c.id);
  return picked.length === correct.length && picked.every((id) => correct.includes(id));
}

/** answer: {clozeId: text}; case-insensitive, acceptableAnswers allowed. */
export function validateCloze(options, answer) {
  const clozes = options.clozes || [];
  if (!answer || Object.keys(answer).length === 0) return false;
  return clozes.every((c) => {
    const given = answer[c.id]?.trim().toLowerCase() || "";
    const expected = c.answer?.trim().toLowerCase() || "";
    if (given === expected) return true;
    return c.acceptableAnswers ? c.acceptableAnswers.some((a) => given === a.trim().toLowerCase()) : false;
  });
}

export function validateBinaryChoice(options, answer) {
  if (!answer) return false;
  const correct = parseMCQOptions(options).find((c) => c.isCorrect);
  return answer === correct?.id;
}

export function validatePracticeAnswer(practice, answer) {
  switch (practice.type) {
    case PRACTICE_TYPES.FLASHCARD:
      return answer === "recall";
    case PRACTICE_TYPES.MCQ:
      return validateMCQ(practice.options, answer);
    case PRACTICE_TYPES.CLOZE:
      return validateCloze(practice.options, answer);
    case PRACTICE_TYPES.BINARY_CHOICE:
      return validateBinaryChoice(practice.options, answer);
    case PRACTICE_TYPES.OPEN_ENDED_EXPLANATION:
    case PRACTICE_TYPES.COMPARE_CONTRAST:
      return NEEDS_ASYNC_GRADING;
    default:
      return false;
  }
}

/** Splits a cloze question `… {{c1::answer}} …` into text and blank segments (MarkdownClozeRenderer @4134500). */
export function splitClozeQuestion(question) {
  const out = [];
  const re = /\{\{(c\d+)::([^}]+)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(question)) !== null) {
    if (m.index > last) out.push({ type: "text", value: question.slice(last, m.index) });
    const [answer, hint] = m[2].split("::");
    out.push({ type: "cloze", id: m[1], answer, hint });
    last = re.lastIndex;
  }
  if (last < question.length) out.push({ type: "text", value: question.slice(last) });
  return out;
}
