// /api/practice/extract: finished lesson -> knowledge cards + practice items.
// Claude path: one structured-output call (effort low). Demo/fallback path: deterministic
// extraction from the lesson's own <KeyTerm> and <Quiz> components.

import { preprocess } from './compile.js';
import { normalizePracticeItem } from '../public/practice-core.js';
import { buildStructuredParams, createStructured } from './claude.js';
import { EXTRACT_SYSTEM_PROMPT, EXTRACT_SCHEMA } from './prompts.js';

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
  terms.slice(0, 4).forEach((k) => {
    raw.push({ type: 'cloze', prompt: `____: ${k.definition}`, answer: k.term, acceptableAnswers: k.term.endsWith('s') ? [k.term.slice(0, -1)] : [], explanation: `${k.term} means ${lowerFirst(k.definition)}`, concept: k.term });
  });
  if (terms.length >= 2) {
    const [a, b] = terms;
    raw.push({ type: 'binary_choice', prompt: `"${a.term}" means: ${lowerFirst(b.definition)}`, answer: false, explanation: `That describes ${b.term}. ${a.term} means ${lowerFirst(a.definition)}`, concept: a.term });
  }
  terms.slice(0, 3).forEach((k) => raw.push({ type: 'flashcard', front: `What does "${k.term}" mean?`, back: k.definition, concept: k.term }));
  for (const e of componentsOf(markdown, 'ExplainBack').slice(0, 1)) raw.push({ type: 'explain', prompt: e.prompt, rubric: e.rubric, sampleAnswer: e.sampleAnswer, concept: e.concept }); // Phase 8
  const items = raw.map(normalizePracticeItem).filter(Boolean).slice(0, 12);
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
    const n = raw && normalizePracticeItem({ ...raw, concept: it.concept });
    if (n) out.push(n);
  }
  return out;
}

export async function extractPracticeWithClaude(client, markdown) {
  const params = buildStructuredParams({
    system: EXTRACT_SYSTEM_PROMPT,
    schema: EXTRACT_SCHEMA,
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
