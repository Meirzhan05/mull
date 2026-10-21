// Practice items: normalization and grading. Pure ES module shared by the server
// (/api/widget_action practice grading, /api/practice/extract validation) and the browser
// review session. Item types follow Wondering's PRACTICE_TYPES subset (findings §1.6):
//
//   mcq            {type, prompt, choices:[{id,text,isCorrect}], explanation}
//   cloze          {type, prompt:"... ____ ...", answer, acceptableAnswers[], explanation}
//   binary_choice  {type, prompt (a statement), answer:boolean, explanation}
//   flashcard      {type, front, back}

export const PRACTICE_ITEM_TYPES = Object.freeze(['mcq', 'cloze', 'binary_choice', 'flashcard']);
export const RATING = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 }); // == fsrs.js Rating

const t = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** Normalize one practice item; returns null when it is unusable. */
export function normalizePracticeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = t(raw.type);
  const explanation = t(raw.explanation);
  let item = null;
  if (type === 'mcq') {
    const prompt = t(raw.prompt);
    let choices = Array.isArray(raw.choices) ? raw.choices : [];
    choices = choices.map((c, i) => (typeof c === 'string'
      ? { id: String.fromCharCode(97 + i), text: c.trim(), isCorrect: i === raw.correct_index }
      : { id: t(c.id) || String.fromCharCode(97 + i), text: t(c.text || c.label), isCorrect: !!(c.isCorrect || c.correct) })).filter((c) => c.text).slice(0, 5);
    if (!prompt || choices.length < 2 || choices.filter((c) => c.isCorrect).length !== 1) return null;
    item = { type, prompt, choices, explanation };
  } else if (type === 'cloze') {
    let prompt = t(raw.prompt);
    const answer = t(raw.answer);
    if (!prompt || !answer) return null;
    if (!/_{3,}/.test(prompt)) {
      // accept "{{answer}}" / "[answer]" blanks, or blank the answer itself
      const re = new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (!re.test(prompt)) return null;
      prompt = prompt.replace(re, '____');
    }
    prompt = prompt.replace(/_{3,}/, '____');
    const acceptableAnswers = (Array.isArray(raw.acceptableAnswers) ? raw.acceptableAnswers : []).map(t).filter(Boolean);
    item = { type, prompt, answer, acceptableAnswers, explanation };
  } else if (type === 'binary_choice') {
    const prompt = t(raw.prompt || raw.statement);
    const answer = typeof raw.answer === 'boolean' ? raw.answer : typeof raw.is_true === 'boolean' ? raw.is_true : null;
    if (!prompt || answer === null) return null;
    item = { type, prompt, answer, explanation };
  } else if (type === 'flashcard') {
    const front = t(raw.front);
    const back = t(raw.back);
    if (!front || !back) return null;
    item = { type, front, back };
  }
  if (!item) return null;
  item.id = t(raw.id) || `${type}-${hashId(JSON.stringify(item))}`;
  const concept = t(raw.concept).replace(/\s+/g, ' ').slice(0, 60).trim(); // Phase 6: mastery tag (not part of the id)
  if (concept) item.concept = concept;
  return item;
}

export function normalizeAnswerText(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Grade an answer. mcq: choice id; cloze: text; binary_choice: boolean; flashcard: self-grade
 * 'again'|'hard'|'good'|'easy'. Returns {correct, rating, expected}.
 */
export function gradePracticeItem(item, answer) {
  switch (item?.type) {
    case 'mcq': {
      const right = item.choices.find((c) => c.isCorrect);
      const correct = answer === right?.id;
      return { correct, rating: correct ? RATING.good : RATING.again, expected: right?.text ?? '' };
    }
    case 'cloze': {
      const given = normalizeAnswerText(answer);
      const options = [item.answer, ...(item.acceptableAnswers || [])].map(normalizeAnswerText).filter(Boolean);
      let correct = options.includes(given);
      let close = false;
      if (!correct && given.length >= 4) close = options.some((o) => o.length >= 5 && levenshtein(o, given) <= 1);
      if (close) correct = true; // a typo still counts, rated Hard
      return { correct, rating: correct ? (close ? RATING.hard : RATING.good) : RATING.again, expected: item.answer, typo: close };
    }
    case 'binary_choice': {
      const correct = answer === item.answer;
      return { correct, rating: correct ? RATING.good : RATING.again, expected: item.answer ? 'True' : 'False' };
    }
    case 'flashcard': {
      const rating = RATING[answer] ?? RATING.good;
      return { correct: rating >= RATING.hard, rating, expected: item.back };
    }
    default:
      return { correct: false, rating: RATING.again, expected: '' };
  }
}
