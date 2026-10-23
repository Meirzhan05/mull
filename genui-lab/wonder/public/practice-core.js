// Practice items: normalization and grading. Pure ES module shared by the server
// (/api/widget_action practice grading, /api/practice/extract validation) and the browser
// review session. Item types follow Wondering's PRACTICE_TYPES subset (findings §1.6):
//
//   mcq            {type, prompt, choices:[{id,text,isCorrect}], explanation}
//   cloze          {type, prompt:"... ____ ...", answer, acceptableAnswers[], explanation}
//   binary_choice  {type, prompt (a statement), answer:boolean, explanation}
//   flashcard      {type, front, back}
//   explain        {type, prompt, rubric[1-5], sampleAnswer} (Phase 8: free response, graded on the server)
//
// Visual types (wondering.app §1.6), rendered in the review screen by catalog-practice.js and
// graded here by code:
//   number_line    {type, prompt, min, max, step, answer, tolerance, unit, explanation}
//                  place a marker; the grid has 2-40 steps and the answer is reachable on it
//   chart_select   {type, prompt, chart:'bar'|'line', title, unit, showValues, points:[{label,value}], answer, explanation}
//                  pick the bar or point (index into points) that answers the question
//   order_steps    {type, prompt, steps[3-7] (correct order), explanation}; answer = indices in the learner's order

export const PRACTICE_ITEM_TYPES = Object.freeze(['mcq', 'cloze', 'binary_choice', 'flashcard', 'explain', 'number_line', 'chart_select', 'order_steps']);
export const VISUAL_PRACTICE_TYPES = Object.freeze(['number_line', 'chart_select', 'order_steps']);
export const VISUAL_LIMITS = Object.freeze({
  numberLine: { minSteps: 2, maxSteps: 40, maxAbs: 1e9 },
  chart: { minPoints: 2, maxPoints: 8, minLinePoints: 3, maxLabel: 40, maxTitle: 80 },
  order: { minSteps: 3, maxSteps: 7, maxStep: 120 },
});
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
  } else if (type === 'explain') {
    const prompt = t(raw.prompt);
    const rubric = (Array.isArray(raw.rubric) ? raw.rubric : []).map(t).filter(Boolean).map((c) => c.slice(0, 160)).slice(0, 5);
    if (!prompt || !rubric.length) return null;
    item = { type, prompt: prompt.slice(0, 400), rubric, sampleAnswer: t(raw.sampleAnswer || raw.sample_answer).slice(0, 800) };
  } else if (type === 'number_line') item = normalizeNumberLine(raw, explanation);
  else if (type === 'chart_select') item = normalizeChartSelect(raw, explanation);
  else if (type === 'order_steps') item = normalizeOrderSteps(raw, explanation);
  if (!item) return null;
  item.id = t(raw.id) || `${type}-${hashId(JSON.stringify(item))}`;
  const concept = t(raw.concept).replace(/\s+/g, ' ').slice(0, 60).trim(); // Phase 6: mastery tag (not part of the id)
  if (concept) item.concept = concept;
  return item;
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const clean = (v, max) => t(v).replace(/\s+/g, ' ').slice(0, max).trim();
const EPS = 1e-9;

