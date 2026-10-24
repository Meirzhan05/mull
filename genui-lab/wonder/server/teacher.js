// Teacher agent: Wondering's `teacher-chat` (findings §2.3) rebuilt on ChatGPT's server-resolved
// DIL components (chatgpt-findings §3.4, §8.2).
//
// Claude runs a manual streaming tool loop. Text deltas stream as markdown + DIL exactly like
// the tutor. Each tool call is executed on the server and its result becomes a *resolved
// catalog component*: the server assigns a resolution id, stores
// {status:"resolved", state} in the turn's appData.opGenui.componentResults, and splices
// <TeacherCard kind="…" __resolutionId="…"/> into the markdown at the point of the call
// (quiz_me splices a normal <Quiz/>). Wondering's tool_start/tool_result SSE events become
// `reasoning` records ("Drafting a study plan…") plus the spliced card. Card buttons dispatch
// widget actions (teacher_accept / teacher_dismiss / teacher_undo / teacher_open_item, the
// resolve_action / undo_action analogue) that return updated componentResults.

import { randomUUID } from 'node:crypto';
import { Anthropic } from './claude.js';
import { validateComponentProps } from './catalog-schema.js';
import { MEMORY_KINDS, cleanFact } from './memory.js';
import { sanitizeMastery } from './learner-model.js';
import { cleanDateKey, planDayBounds, dateDays, localKey, daysBetween } from '../public/plan-core.js'; // Phase 10

export const MAX_TEACHER_ITERATIONS = 6;
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const ITEM_KINDS = ['lesson', 'review', 'quiz'];
const S = (description) => ({ type: 'string', description });

// ---------------------------------------------------------------- tool definitions

/**
 * Client tools. All strict (schema-valid arguments), additionalProperties:false, and
 * eager_input_streaming (the request is streamed, so inputs arrive unbuffered and are
 * validated here before anything runs). Static, so the cached prefix (tools + system) is stable.
 */
export const TEACHER_TOOLS = Object.freeze([
  {
    name: 'create_lesson',
    description: 'Propose one Wonder lesson to the learner. Shows an approval card with Start / Not now; the lesson is only generated if they tap Start. Call this when the learner wants to learn something now, or to kick off the first lesson of a plan.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['topic', 'level', 'reason'],
      properties: {
        topic: S('Specific lesson topic, e.g. "Mean, median and mode"'),
        level: { type: 'string', enum: LEVELS, description: 'Learner level for this lesson' },
        reason: S('One sentence, addressed to the learner, on why this lesson is the right next step'),
      },
    },
  },
  {
    name: 'plan_study',
    description: 'Create a dated study plan for a goal, starting today: 3-7 days, or with a deadline, as many days as fit up to and including the deadline (at most 7). Shows a plan card with one row per calendar day and an Open button per item, plus Save plan. Call this when the learner states a goal with a time frame or asks for a plan. Call get_progress first if you have not yet (it has today\'s date).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'deadline', 'days'],
      properties: {
        goal: S('The goal in the learner\'s words, short'),
        deadline: S('The date the goal is due as YYYY-MM-DD (an exam, interview, trip) when the learner gave one, else ""'),
        days: {
          type: 'array',
          description: '3-7 days in order',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['day', 'focus', 'items'],
            properties: {
              day: { type: 'integer', description: 'Day number starting at 1' },
              focus: S('What this day is about, a few words'),
              items: {
                type: 'array',
                description: '1-3 activities',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'title'],
                  properties: {
                    kind: { type: 'string', enum: ITEM_KINDS },
                    title: S('Short activity title'),
                    topic: S('For lesson and quiz items: the specific topic to teach or quiz'),
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'quiz_me',
    description: 'Show the learner an interactive multiple-choice quiz (2-4 questions) with hints, feedback and explanations. Call this when they ask to be quizzed or to check their understanding of something they studied.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['topic', 'questions'],
      properties: {
        topic: S('What the quiz covers'),
        questions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'prompt', 'question_type', 'options', 'correct_values', 'hint', 'explanation', 'concept'],
            properties: {
              id: S('q1, q2, ...'),
              concept: S('The one concept this question tests, 1-4 words, e.g. "Standard deviation" (tracked in the learner model)'),
              prompt: S('The question'),
              question_type: { type: 'string', enum: ['single_select', 'true_false'] },
              options: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['value', 'label'], properties: { value: S('a, b, c, d (or true/false)'), label: S('Option text') } },
              },
              correct_values: { type: 'array', items: { type: 'string' }, description: 'Exactly one option value' },
              hint: S('A nudge that does not give the answer away'),
              explanation: S('Why the answer is right, one or two sentences'),
            },
          },
        },
      },
    },
  },
  {
    name: 'remember',
    description: 'Save one durable fact about the learner to their memory so future lessons, tutor replies and plans are personalized. Shows a small "Remembered" chip with Undo. Call this when the learner tells you a goal, preference, struggle or background that will matter later.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['fact', 'kind'],
      properties: {
        fact: S('One short third-person sentence, e.g. "Knows basic algebra." (max 200 characters)'),
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
      },
    },
  },
  {
    name: 'forget',
    description: 'Remove one item from the learner\'s memory by id (ids are listed in the learner memory context). Call this when they ask you to forget something or a fact is no longer true.',
    input_schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: S('Memory item id, e.g. mem-1a2b3c4d') } },
  },
  {
    name: 'get_progress',
    description: 'Read the learner\'s progress: review deck size and due cards, streak, XP, recent lessons (with quiz scores), courses (cards due, mean memory %, and reviewSuggested when the learner should review the whole course at once, mixed), saved study plans, memory items and per-concept mastery (shaky / fading / learning / mastered, estimated from graded answers). Call this before planning, or when they ask how they are doing or what to study next.',
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
].map((t) => ({ ...t, strict: true, eager_input_streaming: true })));

