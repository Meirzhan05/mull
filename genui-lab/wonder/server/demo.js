// Demo mode: pre-authored DIL lessons and tutor replies streamed through exactly the same
// compile + NDJSON pipeline as Claude output, chunked into 20-60 character pieces.

import fs from 'node:fs';
import path from 'node:path';
import { WONDER_ROOT } from './paths.js';
import { componentsOf, lessonTitle } from './practice.js';

const DEMO_DIR = path.join(WONDER_ROOT, 'server', 'demo');

export const DEMO_LESSONS = Object.freeze([
  { id: 'transformers', file: 'transformers.md', title: 'How transformers predict the next word', keywords: ['transformer', 'gpt', 'llm', 'language model', 'chatgpt', 'claude', 'ai', 'neural', 'attention', 'token', 'next word', 'machine learning', 'deep learning'] },
  { id: 'sky-blue', file: 'sky-blue.md', title: 'Why the sky is blue', keywords: ['sky', 'blue', 'light', 'rayleigh', 'sunset', 'scatter', 'color', 'colour', 'atmosphere', 'physics', 'optics', 'rainbow'] },
  { id: 'compound-interest', file: 'compound-interest.md', title: 'Compound interest', keywords: ['interest', 'compound', 'money', 'invest', 'saving', 'finance', 'debt', 'loan', 'bank', 'retire', 'rule of 72', 'stock'] },
]);

const cache = new Map();
export function readDemo(file) {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(DEMO_DIR, file), 'utf8'));
  return cache.get(file);
}

