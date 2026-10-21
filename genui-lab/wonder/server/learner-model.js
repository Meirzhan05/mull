// Phase 6: the learner model on the server side. The model itself lives in the browser
// (public/mastery-core.js); each lesson / tutor / Teacher request carries a compact summary
// ({shaky, fading, learning, mastered}) that is untrusted input, so it is bounded and cleaned
// here before it becomes a system context block (placed after the cache breakpoint).

import { cleanConcept } from '../public/mastery-core.js';

const STATUSES = ['shaky', 'fading', 'learning', 'mastered'];
const PER_STATUS = 8;

/** Bound and clean a client-sent mastery summary. Returns null when it holds nothing. */
export function sanitizeMastery(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let n = 0;
  for (const s of STATUSES) {
    out[s] = (Array.isArray(raw[s]) ? raw[s] : []).slice(0, PER_STATUS).map((c) => {
      const concept = cleanConcept(c?.concept);
      const m = Number(c?.mastery);
      if (!concept || !Number.isFinite(m)) return null;
      const topic = cleanConcept(c?.topic);
      return { concept, mastery: Math.round(Math.min(1, Math.max(0, m)) * 100) / 100, ...(topic ? { topic } : {}) };
    }).filter(Boolean);
    n += out[s].length;
  }
  return n ? out : null;
}

const pct = (m) => `${Math.round(m * 100)}%`;
const line = (label, list) => (list.length ? `- ${label}: ${list.map((c) => `${c.concept} (${pct(c.mastery)})`).join('; ')}` : '');

/** "What this learner knows" block, or '' when there is no summary. */
export function masteryPromptBlock(summary) {
  const s = sanitizeMastery(summary);
  if (!s) return '';
  const lines = [
    line('Shaky (got these wrong recently)', s.shaky),
    line('Fading (known once, not practiced lately)', s.fading),
    line('Still learning', s.learning),
    line('Mastered', s.mastered),
  ].filter(Boolean);
  return `What this learner knows, estimated from their graded quiz, review and free-response answers (percent = estimated mastery):\n${lines.join('\n')}`;
}

/** Per-surface instruction appended after the mastery block. */
export const MASTERY_USE = Object.freeze({
  lesson: 'Use this to adapt the lesson: when a shaky or fading concept is a prerequisite for this topic, give it a one- or two-sentence recap where it is needed; do not re-teach mastered concepts at length (a quick reference is enough). Keep the lesson about the requested topic. Tag every Quiz question with the "concept" it tests.',
  tutor: 'When the learner\'s question touches a shaky or fading concept, address that gap directly and check it with a quick question. Tag every Quiz question with the "concept" it tests.',
  teacher: 'Prefer shaky and fading concepts when you quiz the learner or plan reviews; mention mastered ones only as encouragement. Tag every quiz_me question with the "concept" it tests.',
});

/** Mastery block plus the surface's instruction, or '' without a summary. */
export function masteryContext(summary, surface) {
  const block = masteryPromptBlock(summary);
  return block ? `${block}\n${MASTERY_USE[surface] || ''}`.trim() : '';
}