export const TOOL_LABELS = Object.freeze({
  create_lesson: 'Preparing a lesson suggestion…',
  plan_study: 'Drafting a study plan…',
  quiz_me: 'Writing quiz questions…',
  remember: 'Saving that to memory…',
  forget: 'Updating memory…',
  get_progress: 'Checking your progress…',
});

// ---------------------------------------------------------------- input validation

/** Minimal JSON-Schema check for the subset the tools use. Returns a list of errors. */
export function schemaErrors(schema, value, at = 'input') {
  const errs = [];
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at} must be an object`];
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}.${k} is required`);
    for (const k of Object.keys(value)) {
      if (!schema.properties?.[k]) { if (schema.additionalProperties === false) errs.push(`${at}.${k} is not allowed`); continue; }
      errs.push(...schemaErrors(schema.properties[k], value[k], `${at}.${k}`));
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${at} must be an array`];
    value.forEach((v, i) => errs.push(...schemaErrors(schema.items, v, `${at}[${i}]`)));
  } else if (t === 'string') {
    if (typeof value !== 'string') return [`${at} must be a string`];
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of ${schema.enum.join(', ')}`);
  } else if (t === 'integer') {
    if (!Number.isInteger(value)) errs.push(`${at} must be an integer`);
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') errs.push(`${at} must be a boolean`);
  }
  return errs.slice(0, 8);
}

