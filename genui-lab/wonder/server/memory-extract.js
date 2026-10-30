// Post-lesson memory extraction (Wondering's `extract-learner-memory`, findings §5):
// lesson title + quiz results + the learner's tutor questions -> 0-3 new durable facts.
// Claude path: one structured-output call (effort low). Fallback: a deterministic rule
// on the quiz score. New facts are de-duplicated against the store before they are saved.

import { buildStructuredParams, createStructured } from './claude.js';
import { MEMORY_EXTRACT_SYSTEM_PROMPT, MEMORY_EXTRACT_SCHEMA } from './prompts.js';
import { MEMORY_KINDS, cleanFact, isDuplicateFact } from './memory.js';

const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Normalize the request body: {lessonTitle, quizResults:[{prompt, correct}], tutorThread:[string|{role,content}]}. */
export function normalizeExtractInput(body = {}) {
  const lessonTitle = line(body.lessonTitle, 200) || 'Untitled lesson';
  const quizResults = (Array.isArray(body.quizResults) ? body.quizResults : []).slice(0, 12)
    .map((q) => ({ prompt: line(q?.prompt, 300), correct: !!q?.correct }))
    .filter((q) => q.prompt);
  const tutorThread = (Array.isArray(body.tutorThread) ? body.tutorThread : []).slice(-10)
    .map((m) => (typeof m === 'string' ? m : m?.role === 'user' ? m.content : ''))
    .map((m) => line(m, 500))
    .filter(Boolean);
  return { lessonTitle, quizResults, tutorThread };
}

export function extractMemoryDeterministic({ lessonTitle, quizResults }) {
  if (!quizResults.length) return [];
  const missed = quizResults.filter((q) => !q.correct);
  if (missed.length / quizResults.length < 0.34) return [];
  return [{ fact: `Found "${lessonTitle}" tricky (missed ${missed.length} of ${quizResults.length} quiz questions).`, kind: 'struggle' }];
}

export async function extractMemoryWithClaude(client, { lessonTitle, quizResults, tutorThread }, existing = [], { model } = {}) {
  const user = [
    `Lesson: ${lessonTitle}`,
    '',
    'Quiz results:',
    ...(quizResults.length ? quizResults.map((q) => `- ${q.correct ? 'correct' : 'WRONG'}: ${q.prompt}`) : ['- (no quiz answers)']),
    '',
    'Questions the learner asked the tutor:',
    ...(tutorThread.length ? tutorThread.map((m) => `- ${m}`) : ['- (none)']),
    '',
    'Already in memory (do not repeat):',
    ...(existing.length ? existing.slice(0, 30).map((i) => `- [${i.kind}] ${i.fact}`) : ['- (empty)']),
  ].join('\n');
  const data = await createStructured(client, buildStructuredParams({ system: MEMORY_EXTRACT_SYSTEM_PROMPT, schema: MEMORY_EXTRACT_SCHEMA, user, effort: 'low', maxTokens: 4000, model }), { task: 'extract' });
  return Array.isArray(data?.facts) ? data.facts : [];
}

/** Validate, cap to 3 and drop facts already in memory (or repeated within the batch). */
export function filterNewFacts(facts, existing) {
  const out = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    const fact = cleanFact(f?.fact);
    if (!fact || !MEMORY_KINDS.includes(f?.kind)) continue;
    if (existing.some((i) => isDuplicateFact(i.fact, fact)) || out.some((o) => isDuplicateFact(o.fact, fact))) continue;
    out.push({ fact, kind: f.kind });
    if (out.length >= 3) break;
  }
  return out;
}
