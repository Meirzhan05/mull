// /api/practice/extract: finished lesson -> knowledge cards + practice items.
// Claude path: one structured-output call (effort low). Fallback (no Claude, or it failed): deterministic
// extraction from the lesson's own <KeyTerm> and <Quiz> components.

import { preprocess } from './compile.js';
import { normalizePracticeItem, VISUAL_LIMITS } from '../public/practice-core.js';
import { buildStructuredParams, createStructured } from './claude.js';
import { EXTRACT_SYSTEM_PROMPT, EXTRACT_SCHEMA, EXTRACT_VISUAL_GUIDANCE } from './prompts.js';

// ------------------------------------------------------------------ visual practice items
// number_line / chart_select / order_steps join the flat item union. Structured output can't
// express numeric bounds, so the schema carries the shape and practice-core's normalizer
// enforces the limits (grid of 2-40 steps, reachable answer, 2-8 chart points, 3-7 steps...).
const L = VISUAL_LIMITS;
export const VISUAL_ITEM_PROPERTIES = Object.freeze({
  min: { type: 'number', description: 'number_line: left end' },
  max: { type: 'number', description: 'number_line: right end' },
  step: { type: 'number', description: `number_line: grid spacing; (max - min) / step is a whole number from ${L.numberLine.minSteps} to ${L.numberLine.maxSteps}` },
  target: { type: 'number', description: 'number_line: the correct value' },
  tolerance: { type: 'number', description: 'number_line: accepted distance from target (0 = exact grid point)' },
  unit: { type: 'string', description: 'number_line / chart_select: short unit such as "%" or "years"' },
  chart: { type: 'string', enum: ['bar', 'line', ''], description: 'chart_select: chart kind' },
  chart_title: { type: 'string' },
  points: {
    type: 'array',
    description: `chart_select: ${L.chart.minPoints}-${L.chart.maxPoints} bars or points (line: at least ${L.chart.minLinePoints}); correct_index picks the answer`,
    items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'number' } } },
  },
  show_values: { type: 'boolean', description: 'chart_select: print each value (false when reading the shape is the point)' },
  steps: { type: 'array', items: { type: 'string' }, description: `order_steps: ${L.order.minSteps}-${L.order.maxSteps} steps in the correct order` },
});

/** EXTRACT_SCHEMA with the visual item types and their fields added to every item. */
export function extractSchemaWithVisuals(base = EXTRACT_SCHEMA) {
  const item = base.properties.items.items;
  const props = { ...item.properties, ...VISUAL_ITEM_PROPERTIES };
  props.type = { ...item.properties.type, enum: [...new Set([...item.properties.type.enum, 'number_line', 'chart_select', 'order_steps'])] };
  return {
    ...base,
    properties: { ...base.properties, items: { ...base.properties.items, items: { ...item, properties: props, required: [...new Set([...item.required, ...Object.keys(VISUAL_ITEM_PROPERTIES)])] } } },
  };
}
export const PRACTICE_EXTRACT_SCHEMA = extractSchemaWithVisuals();
export const PRACTICE_EXTRACT_PROMPT = `${EXTRACT_SYSTEM_PROMPT}\n${EXTRACT_VISUAL_GUIDANCE}`;

export function lessonTitle(markdown) {
  const m = /^#\s+(.+)$/m.exec(String(markdown || ''));
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : 'Lesson';
}

/** Valid component props in document order, e.g. componentsOf(md, 'KeyTerm'). */
export function componentsOf(markdown, name) {
  return preprocess(String(markdown || ''), { partial: false }).components.filter((c) => c.status === 'valid' && c.name === name).map((c) => c.props);
}