const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Validate a parsed tool input (schema + semantic bounds). Eager input streaming means the
 * API did not validate it, and the SDK's tolerant parser can return a silently truncated
 * object, so nothing runs before this passes.
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateToolInput(name, input) {
  const tool = TEACHER_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool ${name}` };
  const errs = schemaErrors(tool.input_schema, input);
  if (errs.length) return { ok: false, error: errs.join('; ') };
  switch (name) {
    case 'create_lesson': {
      const topic = oneLine(input.topic, 200);
      if (!topic) return { ok: false, error: 'topic must not be empty' };
      return { ok: true, value: { topic, level: input.level, reason: oneLine(input.reason, 300) } };
    }
    case 'plan_study': {
      const goal = oneLine(input.goal, 200);
      if (!goal) return { ok: false, error: 'goal must not be empty' };
      const deadline = cleanDateKey(input.deadline);
      if (input.deadline && !deadline) return { ok: false, error: `deadline must be a real date as YYYY-MM-DD or "" (got ${JSON.stringify(input.deadline)})` };
      // the deadline-relative bounds are checked at execution, against the learner's today
      if (input.days.length < (deadline ? 1 : 3) || input.days.length > 7) return { ok: false, error: `days must have ${deadline ? 1 : 3}-7 entries (got ${input.days.length})` };
      const days = [];
      for (const [i, d] of input.days.entries()) {
        const items = d.items.slice(0, 4).map((it, j) => ({ id: `d${i + 1}i${j + 1}`, kind: it.kind, title: oneLine(it.title, 120), topic: oneLine(it.topic || (it.kind === 'review' ? '' : it.title), 200) }));
        if (!items.length || items.some((it) => !it.title)) return { ok: false, error: `day ${i + 1} needs 1-3 items with titles` };
        days.push({ day: i + 1, focus: oneLine(d.focus, 120) || `Day ${i + 1}`, items });
      }
      return { ok: true, value: { goal, deadline, days } };
    }
    case 'quiz_me': {
      const topic = oneLine(input.topic, 160) || 'Quick check';
      if (input.questions.length < 1 || input.questions.length > 5) return { ok: false, error: 'questions must have 1-5 entries' };
      const r = validateComponentProps('Quiz', { questions: input.questions });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, value: { topic, questions: r.props.questions } };
    }
    case 'remember': {
      const fact = cleanFact(input.fact);
      if (!fact) return { ok: false, error: 'fact must not be empty' };
      return { ok: true, value: { fact, kind: input.kind } };
    }
    case 'forget': {
      const id = oneLine(input.id, 64);
      if (!/^[\w-]{4,64}$/.test(id)) return { ok: false, error: 'id must be a memory item id' };
      return { ok: true, value: { id } };
    }
    case 'get_progress':
      return { ok: true, value: {} };
    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------- progress snapshot

/** Bound and clean the client-sent progress snapshot (it is untrusted input). */
export function sanitizeProgress(p) {
  const o = p && typeof p === 'object' ? p : {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  return {
    today: oneLine(o.today, 20),
    xp: n(o.xp),
    streak: n(o.streak),
    deck: { total: n(o.deck?.total), due: n(o.deck?.due), mastered: n(o.deck?.mastered ?? o.deck?.review), nextDue: oneLine(o.deck?.nextDue, 40) || null },
    recentLessons: list(o.recentLessons, 8).map((l) => ({
      title: oneLine(l?.title, 160),
      finished: !!l?.finished,
      ...(l?.quiz && Number.isFinite(Number(l.quiz.total)) ? { quiz: { score: n(l.quiz.score), total: n(l.quiz.total) } } : {}),
      ...(l?.recall != null && Number.isFinite(Number(l.recall)) ? { recall: Math.min(100, n(l.recall)), recallReviews: n(l.recallReviews) } : {}),
      when: oneLine(l?.when, 40),
    })).filter((l) => l.title),
    courses: list(o.courses, 6).map((c) => ({
      title: oneLine(c?.title, 160), done: n(c?.done), total: n(c?.total),
      ...(c?.cardsDue != null ? { cardsDue: n(c.cardsDue) } : {}),
      ...(c?.memory != null && Number.isFinite(Number(c.memory)) ? { memory: Math.min(100, n(c.memory)) } : {}),
      ...(c?.reviewSuggested === true ? { reviewSuggested: true } : {}),
    })).filter((c) => c.title),
    plans: list(o.plans, 3).map((p2) => ({ goal: oneLine(p2?.goal, 160), days: n(p2?.days), opened: n(p2?.opened), total: n(p2?.total) })).filter((x) => x.goal),
    outcomes: sanitizeOutcomes(o.outcomes),
  };
}

const VERDICTS = ['stuck', 'fading', 'weak', 'unknown'];
/** Phase 9 outcome fields of the snapshot (fading lessons, what works), bounded. */
function sanitizeOutcomes(o) {
  const x = o && typeof o === 'object' ? o : {};
  const pct = (v) => (v != null && Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : undefined);
  return {
    fading: (Array.isArray(x.fading) ? x.fading.slice(0, 4) : []).map((f) => ({
      title: oneLine(f?.title, 160),
      verdict: VERDICTS.includes(f?.verdict) ? f.verdict : 'unknown',
      ...(pct(f?.recall) != null ? { recall: pct(f.recall), reviews: Math.max(0, Math.round(Number(f.reviews) || 0)) } : {}),
      ...(pct(f?.memoryToday) != null ? { memoryToday: pct(f.memoryToday) } : {}),
      hardCards: (Array.isArray(f?.hardCards) ? f.hardCards.slice(0, 2) : []).map((c) => oneLine(c, 200)).filter(Boolean),
    })).filter((f) => f.title),
    whatWorks: (Array.isArray(x.whatWorks) ? x.whatWorks.slice(0, 4) : []).map((t) => oneLine(t, 240)).filter(Boolean),
    overallRecall: pct(x.overallRecall) ?? null,
    delayedReviews: Math.max(0, Math.round(Number(x.delayedReviews) || 0)),
  };
}

// ---------------------------------------------------------------- card state

const clone = (v) => structuredClone(v);

export function cardSummary(s) {
  if (!s || typeof s !== 'object') return 'card';
  if (s.kind === 'approval') {
    const st = { pending: 'waiting for the learner', accepted: 'the learner tapped Start and opened it', dismissed: 'the learner chose Not now' }[s.status] || s.status;
    return `Lesson suggestion "${s.topic}" (${s.level}): ${st}`;
  }
  if (s.kind === 'plan') {
    const items = (s.days || []).flatMap((d) => d.items || []);
    const opened = items.filter((i) => i.opened).map((i) => i.title);
    return `${(s.days || []).length}-day study plan for "${s.goal}"${s.startDate ? ` from ${s.startDate}` : ''}${s.deadline ? ` with deadline ${s.deadline}` : ''} (${s.saved ? 'saved by the learner' : 'not saved yet'}${opened.length ? `; opened: ${opened.join(', ')}` : ''})`;
  }
  if (s.kind === 'memory') {
    const f = s.item?.fact || '';
    if (s.status === 'undone') return s.op === 'forget' ? `Forgetting "${f}" was undone by the learner` : `The learner undid remembering "${f}"`;
    if (s.status === 'off') return `Not remembered (memory is turned off): "${f}"`;
    return s.op === 'forget' ? `Forgot: "${f}"` : `Remembered: "${f}"`;
  }
  return s.kind;
}

/** Server-side state per resolution id (bounded). */
export function createCardStore(max = 3000) {
  const map = new Map();
  return {
    get: (rid) => (map.has(rid) ? clone(map.get(rid)) : null),
    set(rid, state) {
      const s = { ...clone(state) };
      s.summary = cardSummary(s);
      map.delete(rid);
      map.set(rid, s);
      if (map.size > max) map.delete(map.keys().next().value);
      return clone(s);
    },
    has: (rid) => map.has(rid),
    get size() { return map.size; },
  };
}

export const newResolutionId = () => `tc-${randomUUID()}`;
export const resolved = (state) => ({ status: 'resolved', state: clone(state) });

// ---------------------------------------------------------------- tool execution

/**
 * Tool executors for one Teacher turn.
 * Returns async (name, input) => {content, isError?, card?: {kind, state}, markup?}.
 */
export function createTeacherToolkit({ memory, progress, mastery, memoryEnabled = true }) {
  const snapshot = sanitizeProgress(progress);
  const knows = memoryEnabled ? sanitizeMastery(mastery) : null; // Phase 6
  return async function execute(name, input) {
    switch (name) {
      case 'create_lesson': {
        const state = { kind: 'approval', action: 'create_lesson', status: 'pending', topic: input.topic, level: input.level, reason: input.reason };
        return { content: `An approval card for the lesson "${input.topic}" (${input.level}) is now shown to the learner with Start / Not now. The lesson is generated only if they tap Start. Don't restate the card.`, card: { kind: 'approval', state } };
      }
      case 'plan_study': {
        const today = cleanDateKey(snapshot.today) || localKey();
        const deadline = input.deadline || '';
        const b = planDayBounds(today, deadline);
        if (b.error) return { content: `${b.error} Ask the learner for the new date, or plan without a deadline ("").`, isError: true };
        if (input.days.length < b.min || input.days.length > b.max) {
          return { content: `The plan has ${input.days.length} days but must have ${b.min === b.max ? b.min : `${b.min}-${b.max}`}${deadline ? `: today is ${today} and the deadline is ${deadline} (${daysBetween(today, deadline) + 1} days including both)` : ''}. Call plan_study again with that many days.`, isError: true };
        }
        const days = dateDays(input.days.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, opened: false })) })), today);
        const state = { kind: 'plan', goal: input.goal, startDate: today, ...(deadline ? { deadline } : {}), days, saved: false };
        const lessons = input.days.flatMap((d) => d.items).filter((i) => i.kind === 'lesson').length;
        const span = `${days[0].label} to ${days[days.length - 1].label}`;
        return { content: `A ${days.length}-day plan card for "${input.goal}" is now shown, dated ${span}${deadline ? ` (deadline ${deadline})` : ''}, with ${lessons} lessons. The learner can open each item and save the plan. Don't list the days again; at most mention what to do first.`, card: { kind: 'plan', state } };
      }
      case 'quiz_me': {
        const title = `Quiz: ${input.topic}`;
        const markup = `<Quiz title={${JSON.stringify(title)}} questions={${JSON.stringify(input.questions)}}/>`;
        return { content: `A ${input.questions.length}-question interactive quiz on "${input.topic}" is now shown. The learner answers it in the card and gets hints and explanations there. Don't reveal the answers.`, markup };
      }
      case 'remember': {
        if (!memoryEnabled) {
          return { content: 'Memory is turned off for this conversation by the learner; nothing was saved. Do not try again.', isError: true, card: { kind: 'memory', state: { kind: 'memory', op: 'remember', status: 'off', item: { id: '', fact: input.fact, kind: input.kind } } } };
        }
        const r = memory.add({ fact: input.fact, kind: input.kind, source: 'teacher' });
        if (!r.ok) return { content: r.error, isError: true };
        if (r.duplicate) return { content: `Already in memory as ${r.item.id}: "${r.item.fact}". Nothing new saved.` };
        return { content: `Saved to memory as ${r.item.id}.`, card: { kind: 'memory', state: { kind: 'memory', op: 'remember', status: 'saved', item: r.item } } };
      }
      case 'forget': {
        if (!memoryEnabled) return { content: 'Memory is turned off for this conversation; nothing changed.', isError: true };
        const item = memory.remove(input.id);
        if (!item) return { content: `No memory item with id ${input.id}. Check the ids in the learner memory context.`, isError: true };
        return { content: `Removed ${item.id} ("${item.fact}") from memory.`, card: { kind: 'memory', state: { kind: 'memory', op: 'forget', status: 'forgotten', item } } };
      }
      case 'get_progress': {
        const out = { ...snapshot, memory: memoryEnabled ? memory.list().slice(0, 15).map(({ id, fact, kind }) => ({ id, fact, kind })) : 'turned off by the learner', mastery: knows || (memoryEnabled ? 'no graded answers yet' : 'turned off by the learner') };
        return { content: JSON.stringify(out) };
      }
      default:
        return { content: `Unknown tool ${name}`, isError: true };
    }
  };
}

