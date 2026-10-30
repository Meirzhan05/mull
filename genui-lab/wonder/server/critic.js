// Phase 7: lesson quality. Two layers:
//
//   lintLesson(markdown)   deterministic checks of the lesson against the prompt's own format
//                          rules (pages, a visual per page, one tagged 3-question Quiz, ...).
//   critiqueLesson(...)    a second Claude call (structured output) that reviews the finished
//                          lesson: answer keys, facts and arithmetic, cited claims vs. the cited
//                          text, level fit, widget sense. It returns issues plus machine-
//                          applicable Quiz fixes, which applyQuizFixes() writes into the Quiz
//                          props (validated with the catalog schema before they are accepted).
//
// /api/lesson/stream runs both after a lesson finishes (the lint alone for a refused or
// truncated one) and sends the result as a `quality-report` control record; fixes arrive as one
// `replace` record.

import { scanComponentTags, preprocess } from './compile.js';
import { tryParseExpression } from './lenient-json.js';
import { validateComponentProps } from './catalog-schema.js';
import { buildStructuredParams, createStructured } from './claude.js';
import { stripGroundingTags } from './grounding.js';

// Figure and Video are not here: they render nothing when no image / clip is found, so neither can be a page's only visual.
const VISUALS = new Set(['LessonStepper', 'Reveal', 'CompareToggle', 'InputOutputSlider', 'Flowchart', 'Timeline', 'BarChart', 'ConceptMap', 'Cycle', 'Quiz', 'Flashcards', 'FunctionGraph', 'ExplainBack', 'Diagram']);
const LAYOUT_RE = /<(box|col|row|grid)\b/;
const FINISHED = { partial: false }; // the critic reads whole lessons: a tag that never closed is broken, not streaming
const CHECK_PAGE_RE = /check your understanding/i;
const words = (s) => (String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

/** Split a lesson into its title, hook and "## " pages (fence-unaware is fine for lessons). */
export function lessonParts(markdown) {
  const md = String(markdown || '');
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() || '';
  const heads = [...md.matchAll(/^##\s+(.+)$/gm)];
  const hookStart = title ? md.indexOf('\n', md.search(/^#\s+/m)) + 1 : 0;
  const hook = md.slice(Math.max(0, hookStart), heads[0]?.index ?? md.length);
  const pages = heads.map((h, i) => ({ heading: h[1].trim(), body: md.slice(h.index + h[0].length, heads[i + 1]?.index ?? md.length) }));
  return { title, hook, pages };
}

/** Prose of a page with every tag (and its JSON props) removed, for word counts. */
function proseOf(body) {
  let out = '';
  let pos = 0;
  for (const t of scanComponentTags(body, FINISHED)) {
    out += body.slice(pos, t.start);
    const term = t.kind === 'open' && t.name === 'KeyTerm' ? t.attrs.find(([k]) => k === 'term')?.[1] : null;
    if (term?.kind === 'string') out += term.value; // an inline KeyTerm reads as its word
    pos = t.end;
  }
  out += body.slice(pos);
  return out.replace(/<\/?[a-z][^>]*>/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ');
}

/**
 * Deterministic format checks. Returns {score 0..1, passed, total, checks:[{id, ok, detail}], stats}.
 * The rules mirror LESSON_SYSTEM_PROMPT; bounds are a little looser than the prompt asks.
 */
export function lintLesson(markdown) {
  const md = stripGroundingTags(String(markdown || ''));
  const { title, hook, pages } = lessonParts(md);
  const check = pages.length && CHECK_PAGE_RE.test(pages[pages.length - 1].heading) ? pages[pages.length - 1] : null;
  const content = check ? pages.slice(0, -1) : pages;
  const comps = preprocess(md, FINISHED).components;
  const valid = comps.filter((c) => c.status === 'valid');
  const quizzes = valid.filter((c) => c.name === 'Quiz');
  const terms = new Set(valid.filter((c) => c.name === 'KeyTerm').map((c) => String(c.props.term).toLowerCase()));
  // a tag that never closed (unbalanced braces in its props) is invalid too: BROKEN_TAG_ERROR
  const invalid = comps.filter((c) => c.status === 'invalid');
  const visualsPerPage = content.map((p) => scanComponentTags(p.body, FINISHED).filter((t) => t.kind === 'open' && VISUALS.has(t.name)).length + (LAYOUT_RE.test(p.body) ? 1 : 0));
  const pageWords = content.map((p) => words(proseOf(p.body)));
  const quizOnCheck = check ? scanComponentTags(check.body, FINISHED).filter((t) => t.kind === 'open' && t.name === 'Quiz').length : 0;
  const questions = quizzes.flatMap((q) => q.props.questions || []);
  const checks = [
    { id: 'title', ok: !!title, detail: title ? `"${title}"` : 'no "# " title' },
    { id: 'hook', ok: words(proseOf(hook)) >= 20, detail: `${words(proseOf(hook))} words before the first page` },
    { id: 'pages', ok: content.length >= 3 && content.length <= 4, detail: `${content.length} content pages (want 3-4)` },
    { id: 'visual_per_page', ok: content.length > 0 && visualsPerPage.every((n) => n >= 1), detail: `visuals per page: ${visualsPerPage.join(', ') || 'none'}` },
    { id: 'page_length', ok: content.length > 0 && pageWords.every((n) => n >= 60 && n <= 260), detail: `prose words per page: ${pageWords.join(', ') || 'none'} (want ~90-170)` },
    { id: 'check_page', ok: !!check && quizOnCheck === 1 && quizzes.length === 1, detail: check ? `${quizOnCheck} Quiz on the check page, ${quizzes.length} in total` : 'no "Check your understanding" page' },
    { id: 'quiz_questions', ok: quizzes.length === 1 && questions.length === 3, detail: `${questions.length} quiz questions (want 3)` },
    { id: 'quiz_concepts', ok: questions.length > 0 && questions.every((q) => q.concept), detail: `${questions.filter((q) => q.concept).length}/${questions.length} questions tagged with a concept` },
    { id: 'key_terms', ok: terms.size >= 2 && terms.size <= 5, detail: `${terms.size} distinct KeyTerms (want 2-5)` },
    { id: 'explain_back', ok: valid.filter((c) => c.name === 'ExplainBack').length === 1, detail: `${valid.filter((c) => c.name === 'ExplainBack').length} ExplainBack (want 1, on the last content page)` },
    { id: 'worked_example', ok: valid.some((c) => c.name === 'LessonStepper'), detail: valid.some((c) => c.name === 'LessonStepper') ? 'has a LessonStepper' : 'no LessonStepper worked example' },
    { id: 'valid_components', ok: invalid.length === 0, detail: invalid.length ? `${invalid.length} invalid component(s) replaced by text: ${invalid.map(invalidLabel).join('; ')}` : 'all components valid' },
  ];
  const passed = checks.filter((c) => c.ok).length;
  return {
    score: Math.round((passed / checks.length) * 100) / 100,
    passed,
    total: checks.length,
    checks,
    stats: { title, pages: content.length, visualsPerPage, pageWords, quizzes: quizzes.length, questions: questions.length, keyTerms: terms.size, components: valid.length, media: mediaCounts(comps) },
  };
}

const invalidLabel = (c) => `${c.name} (${clip(c.error, 120)})`;
const MEDIA = ['Diagram', 'Figure'];
/** {Diagram: {valid, invalid}, Figure: {valid, invalid}} from compileWonder(...).components. */
function mediaCounts(comps) {
  const out = {};
  for (const name of MEDIA) {
    const mine = comps.filter((c) => c.name === name);
    out[name] = { valid: mine.filter((c) => c.status === 'valid').length, invalid: mine.filter((c) => c.status !== 'valid').length };
  }
  return out;
}

/**
 * Per-component media details of a finished lesson, in document order: every <Diagram> and
 * <Figure> with its status ('valid' | 'invalid'), the validator's error, and a short
 * summary of its props. The eval harness joins Figures with the server's image lookup results.
 */
export function lessonMedia(markdown) {
  const comps = preprocess(stripGroundingTags(String(markdown || '')), FINISHED).components;
  const out = { diagrams: [], figures: [] };
  for (const c of comps) {
    if (!MEDIA.includes(c.name)) continue;
    const { status } = c;
    const base = { status, ...(c.error ? { error: clip(c.error, 200) } : {}) };
    const p = c.props || {};
    if (c.name === 'Diagram') out.diagrams.push({ ...base, ...(status === 'valid' ? { title: p.title || '', shapes: p.shapes.length, parts: p.parts?.length || 0, steps: p.steps?.length || 0 } : {}) });
    else out.figures.push({ ...base, ...(status === 'valid' ? { query: p.query || '', ...(p.file ? { file: p.file } : {}), caption: p.caption || '', question: !!p.question } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- critic (Claude)

export const CRITIC_SYSTEM_PROMPT = `
You are the quality reviewer for Mull, an app whose lessons are written by an AI model. You receive one finished lesson: markdown with inline UI tags whose props are JSON (for example <Quiz questions={[...]}/>), the learner level, and the web sources the lesson cites (<Cite refs={["turn0search1"]}/> marks a cited claim).

Check, in this order:
1. Quiz answer keys. For every Quiz question, work out the answer yourself before looking at correct_values. Exactly one option must be right; the explanation must agree with the key. If the key or explanation is wrong, add a quizFix with the right option value(s) and a corrected one- or two-sentence explanation.
2. Facts and arithmetic. Recompute every number in worked examples, sliders, bar charts and steppers. Flag claims that are false or misleading.
3. Citations. A cited claim must be supported by the cited source text shown to you. Flag claims that go beyond it.
4. Level fit: jargon without explanation for a beginner, or oversimplification for an advanced learner.
5. Widgets that do not make sense (a flowchart out of order, a timeline with wrong dates, a slider whose outputs do not follow from its inputs).
6. Diagrams and figures. Their text is listed again after the lesson, under "Diagram and figure text". Check it like the prose:
   - <Diagram>: the title, caption and labels, every part's text, and every step's label and text. A false or misleading claim is "factual". A label on the wrong part, steps in the wrong order, or a step that describes something its shapes do not show is "widget".
   - <Figure>: a real image found by a search for its query; you cannot see it, so judge only the text. A false claim in the caption or alt text, or a wrong answer to its question, is "factual". A question its answer does not answer, or text that does not fit the query's subject, is "widget".

Report only real problems that would mislead or confuse a learner; do not nitpick style. Most good lessons have zero or one issue. Pages are numbered from 1 in order of their "## " headings. Use page 0 for the hook or the whole lesson.
`.trim();

export const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues', 'quizFixes'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'minor_issues', 'major_issues'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'kind', 'page', 'problem', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['minor', 'major'] },
          kind: { type: 'string', enum: ['quiz_key', 'factual', 'math', 'citation', 'level', 'widget', 'clarity'] },
          page: { type: 'integer' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    quizFixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question_id', 'correct_values', 'explanation'],
        properties: { question_id: { type: 'string' }, correct_values: { type: 'array', items: { type: 'string' } }, explanation: { type: 'string' } },
      },
    },
  },
};

const ISSUE_KINDS = CRITIC_SCHEMA.properties.issues.items.properties.kind.enum;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The text a learner reads in each valid <Diagram> and <Figure>, by page, for the critic:
 * the props are long JSON (a Diagram's shapes are mostly coordinates), so the words are listed
 * on their own. '' when the lesson has none.
 */
export function mediaDigest(markdown) {
  const { hook, pages } = lessonParts(String(markdown || ''));
  const lines = [];
  [hook, ...pages.map((p) => p.body)].forEach((body, page) => {
    for (const c of preprocess(body, FINISHED).components) {
      if (c.status !== 'valid' || !MEDIA.includes(c.name)) continue;
      const p = c.props;
      const out = [];
      const add = (label, v) => { if (v) out.push(`  ${label}: ${clip(v, 420)}`); };
      if (c.name === 'Diagram') {
        add('title', p.title);
        add('labels', p.shapes.filter((x) => x.type === 'text').map((x) => x.text).join(' · '));
        for (const part of p.parts || []) add(`part "${part.label}"`, part.text);
        (p.steps || []).forEach((st, i) => add(`step ${i + 1}${st.label ? ` "${st.label}"` : ''}`, st.text || '(no text)'));
        add('caption', p.caption);
      } else {
        add('query', p.query);
        add('caption', p.caption);
        add('alt', p.alt !== p.caption ? p.alt : '');
        add('question', p.question);
        add('answer', p.answer);
      }
      lines.push(`- Page ${page}, ${c.name}:`, ...out);
    }
  });
  return lines.join('\n');
}

/** The critic's user message: level, lesson, its diagram and figure text, and the cited sources' text. */
export function criticUserMessage({ markdown, topic, level, sources = [] }) {
  const parts = [`Topic: ${clip(topic, 300) || '(not given)'}`, `Learner level: ${level || 'beginner'}`, '', '<lesson>', String(markdown || '').slice(0, 60000), '</lesson>'];
  const media = mediaDigest(markdown);
  if (media) parts.push('', 'Diagram and figure text (page: component):', media);
  if (sources.length) {
    parts.push('', 'Cited sources (ref: title, url, cited text):');
    for (const s of sources.slice(0, 30)) parts.push(`- ${s.ref}: ${clip(s.title, 160)} (${s.url})${s.snippet ? `\n  "${clip(s.snippet, 300)}"` : ''}`);
  }
  return parts.join('\n');
}

/** Clean a critic response (structured output is schema-valid; this bounds sizes and values). */
export function normalizeCritique(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    verdict: ['pass', 'minor_issues', 'major_issues'].includes(r.verdict) ? r.verdict : 'pass',
    summary: clip(r.summary, 400),
    issues: (Array.isArray(r.issues) ? r.issues : []).slice(0, 12).map((i) => ({
      severity: i?.severity === 'major' ? 'major' : 'minor',
      kind: ISSUE_KINDS.includes(i?.kind) ? i.kind : 'clarity',
      page: Number.isInteger(i?.page) && i.page >= 0 ? i.page : 0,
      problem: clip(i?.problem, 400),
      suggestion: clip(i?.suggestion, 400),
    })).filter((i) => i.problem),
    quizFixes: (Array.isArray(r.quizFixes) ? r.quizFixes : []).slice(0, 10).map((f) => ({
      question_id: clip(f?.question_id, 40),
      correct_values: (Array.isArray(f?.correct_values) ? f.correct_values : []).map((v) => clip(v, 40)).filter(Boolean).slice(0, 6),
      explanation: clip(f?.explanation, 500),
    })).filter((f) => f.question_id && f.correct_values.length),
  };
}

/** Keep citation refs readable for the critic: <Cite refs={["turn0search1"]}/> -> " [turn0search1]". */
export function citesAsText(md) {
  return String(md ?? '')
    .replace(/<Cite\s+refs=\{([^{}]*)\}\s*\/>/g, (_, list) => { const r = tryParseExpression(list); return Array.isArray(r.value) ? ` [${r.value.join(', ')}]` : ''; })
    .replace(/\n*<Sources\s*\/>\n*/g, '\n');
}

export const CRITIC_TIMEOUT_MS = Number(process.env.WONDER_CRITIC_TIMEOUT_MS) || 120_000;

/** One structured critic call. Throws on API errors; the caller treats any failure as "not checked". */
export async function critiqueLesson(client, { markdown, topic, level, sources, effort = 'medium', timeoutMs = CRITIC_TIMEOUT_MS, signal, model }) {
  const params = buildStructuredParams({ system: CRITIC_SYSTEM_PROMPT, schema: CRITIC_SCHEMA, user: criticUserMessage({ markdown: citesAsText(markdown), topic, level, sources }), effort, model });
  let timer;
  let onAbort;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('critic timed out'), { code: 'timeout' })), timeoutMs);
    timer.unref?.();
    onAbort = () => reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return normalizeCritique(await Promise.race([createStructured(client, params, { task: 'critic' }), stop]));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

// ---------------------------------------------------------------- applying quiz fixes

const attrString = (k, v) => (typeof v === 'string' && !/["{}<>\n]/.test(v) ? `${k}="${v}"` : `${k}={${JSON.stringify(v)}}`);

/**
 * Apply critic quizFixes to every Quiz in the markdown. A fix changes one question's
 * correct_values (and explanation); it is kept only when the rewritten Quiz still validates.
 * Returns {markdown, applied:[{question_id, from, to}], rejected:[{question_id, reason}]}.
 */
export function applyQuizFixes(markdown, fixes) {
  const src = String(markdown || '');
  const byId = new Map((fixes || []).map((f) => [f.question_id, f]));
  const applied = [];
  const rejected = [];
  if (!byId.size) return { markdown: src, applied, rejected };
  let out = '';
  let pos = 0;
  for (const tag of scanComponentTags(src)) {
    if (tag.kind !== 'open' || tag.name !== 'Quiz') continue;
    const props = {};
    let parsed = true;
    for (const [k, v] of tag.attrs) {
      if (v.kind === 'string') props[k] = v.value;
      else if (v.kind === 'bool') props[k] = true;
      else { const r = tryParseExpression(v.source); if (r.ok) props[k] = r.value; else parsed = false; }
    }
    if (!parsed || !Array.isArray(props.questions)) continue;
    let changed = false;
    const questions = props.questions.map((q, i) => {
      const id = String(q?.id || `q${i + 1}`);
      const fix = byId.get(id);
      if (!fix) return q;
      const before = validateComponentProps('Quiz', { questions: [q] });
      const next = { ...q, correct_values: fix.correct_values, ...(fix.explanation ? { explanation: fix.explanation } : {}) };
      const after = validateComponentProps('Quiz', { questions: [next] });
      if (!after.ok) { rejected.push({ question_id: id, reason: after.error }); return q; }
      const from = before.ok ? before.props.questions[0].correct_values : [];
      const to = after.props.questions[0].correct_values;
      if (JSON.stringify(from) === JSON.stringify(to) && !fix.explanation) return q;
      applied.push({ question_id: id, from, to });
      changed = true;
      return { ...next, correct_values: to };
    });
    if (!changed) continue;
    const rebuilt = { ...props, questions };
    if (!validateComponentProps('Quiz', rebuilt).ok) { rejected.push({ question_id: '*', reason: 'rewritten Quiz did not validate' }); continue; }
    const attrs = tag.attrs.map(([k]) => attrString(k, rebuilt[k])).join(' ');
    out += src.slice(pos, tag.start) + `<Quiz ${attrs}${tag.selfClosing ? '/>' : '>'}`;
    pos = tag.end;
  }
  for (const id of byId.keys()) if (!applied.some((a) => a.question_id === id) && !rejected.some((r) => r.question_id === id)) rejected.push({ question_id: id, reason: 'no such question' });
  return { markdown: out + src.slice(pos), applied, rejected };
}

/** The report sent to the client (control `quality-report`) and kept with the lesson. */
export function qualityReport({ lint, critique = null, applied = [], checked = false, error = null }) {
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    lint: { score: lint.score, passed: lint.passed, total: lint.total, failed: lint.checks.filter((c) => !c.ok).map(({ id, detail }) => ({ id, detail })) },
    critic: checked ? { verdict: critique.verdict, summary: critique.summary, issues: critique.issues, fixed: applied } : { skipped: true, ...(error ? { reason: error } : {}) },
  };
}