/** Decimal places needed to show multiples of `step` (0-4). */
export function stepDecimals(step) {
  for (let d = 0; d <= 4; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 4;
}

/** A number as the review screen shows it: no float noise, thousands separators. */
export function formatPracticeNumber(v, decimals = 2) {
  if (!Number.isFinite(v)) return '–';
  const r = Number(v.toFixed(Math.max(0, Math.min(4, decimals))));
  return Math.abs(r) >= 10000 ? r.toLocaleString('en-US') : String(r);
}

/** "12 %" -> "12%": symbols hug the number, words get a space. */
export function withUnit(text, unit) {
  return unit ? (/^[%°′″‰]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`) : String(text);
}

/** Grid positions of a number_line item: min, min+step, ..., max. */
export function numberLineStops(item) {
  const n = Math.round((item.max - item.min) / item.step);
  const d = stepDecimals(item.step);
  return Array.from({ length: n + 1 }, (_, i) => Number((item.min + i * item.step).toFixed(d)));
}

function normalizeNumberLine(raw, explanation) {
  const prompt = t(raw.prompt);
  const min = num(raw.min);
  const max = num(raw.max);
  const step = num(raw.step);
  const answer = num(raw.answer ?? raw.target);
  const tolerance = raw.tolerance == null || raw.tolerance === '' ? 0 : num(raw.tolerance);
  const L = VISUAL_LIMITS.numberLine;
  if (!prompt || ![min, max, step, answer, tolerance].every(Number.isFinite)) return null;
  if (Math.abs(min) > L.maxAbs || Math.abs(max) > L.maxAbs || !(max > min) || !(step > 0)) return null;
  const steps = (max - min) / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6 || Math.round(steps) < L.minSteps || Math.round(steps) > L.maxSteps) return null;
  if (answer < min - EPS || answer > max + EPS) return null;
  if (tolerance < 0 || tolerance > (max - min) / 4) return null;
  // the learner can only place the marker on the grid: some grid point must be within tolerance
  const nearest = min + Math.round((answer - min) / step) * step;
  if (Math.abs(nearest - answer) > tolerance + step * 1e-6) return null;
  return { type: 'number_line', prompt: prompt.slice(0, 400), min, max, step, answer, tolerance, unit: clean(raw.unit, 16), explanation };
}

function normalizeChartSelect(raw, explanation) {
  const prompt = t(raw.prompt);
  const L = VISUAL_LIMITS.chart;
  const chart = t(raw.chart || raw.chart_kind || 'bar') === 'line' ? 'line' : t(raw.chart || raw.chart_kind || 'bar') === 'bar' ? 'bar' : null;
  const rawPoints = Array.isArray(raw.points) ? raw.points : Array.isArray(raw.bars) ? raw.bars : [];
  const points = rawPoints.map((p) => ({ label: clean(p?.label, L.maxLabel), value: num(p?.value) }));
  const answer = Number.isInteger(raw.answer) ? raw.answer : Number.isInteger(raw.correct_index) ? raw.correct_index : null;
  if (!prompt || !chart || points.length < (chart === 'line' ? L.minLinePoints : L.minPoints) || points.length > L.maxPoints) return null;
  if (points.some((p) => !p.label || !Number.isFinite(p.value) || Math.abs(p.value) > 1e12)) return null;
  if (new Set(points.map((p) => p.label.toLowerCase())).size !== points.length) return null;
  if (answer === null || answer < 0 || answer >= points.length) return null;
  return { type: 'chart_select', prompt: prompt.slice(0, 400), chart, title: clean(raw.title || raw.chart_title, L.maxTitle), unit: clean(raw.unit, 16), showValues: raw.showValues !== false && raw.show_values !== false, points, answer, explanation };
}

function normalizeOrderSteps(raw, explanation) {
  const prompt = t(raw.prompt);
  const L = VISUAL_LIMITS.order;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s) => clean(typeof s === 'object' && s ? s.label || s.text : s, L.maxStep));
  if (!prompt || steps.length < L.minSteps || steps.length > L.maxSteps || steps.some((s) => !s)) return null;
  if (new Set(steps.map(normalizeAnswerText)).size !== steps.length) return null;
  return { type: 'order_steps', prompt: prompt.slice(0, 400), steps, explanation };
}

/** Pairs (i<j) the learner put in the wrong relative order; null when `order` is not a permutation. */
export function orderInversions(order, n) {
  if (!Array.isArray(order) || order.length !== n) return null;
  if (new Set(order).size !== n || order.some((x) => !Number.isInteger(x) || x < 0 || x >= n)) return null;
  let inv = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (order[i] > order[j]) inv++;
  return inv;
}

/**
 * The scrambled order an order_steps item starts in: deterministic per item id, never already
 * solved, and at least two swaps away from the answer.
 */
export function orderStepsStart(item) {
  const n = item.steps.length;
  let x = 0;
  for (const c of String(item.id || item.prompt)) x = (Math.imul(x, 31) + c.charCodeAt(0)) >>> 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const j = x % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    if (orderInversions(a, n) >= 2) return a;
  }
  return Array.from({ length: n }, (_, i) => n - 1 - i); // fully reversed
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
    case 'explain': {
      // graded on the server (server/grader.js); `answer` is that grade {score 0-3}
      const score = Math.max(0, Math.min(3, Number(answer?.score) || 0));
      return { correct: score >= 2, rating: [RATING.again, RATING.hard, RATING.good, RATING.easy][score], expected: item.sampleAnswer || '' };
    }
    case 'number_line': {
      // inside the tolerance passes: Good in its inner half, Hard near its edge; outside is Again
      const value = Number(answer);
      const d = stepDecimals(item.step);
      const expected = withUnit(formatPracticeNumber(item.answer, Math.max(d, stepDecimals(item.answer))), item.unit);
      if (answer == null || answer === '' || !Number.isFinite(value)) return { correct: false, rating: RATING.again, expected, distance: null, close: false };
      const distance = Math.abs(value - item.answer);
      const slack = item.step * 1e-6;
      const correct = distance <= item.tolerance + slack;
      const rating = !correct ? RATING.again : distance <= item.tolerance / 2 + slack ? RATING.good : RATING.hard;
      const close = !correct && distance <= item.tolerance + item.step + slack;
      return { correct, rating, expected, distance: Number(distance.toFixed(Math.max(d, 4))), close };
    }
    case 'chart_select': {
      const correct = answer === item.answer;
      return { correct, rating: correct ? RATING.good : RATING.again, expected: item.points[item.answer]?.label ?? '' };
    }
    case 'order_steps': {
      // exact order: Good; one pair out of order in a list of 4+: Hard (passes); otherwise Again
      const n = item.steps.length;
      const inversions = orderInversions(answer, n);
      const expected = item.steps.join(' → ');
      if (inversions === null) return { correct: false, rating: RATING.again, expected, inversions: null, inPlace: 0 };
      const inPlace = answer.filter((s, i) => s === i).length;
      const correct = inversions === 0 || (inversions === 1 && n >= 4);
      return { correct, rating: inversions === 0 ? RATING.good : correct ? RATING.hard : RATING.again, expected, inversions, inPlace };
    }
    default:
      return { correct: false, rating: RATING.again, expected: '' };
  }
}