// ---------------------------------------------------------------- model-text filter

const CARD_TAG = '<TeacherCard';
const CARD_CLOSE = '</TeacherCard>';

/**
 * Streaming filter for model text: TeacherCard is server-only markup, so any the model writes
 * itself (open, self-closing or closing tags) is removed, even when split across deltas.
 * A trailing fragment that could still become such a tag is held back until it resolves.
 */
export function createCardStripper() {
  let buf = '';
  const partialPrefix = (s) => {
    for (const tag of [CARD_TAG, CARD_CLOSE]) {
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (s.endsWith(tag.slice(0, k))) return k;
    }
    return 0;
  };
  function drain(final) {
    let out = '';
    for (;;) {
      const open = buf.indexOf(CARD_TAG);
      const close = buf.indexOf(CARD_CLOSE);
      const idx = open < 0 ? close : close < 0 ? open : Math.min(open, close);
      if (idx < 0) break;
      out += buf.slice(0, idx);
      if (idx === close) { buf = buf.slice(idx + CARD_CLOSE.length); continue; }
      const after = buf[idx + CARD_TAG.length];
      if (after !== undefined && !/[\s/>]/.test(after)) { out += buf.slice(idx, idx + CARD_TAG.length); buf = buf.slice(idx + CARD_TAG.length); continue; } // e.g. <TeacherCardX
      const end = buf.indexOf('>', idx);
      if (end < 0) { buf = final ? '' : buf.slice(idx); return out; } // unterminated: hold (or drop at the end)
      buf = buf.slice(end + 1);
    }
    const hold = partialPrefix(buf); // at the end of a text block a dangling "<TeacherCa…" is dropped
    out += buf.slice(0, buf.length - hold);
    buf = final ? '' : buf.slice(buf.length - hold);
    return out;
  }
  return {
    push(text) { buf += text; return drain(false); },
    flush() { return drain(true); },
  };
}