/** Best keyword match for a topic; `matched:false` when we had to pick a sample anyway. */
export function pickDemoLesson(topic) {
  const t = String(topic || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const d of DEMO_LESSONS) {
    const score = d.keywords.reduce((s, k) => {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return s + (new RegExp(k.length >= 5 ? `\\b${esc}` : `\\b${esc}\\b`, 'i').test(t) ? k.length : 0);
    }, 0) + (t.includes(d.title.toLowerCase()) ? 100 : 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  if (best) return { ...best, matched: true, markdown: readDemo(best.file) };
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const d = DEMO_LESSONS[h % DEMO_LESSONS.length];
  return { ...d, matched: false, markdown: readDemo(d.file) };
}

/** Deterministic PRNG (mulberry32) so demo chunking is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split text into 20-60 character chunks (like model token bursts). */
export function chunkText(text, { seed = 7, min = 20, max = 60 } = {}) {
  const rand = rng(seed);
  const out = [];
  let i = 0;
  while (i < text.length) {
    const n = min + Math.floor(rand() * (max - min + 1));
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

export async function streamDemoText(text, { onText, delayMs = 22, signal, seed } = {}) {
  for (const chunk of chunkText(text, { seed })) {
    if (signal?.aborted) return { aborted: true };
    onText(chunk);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { aborted: false };
}

// ---------------------------------------------------------------- tutor

const escapeJson = (v) => JSON.stringify(v);

function revealFromTerms(terms) {
  if (!terms.length) return '';
  const items = terms.slice(0, 4).map((k) => ({ label: `Can you define **${k.term}** without scrolling up?`, content: k.definition }));
  return `<Reveal title="Self-check: the key terms" items={${escapeJson(items)}}/>`;
}

function quizFromLesson(markdown) {
  const terms = componentsOf(markdown, 'KeyTerm');
  const unique = [];
  for (const k of terms) if (!unique.some((u) => u.term.toLowerCase() === k.term.toLowerCase())) unique.push(k);
  let questions = [];
  if (unique.length >= 3) {
    questions = unique.slice(0, 3).map((k, i) => {
      const distractors = unique.filter((u) => u !== k).slice(0, 2);
      const opts = [k, ...distractors];
      const rot = i % opts.length; // deterministic shuffle so the answer isn't always "a"
      const ordered = [...opts.slice(rot), ...opts.slice(0, rot)];
      const options = ordered.map((o, j) => ({ value: 'abc'[j], label: o.definition }));
      return {
        id: `t${i + 1}`,
        prompt: `Which description fits **${k.term}**?`,
        question_type: 'single_select',
        options,
        correct_values: [options[ordered.indexOf(k)].value],
        hint: 'Tap the term in the lesson if you need a reminder.',
        explanation: `${k.term}: ${k.definition}`,
      };
    });
  } else {
    const quiz = componentsOf(markdown, 'Quiz')[0];
    if (quiz) questions = quiz.questions.slice(0, 3).map((q, i) => ({ ...q, id: `r${i + 1}` }));
  }
  if (!questions.length) {
    questions = [{
      id: 'g1', prompt: 'Which study habit makes new knowledge stick best?', question_type: 'single_select',
      options: [{ value: 'a', label: 'Rereading the lesson several times in a row' }, { value: 'b', label: 'Testing yourself and reviewing again a few days later' }, { value: 'c', label: 'Highlighting the key sentences' }],
      correct_values: ['b'], hint: 'Think about the review deck.', explanation: 'Retrieval practice plus spaced repetition beats rereading and highlighting.',
    }];
  }
  return `<Quiz title="Tutor quiz" questions={${escapeJson(questions)}}/>`;
}

export function isQuizRequest(message) {
  return /\b(quiz|test me|question me|practice|check (me|my))\b/i.test(String(message || ''));
}

/** Build a demo tutor reply (markdown + DIL) grounded in the lesson the learner is reading. */
export function buildDemoTutorReply({ lessonContext, message }) {
  const markdown = String(lessonContext?.markdown || '');
  const title = String(lessonContext?.title || lessonTitle(markdown) || 'this lesson').replace(/[<>{}"\\]/g, '');
  if (isQuizRequest(message)) {
    const quiz = quizFromLesson(markdown);
    const count = (quiz.match(/"prompt"/g) || []).length;
    return readDemo('tutor-quiz.md').replaceAll('{{title}}', title).replaceAll('{{count}}', String(count)).replace('{{quiz}}', quiz);
  }
  const missed = explainMissedAnswer(markdown, message);
  if (missed) return missed;
  const terms = componentsOf(markdown, 'KeyTerm');
  return readDemo('tutor-explain.md').replaceAll('{{title}}', title).replace('{{reveal}}', revealFromTerms(terms));
}

/** "I answered X to Y but the answer is Z" (sent by the Quiz's "Explain this" button). */
function explainMissedAnswer(markdown, message) {
  const m = /I answered "([\s\S]+?)" to "([\s\S]+?)" but the answer is "([\s\S]+?)"/.exec(String(message || ''));
  if (!m) return null;
  const [, picked, prompt, answer] = m;
  const q = componentsOf(markdown, 'Quiz').flatMap((z) => z.questions).find((x) => x.prompt.trim() === prompt.trim());
  const safe = (s) => String(s).replace(/[<>{}]/g, '');
  const lines = [
    `You picked **${safe(picked)}**, but the answer is **${safe(answer)}**. That's a very common mix-up, so let's untangle it.`,
    '',
    q?.explanation ? safe(q.explanation) : 'Go back to the page this question came from and look for the one idea that decides it.',
  ];
  if (q?.hint) lines.push('', `<Callout title="A way to remember it" tone="tip">${safe(q.hint)}</Callout>`);
  const items = [{ label: `Why isn't "${safe(picked)}" right?`, content: `It sounds plausible, but it doesn't match what the lesson showed. The key point: ${safe(q?.explanation || answer)}` }];
  lines.push('', `<Reveal title="Check the reasoning" items={${JSON.stringify(items)}}/>`);
  lines.push('', '<Followups items={["Give me a similar question","Explain it with an analogy","Quiz me on this lesson"]}/>', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- course plan

export function demoCoursePlan(topic, level = 'beginner') {
  const pick = pickDemoLesson(topic);
  const name = String(topic || pick.title).trim().replace(/\s+/g, ' ').slice(0, 80);
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  if (pick.matched) {
    const plans = {
      transformers: [
        { title: 'How language models think', lessons: [{ title: 'How transformers predict the next word', summary: 'Explain tokens, attention and sampling in one picture.' }, { title: 'Training: learning from the whole internet', summary: 'Describe how next-word prediction becomes knowledge.' }] },
        { title: 'Using models well', lessons: [{ title: 'Prompts as instructions', summary: 'Write prompts that reliably get what you want.' }, { title: 'Why models make things up', summary: 'Explain hallucinations and how to check answers.' }] },
      ],
      'sky-blue': [
        { title: 'Light and color', lessons: [{ title: 'Why the sky is blue', summary: 'Explain Rayleigh scattering and red sunsets.' }, { title: 'Rainbows and refraction', summary: 'Explain how raindrops split white light.' }] },
        { title: 'Light in everyday life', lessons: [{ title: 'Why the ocean looks blue', summary: 'Separate reflection from absorption.' }, { title: 'How your eyes see color', summary: 'Describe cones and color mixing.' }] },
      ],
      'compound-interest': [
        { title: 'How money grows', lessons: [{ title: 'Compound interest', summary: 'Calculate compound growth and use the Rule of 72.' }, { title: 'Inflation: the silent tax', summary: 'Explain why money loses value over time.' }] },
        { title: 'Putting it to work', lessons: [{ title: 'Index funds in plain words', summary: 'Explain diversification and fees.' }, { title: 'Good debt, bad debt', summary: 'Compare interest rates on loans and cards.' }] },
      ],
    };
    return { title: cap, description: `A short ${level} course that starts with "${pick.title}".`, level, sections: plans[pick.id], demo: true };
  }
  return {
    title: cap,
    description: `A short ${level} course on ${name}. (Demo mode: lessons stream sample content.)`,
    level,
    demo: true,
    sections: [
      { title: 'Foundations', lessons: [{ title: `What is ${name}?`, summary: `Describe ${name} in your own words.` }, { title: `The key ideas behind ${name}`, summary: 'Name the three ideas everything else builds on.' }] },
      { title: 'Going deeper', lessons: [{ title: `${cap} in the real world`, summary: 'Spot it in everyday examples.' }, { title: 'Common misconceptions', summary: 'Explain what people usually get wrong.' }] },
    ],
  };
}