function lowerFirst(s) {
  return s && /^[A-Z](?:[a-z]|\s)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

export function extractPracticeDeterministic(markdown) {
  const seen = new Set();
  const terms = componentsOf(markdown, 'KeyTerm').filter((k) => { const key = k.term.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  const quizzes = componentsOf(markdown, 'Quiz');
  const cards = terms.slice(0, 6).map((k) => ({ term: k.term, definition: k.definition, example: '' }));
  const raw = [];
  for (const quiz of quizzes) {
    for (const q of quiz.questions) {
      if (q.question_type === 'true_false') {
        raw.push({ type: 'binary_choice', prompt: q.prompt, answer: q.correct_values[0] === 'true', explanation: q.explanation || '', concept: q.concept });
      } else if (q.question_type === 'single_select') {
        raw.push({ type: 'mcq', prompt: q.prompt, choices: q.options.map((o) => ({ id: o.value, text: o.label, isCorrect: q.correct_values.includes(o.value) })), explanation: q.explanation || '', concept: q.concept });
      }
    }
  }
  const quizEnd = raw.length; // visual items go right after the lesson's own quiz questions
  terms.slice(0, 4).forEach((k) => {
    raw.push({ type: 'cloze', prompt: `____: ${k.definition}`, answer: k.term, acceptableAnswers: k.term.endsWith('s') ? [k.term.slice(0, -1)] : [], explanation: `${k.term} means ${lowerFirst(k.definition)}`, concept: k.term });
  });
  if (terms.length >= 2) {
    const [a, b] = terms;
    raw.push({ type: 'binary_choice', prompt: `"${a.term}" means: ${lowerFirst(b.definition)}`, answer: false, explanation: `That describes ${b.term}. ${a.term} means ${lowerFirst(a.definition)}`, concept: a.term });
  }
  terms.slice(0, 3).forEach((k) => raw.push({ type: 'flashcard', front: `What does "${k.term}" mean?`, back: k.definition, concept: k.term }));
  for (const e of componentsOf(markdown, 'ExplainBack').slice(0, 1)) raw.push({ type: 'explain', prompt: e.prompt, rubric: e.rubric, sampleAnswer: e.sampleAnswer, concept: e.concept }); // Phase 8
  const visual = visualItemsFromComponents(markdown).map(normalizePracticeItem).filter(Boolean).slice(0, 3);
  const kept = raw.map((r, i) => ({ item: normalizePracticeItem(r), quiz: i < quizEnd })).filter((x) => x.item).slice(0, 12);
  const items = [...kept.filter((x) => x.quiz).map((x) => x.item), ...visual, ...kept.filter((x) => !x.quiz).map((x) => x.item)];
  return { title: lessonTitle(markdown), cards, items, source: 'lesson-components' };
}

/** Map the flat structured-output union to practice items. */
export function itemsFromStructured(data) {
  const out = [];
  for (const it of Array.isArray(data?.items) ? data.items : []) {
    let raw = null;
    if (it.type === 'mcq') raw = { type: 'mcq', prompt: it.prompt, choices: it.choices, correct_index: it.correct_index, explanation: it.explanation };
    else if (it.type === 'cloze') raw = { type: 'cloze', prompt: it.prompt, answer: it.answer, explanation: it.explanation };
    else if (it.type === 'binary_choice') raw = { type: 'binary_choice', prompt: it.statement || it.prompt, answer: it.is_true, explanation: it.explanation };
    else if (it.type === 'flashcard') raw = { type: 'flashcard', front: it.front, back: it.back };
    else if (it.type === 'explain') raw = { type: 'explain', prompt: it.prompt, rubric: it.rubric, sampleAnswer: it.sample_answer }; // Phase 8
    else if (it.type === 'number_line') raw = { type: 'number_line', prompt: it.prompt, min: it.min, max: it.max, step: it.step, answer: it.target, tolerance: it.tolerance, unit: it.unit, explanation: it.explanation };
    else if (it.type === 'chart_select') raw = { type: 'chart_select', prompt: it.prompt, chart: it.chart || 'bar', title: it.chart_title, unit: it.unit, points: it.points, answer: it.correct_index, showValues: it.show_values !== false, explanation: it.explanation };
    else if (it.type === 'order_steps') raw = { type: 'order_steps', prompt: it.prompt, steps: it.steps, explanation: it.explanation };
    const n = raw && normalizePracticeItem({ ...raw, concept: it.concept });
    if (n) out.push(n);
  }
  return out;
}

export async function extractPracticeWithClaude(client, markdown) {
  const params = buildStructuredParams({
    system: PRACTICE_EXTRACT_PROMPT,
    schema: PRACTICE_EXTRACT_SCHEMA,
    user: `Lesson:\n\n${String(markdown).slice(0, 40000)}`,
    effort: 'low',
  });
  const data = await createStructured(client, params);
  const cards = (Array.isArray(data.cards) ? data.cards : [])
    .map((c) => ({ term: String(c.term || '').trim(), definition: String(c.definition || '').trim(), example: String(c.example || '').trim() }))
    .filter((c) => c.term && c.definition).slice(0, 6);
  const items = itemsFromStructured(data).slice(0, 12);
  if (items.length < 2 || cards.length < 1) throw new Error('Structured extraction returned too little usable material');
  return { title: lessonTitle(markdown), cards, items, source: 'claude' };
}

// ------------------------------------------------------------------ deterministic visual items
const NICE = [1, 2, 2.5, 5];
function niceGrid(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  for (let e = -3; e <= 9; e++) {
    for (const m of NICE) {
      const step = m * 10 ** e;
      const min = Math.floor(lo / step + 1e-9) * step;
      const max = Math.ceil(hi / step - 1e-9) * step;
      const n = Math.round((max - min) / step);
      if (n >= L.numberLine.minSteps && n <= L.numberLine.maxSteps) return { min: Number(min.toFixed(6)), max: Number(max.toFixed(6)), step };
    }
  }
  return null;
}
const plain = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
/** "Title: question" (or "Title? Question" when the title already asks something). */
const lead = (title, question) => (!title ? question[0].toUpperCase() + question.slice(1) : /[?!]$/.test(title) ? `${title} ${question[0].toUpperCase()}${question.slice(1)}` : `${title.replace(/[.:]+$/, '')}: ${question}`);
const stripNumbering = (s) => plain(s).replace(/^(?:step\s*)?\d+[.):]\s*/i, '');

/**
 * Visual practice items from the lesson's own widgets (fallback path):
 *   InputOutputSlider -> number_line  "which input gives this output?"
 *   BarChart          -> chart_select "which bar is described here?" (or the largest)
 *   Cycle / LessonStepper -> order_steps
 */
export function visualItemsFromComponents(markdown) {
  const out = [];
  const slider = componentsOf(markdown, 'InputOutputSlider').find((s) => Array.isArray(s.stops) && s.stops.filter((x) => Number.isFinite(Number(x.value))).length >= 3);
  if (slider) {
    const stops = slider.stops.filter((x) => Number.isFinite(Number(x.value)) && x.output).map((x) => ({ ...x, value: Number(x.value) }));
    const grid = stops.length >= 3 && niceGrid(stops.map((x) => x.value));
    const target = stops[Math.floor(stops.length / 2)];
    if (grid && target) {
      const gaps = stops.filter((x) => x !== target).map((x) => Math.abs(x.value - target.value));
      // half the gap to the nearest other stop, on the grid, so a neighbouring stop never passes
      const tolerance = Math.max(0, Math.floor((Math.min(...gaps) / 2) / grid.step - 1e-9) * grid.step);
      const label = plain(slider.inputLabel) || 'value';
      out.push({
        type: 'number_line', ...grid, answer: target.value, tolerance: Math.min(tolerance, (grid.max - grid.min) / 4), unit: plain(slider.unit),
        prompt: lead(plain(slider.title), `which ${label.toLowerCase()} gives “${plain(target.output)}”?`),
        explanation: plain(target.description) || `${plain(target.output)} at ${target.value}${plain(slider.unit)}.`,
        concept: label,
      });
    }
  }
  const chart = componentsOf(markdown, 'BarChart').find((b) => Array.isArray(b.bars) && b.bars.length >= 2 && b.bars.length <= L.chart.maxPoints);
  if (chart) {
    const bars = chart.bars.map((b) => ({ label: plain(b.label), value: Number(b.value), description: plain(b.description), highlighted: b.highlighted === true }));
    const described = bars.findIndex((b) => b.highlighted && b.description && b.label && !b.description.toLowerCase().includes(b.label.toLowerCase()));
    const max = bars.reduce((m, b, i) => (b.value > bars[m].value ? i : m), 0);
    const answer = described >= 0 ? described : max;
    const title = plain(chart.title);
    out.push({
      type: 'chart_select', chart: 'bar', title, unit: plain(chart.unit), points: bars.map(({ label, value }) => ({ label, value })), answer,
      prompt: described >= 0 ? `Which bar does this describe? “${bars[described].description}”` : `In “${title || 'this chart'}”, which bar is largest?`,
      explanation: bars[answer].description || `${bars[answer].label} has the largest value.`,
      concept: title.slice(0, 60) || bars[answer].label,
    });
  }
  const cycle = componentsOf(markdown, 'Cycle').find((c) => Array.isArray(c.stages) && c.stages.length >= L.order.minSteps && c.stages.length <= L.order.maxSteps);
  const stepper = componentsOf(markdown, 'LessonStepper').find((p) => Array.isArray(p.steps) && p.steps.length >= L.order.minSteps && p.steps.length <= L.order.maxSteps && p.steps.every((x) => x.label));
  if (cycle) {
    const steps = cycle.stages.map((x) => plain(x.label));
    out.push({ type: 'order_steps', steps, prompt: lead(plain(cycle.title), `put the stages in order, starting with “${steps[0]}”.`), explanation: `Then it starts over: “${steps[steps.length - 1]}” leads back to “${steps[0]}”.`, concept: plain(cycle.title) || steps[0] });
  } else if (stepper) {
    const steps = stepper.steps.map((x) => stripNumbering(x.label));
    out.push({ type: 'order_steps', steps, prompt: lead(plain(stepper.title), 'put the steps in order.'), explanation: '' /* the feedback already shows the order */, concept: plain(stepper.title) || steps[0] });
  }
  return out;
}