/** Strip TeacherCard markup from text sent back to the model as history. */
export function stripCardMarkup(text) {
  return String(text ?? '').replace(/<TeacherCard\b[^>]*>/g, '[card]').replace(/<\/TeacherCard\s*>/g, '');
}

// ---------------------------------------------------------------- the loop

const isToolJsonError = (err) => err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError);

/**
 * Manual streaming tool loop (claude-api "Streaming Manual Loop"):
 *  - stream each iteration; text deltas -> card stripper -> writer.append; a tool_use block
 *    starting -> reasoning record (Wondering's tool_start)
 *  - stop on refusal / max_tokens without running tools; pause_turn -> append and re-send
 *  - validate every tool input; invalid -> is_error tool_result (tool not run)
 *  - all tool_results of one assistant turn go back in ONE user message; the full
 *    message.content (thinking + text + tool_use) is appended to history
 *  - each executed tool's card is spliced into the markdown at the point of the call
 * SDK API errors are thrown to the caller.
 *
 * @returns {Promise<{status:'done', truncated:boolean, refused:boolean, capped:boolean, iterations:number, messages:object[]}>}
 */
export async function runTeacherLoop({ client, params, messages: initial, writer, signal, execute, onCard, maxIterations = MAX_TEACHER_ITERATIONS, logger }) {
  const messages = initial.slice();
  const strip = createCardStripper();
  let truncated = false;
  let refused = false;
  let iterations = 0;
  let jsonRetries = 0;
  const announced = new Set(); // tool_use ids whose status line was shown while streaming
  let needBreak = false; // a tool round happened: start the next text on a new paragraph
  const appendText = (t) => {
    if (!t) return;
    if (needBreak) { needBreak = false; if (writer.markdown && !/\n\s*$/.test(writer.markdown)) writer.append('\n\n'); }
    writer.append(t);
  };
  // put a spliced block on its own paragraph
  const appendBlock = (markup) => {
    const md = writer.markdown;
    writer.append(`${!md ? '' : md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n'}${markup}\n\n`);
  };

  while (iterations < maxIterations) {
    iterations++;
    let message;
    try {
      const stream = client.beta.messages.stream({ ...params, messages }, signal ? { signal } : undefined);
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          appendText(strip.flush());
          announced.add(event.content_block.id);
          writer.reasoning(TOOL_LABELS[event.content_block.name] || 'Working on it…');
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          appendText(strip.push(event.delta.text));
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Eager input streaming: a tool input that is not parseable JSON at all rejects the
      // stream. Re-issue that turn (capped); every other error goes to the caller.
      if (signal?.aborted || !isToolJsonError(err) || jsonRetries++ >= 2) throw err;
      logger?.warn?.('[wonder] teacher tool input was not parseable JSON; re-issuing the turn');
      continue;
    }
    appendText(strip.flush());
    const stop = message.stop_reason;
    logger?.info?.(`[wonder] teacher request ${iterations}: stop_reason=${stop}, tools=${(message.content || []).filter((b) => b.type === 'tool_use').map((b) => b.name).join(',') || 'none'}`);
    if (stop === 'refusal') { refused = true; break; }
    if (stop === 'pause_turn') { messages.push({ role: 'assistant', content: message.content }); continue; }
    const toolUses = (message.content || []).filter((b) => b.type === 'tool_use');
    if (stop === 'max_tokens') { truncated = true; break; } // a tool input cut off here would parse as a partial object
    if (!toolUses.length) break;

    messages.push({ role: 'assistant', content: message.content });
    const results = [];
    for (const tu of toolUses) {
      const v = validateToolInput(tu.name, tu.input);
      if (!v.ok) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: `Invalid input: ${v.error}`, INVALID_INPUT: JSON.stringify(tu.input ?? null).slice(0, 2000) }) });
        continue;
      }
      if (!announced.has(tu.id)) writer.reasoning(TOOL_LABELS[tu.name] || 'Working on it…');
      let r;
      try { r = await execute(tu.name, v.value); } catch (e) { r = { content: `Tool failed: ${e.message}`, isError: true }; }
      if (r.card) appendBlock(`<TeacherCard kind="${r.card.kind}" __resolutionId="${onCard(r.card.state, r.card)}"/>`);
      else if (r.markup) appendBlock(r.markup);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(r.content ?? ''), ...(r.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    needBreak = true;
    writer.reasoning('Writing a reply…');
  }
  // the cap was hit right after a tool round: the model never got to answer the results
  const capped = needBreak && iterations >= maxIterations;
  if (capped) appendText('*I paused here to keep this reply short. Ask me to continue.*\n');
  return { status: 'done', truncated, refused, capped, iterations, messages };
}

// ---------------------------------------------------------------- card widget actions

/** Rebuild card state from a client-sent copy (server restarted and lost its copy). */
function stateFromPayload(raw) {
  const s = raw && typeof raw === 'object' ? raw : null;
  if (!s || !['approval', 'plan', 'memory'].includes(s.kind)) return null;
  if (s.kind === 'approval') {
    const topic = oneLine(s.topic, 200);
    if (!topic) return null;
    return { kind: 'approval', action: 'create_lesson', status: ['pending', 'accepted', 'dismissed'].includes(s.status) ? s.status : 'pending', topic, level: LEVELS.includes(s.level) ? s.level : 'beginner', reason: oneLine(s.reason, 300) };
  }
  if (s.kind === 'plan') {
    const days = (Array.isArray(s.days) ? s.days : []).slice(0, 7).map((d, i) => ({
      day: i + 1,
      focus: oneLine(d?.focus, 120) || `Day ${i + 1}`,
      items: (Array.isArray(d?.items) ? d.items : []).slice(0, 4).map((it, j) => ({ id: `d${i + 1}i${j + 1}`, kind: ITEM_KINDS.includes(it?.kind) ? it.kind : 'lesson', title: oneLine(it?.title, 120), topic: oneLine(it?.topic, 200), opened: !!it?.opened })).filter((it) => it.title),
    })).filter((d) => d.items.length);
    const goal = oneLine(s.goal, 200);
    const startDate = cleanDateKey(s.startDate);
    const deadline = cleanDateKey(s.deadline);
    return goal && days.length ? { kind: 'plan', goal, ...(startDate ? { startDate } : {}), ...(deadline ? { deadline } : {}), days: startDate ? dateDays(days, startDate) : days, saved: !!s.saved } : null;
  }
  const fact = cleanFact(s.item?.fact);
  if (!fact) return null;
  return { kind: 'memory', op: s.op === 'forget' ? 'forget' : 'remember', status: ['saved', 'forgotten', 'undone', 'off'].includes(s.status) ? s.status : 'saved', item: { id: oneLine(s.item?.id, 64), fact, kind: MEMORY_KINDS.includes(s.item?.kind) ? s.item.kind : 'background', source: 'teacher', createdAt: s.item?.createdAt } };
}

export const TEACHER_ACTIONS = new Set(['teacher_accept', 'teacher_dismiss', 'teacher_undo', 'teacher_open_item']);

/**
 * Handle one teacher card action. Returns {status, body}; body has componentResults (new
 * state for the card) and clientActions for the host (start a lesson, save a plan, …).
 */
export function handleTeacherAction({ cards, memory }, { action_type: type, payload = {}, resolutionId: rid }) {
  if (typeof rid !== 'string' || !/^[\w-]{8,80}$/.test(rid)) return { status: 400, body: { ok: false, error: 'resolutionId is required' } };
  let s = cards.get(rid) || stateFromPayload(payload.state);
  if (!s) return { status: 404, body: { ok: false, error: 'Unknown card' } };
  const clientActions = [];
  const bad = (error) => ({ status: 400, body: { ok: false, error } });

  if (s.kind === 'approval') {
    if (type === 'teacher_accept') {
      s.status = 'accepted';
      clientActions.push({ type: 'start_lesson', payload: { topic: s.topic, level: s.level, resolutionId: rid } });
    } else if (type === 'teacher_dismiss') {
      if (s.status === 'pending') s.status = 'dismissed';
    } else if (type === 'teacher_undo') {
      if (s.status === 'dismissed') s.status = 'pending';
    } else return bad(`${type} does not apply to an approval card`);
  } else if (s.kind === 'plan') {
    if (type === 'teacher_accept') {
      s.saved = true;
      clientActions.push({ type: 'save_plan', payload: { resolutionId: rid, plan: { goal: s.goal, startDate: s.startDate, deadline: s.deadline, days: s.days } } });
    } else if (type === 'teacher_undo') {
      if (s.saved) { s.saved = false; clientActions.push({ type: 'unsave_plan', payload: { resolutionId: rid } }); }
    } else if (type === 'teacher_open_item') {
      const item = s.days.flatMap((d) => d.items).find((i) => i.id === payload.itemId);
      if (!item) return bad('itemId must name an item of this plan');
      item.opened = true;
      if (item.kind === 'review') clientActions.push({ type: 'open_review', payload: {} });
      else if (item.kind === 'quiz') clientActions.push({ type: 'issue_new_turn', payload: { query: `Quiz me on ${item.topic || item.title}.` } });
      else clientActions.push({ type: 'start_lesson', payload: { topic: item.topic || item.title, title: item.title, level: 'beginner', resolutionId: `${rid}:${item.id}` } });
    } else return bad(`${type} does not apply to a plan card`);
  } else if (s.kind === 'memory') {
    if (type !== 'teacher_undo') return bad(`${type} does not apply to a memory card`);
    if (s.status === 'saved' && s.op === 'remember') { memory.remove(s.item.id); s.status = 'undone'; }
    else if (s.status === 'forgotten' && s.op === 'forget') { memory.restore(s.item); s.status = 'undone'; }
    else if (s.status === 'undone') {
      // redo
      if (s.op === 'remember') { const r = memory.restore(s.item); if (r.ok) s.status = 'saved'; }
      else { memory.remove(s.item.id); s.status = 'forgotten'; }
    }
  }
  const state = cards.set(rid, s);
  return { status: 200, body: { ok: true, componentResults: { [rid]: resolved(state) }, clientActions } };
}
