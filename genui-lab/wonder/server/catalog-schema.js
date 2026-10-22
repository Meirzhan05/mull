// Server-side schemas for the Wonder learning catalog (Wondering's lesson widgets re-expressed
// as DIL catalog components). Each validator normalizes the model's props (aliases, string
// shorthands, defaults) and either returns clean props or an error; the compiler keeps invalid
// components out of the DIL program and substitutes fallback markdown.
//
// Bounds for the visual widgets come straight from Wondering's voice-visual validators
// (validateVoiceVisualPayload, findings §3.5), reused from wondering-genui. The other bounds
// follow the lesson widget normalizers in findings §1.4.

import { validateVoiceVisualPayload } from '../../wondering-genui/src/voice-visuals.js';
import { validateFunctionGraph, functionGraphFallback } from './function-graph.js'; // Phase 5
import { validateExplainBack, explainBackFallback } from './grader.js'; // Phase 8
import { validateDiagram, diagramFallback } from './diagram.js'; // media: model-drawn diagrams
import { validateFigure, figureFallback } from './figures.js'; // media: Wikimedia Commons images

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const pick = (o, ...keys) => { for (const k of keys) { const t = text(o?.[k]); if (t) return t; } return ''; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[,_\s]/g, ''))) ? Number(v.replace(/[,_\s]/g, '')) : null);
const ok = (props) => ({ ok: true, props });
const fail = (error) => ({ ok: false, error });
const optional = (o, k, v) => { if (v !== '' && v != null) o[k] = v; return o; };

function viaVoice(type, payload) {
  const v = validateVoiceVisualPayload({ ...payload, type });
  if (!v) return fail(`${type} props are missing required fields or outside the allowed bounds`);
  const { type: _t, ...rest } = v;
  return ok(rest);
}

// ---------------------------------------------------------------- visual widgets (voice bounds)

const FLOW_TYPE_ALIASES = { start: 'start', begin: 'start', input: 'start', end: 'end', finish: 'end', stop: 'end', output: 'end', result: 'end', decision: 'decision', question: 'decision', choice: 'decision', branch: 'decision', process: 'process', step: 'process', action: 'process' };

function Flowchart(p) {
  const rawNodes = Array.isArray(p.nodes) ? p.nodes : Array.isArray(p.steps) ? p.steps : null;
  if (!rawNodes) return fail('Flowchart needs nodes');
  const nodes = rawNodes.map((n, i, all) => {
    const r = isObj(n) ? n : { label: text(n) };
    const t = FLOW_TYPE_ALIASES[text(r.type).toLowerCase()];
    return {
      id: pick(r, 'id') || `n${i + 1}`,
      label: pick(r, 'label', 'text', 'title', 'name'),
      type: t || (i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'process'),
      ...(r.highlighted === true ? { highlighted: true } : {}),
    };
  });
  let connections = Array.isArray(p.connections) ? p.connections : Array.isArray(p.edges) ? p.edges : null;
  if (!connections || connections.length === 0) connections = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  connections = connections.map((c) => (isObj(c) ? optional({ from: pick(c, 'from', 'source'), to: pick(c, 'to', 'target') }, 'label', pick(c, 'label')) : c));
  const r = viaVoice('flowchart', { nodes, connections, ...(text(p.title) ? { title: text(p.title) } : {}) });
  if (!r.ok) return r;
  const ids = new Set(r.props.nodes.map((n) => n.id));
  if (r.props.connections.some((c) => !ids.has(c.from) || !ids.has(c.to))) return fail('Flowchart connections must reference node ids');
  return r;
}

function Timeline(p) {
  if (!Array.isArray(p.events)) return fail('Timeline needs events');
  const events = p.events.map((e) => (isObj(e)
    ? { ...optional(optional({ date: pick(e, 'date', 'year', 'time', 'when'), label: pick(e, 'label', 'title', 'event', 'name') }, 'description', pick(e, 'description', 'text', 'detail')), 'highlighted', e.highlighted === true ? true : '') }
    : e));
  return viaVoice('timeline', { events, ...(text(p.title) ? { title: text(p.title) } : {}) });
}

function BarChart(p) {
  if (!Array.isArray(p.bars)) return fail('BarChart needs bars');
  const bars = p.bars.map((b) => (isObj(b)
    ? { ...optional(optional({ label: pick(b, 'label', 'name'), value: num(b.value) ?? b.value }, 'description', pick(b, 'description', 'note')), 'highlighted', b.highlighted === true ? true : '') }
    : b));
  const extra = {};
  for (const k of ['title', 'xLabel', 'yLabel']) if (text(p[k])) extra[k] = text(p[k]);
  return viaVoice('bar_chart', { unit: text(p.unit), bars, ...extra });
}

function ConceptMap(p) {
  if (!Array.isArray(p.nodes)) return fail('ConceptMap needs nodes');
  const nodes = p.nodes.map((n, i) => {
    const r = isObj(n) ? n : { label: text(n) };
    const level = num(r.level);
    return { id: pick(r, 'id') || `c${i + 1}`, label: pick(r, 'label', 'name', 'text'), ...(level === 1 || level === 2 ? { level } : {}), ...(r.highlighted === true ? { highlighted: true } : {}) };
  });
  let connections = Array.isArray(p.connections) ? p.connections : [];
  if (connections.length < 2) connections = nodes.filter((n) => n.level !== 2).map((n) => ({ from: 'center', to: n.id, relationship: 'relates to' }));
  connections = connections.map((c) => (isObj(c) ? { from: pick(c, 'from', 'source') || 'center', to: pick(c, 'to', 'target'), relationship: pick(c, 'relationship', 'label', 'relation') || 'relates to' } : c));
  return viaVoice('concept_map', { centerConcept: pick(p, 'centerConcept', 'center', 'title'), nodes, connections, ...(text(p.title) && text(p.centerConcept) ? { title: text(p.title) } : {}) });
}

function Cycle(p) {
  if (!Array.isArray(p.stages)) return fail('Cycle needs stages');
  const stages = p.stages.map((s) => (isObj(s) ? optional({ label: pick(s, 'label', 'name', 'title') }, 'description', pick(s, 'description', 'text')) : { label: text(s) }));
  const extra = {};
  if (text(p.title)) extra.title = text(p.title);
  if (text(p.centerLabel)) extra.centerLabel = text(p.centerLabel);
  return viaVoice('loop', { stages, ...extra });
}

function Reveal(p) {
  if (!Array.isArray(p.items)) return fail('Reveal needs items');
  const items = p.items.map((it) => (isObj(it) ? { label: pick(it, 'label', 'prompt', 'question', 'title'), content: pick(it, 'content', 'answer', 'text', 'description') } : it));
  return viaVoice('reveal', { items, ...(text(p.title) ? { title: text(p.title) } : {}) });
}

function InputOutputSlider(p) {
  if (!Array.isArray(p.stops)) return fail('InputOutputSlider needs stops');
  const stops = p.stops.map((s) => (isObj(s)
    ? optional(optional({ value: num(s.value) ?? s.value, output: pick(s, 'output', 'result', 'outcome') }, 'label', pick(s, 'label')), 'description', pick(s, 'description', 'note'))
    : s));
  const extra = {};
  if (text(p.title)) extra.title = text(p.title);
  if (text(p.unit)) extra.unit = text(p.unit);
  return viaVoice('slider', { inputLabel: pick(p, 'inputLabel', 'input'), outputLabel: pick(p, 'outputLabel', 'output'), stops, ...extra });
}

// ---------------------------------------------------------------- lesson widgets

function LessonStepper(p) {
  const raw = Array.isArray(p.steps) ? p.steps : null;
  if (!raw || raw.length < 2) return fail('LessonStepper needs at least 2 steps');
  const steps = [];
  for (const s of raw.slice(0, 8)) {
    const r = isObj(s) ? s : { text: text(s) };
    const t = pick(r, 'text', 'description', 'content', 'body');
    if (!t) return fail('Every LessonStepper step needs text');
    steps.push(optional({ text: t }, 'label', pick(r, 'label', 'title', 'name')));
  }
  return ok(optional({ steps }, 'title', text(p.title)));
}

function side(v) {
  if (!isObj(v)) return null;
  const label = pick(v, 'label', 'title', 'name');
  const pts = (Array.isArray(v.points) ? v.points : Array.isArray(v.items) ? v.items : []).map(text).filter(Boolean).slice(0, 6);
  return label && pts.length ? { label, points: pts } : null;
}
function CompareToggle(p) {
  const left = side(p.left);
  const right = side(p.right);
  if (!left || !right) return fail('CompareToggle needs left and right sides, each with a label and 1-6 points');
  return ok(optional({ left, right }, 'title', text(p.title)));
}

const LETTERS = 'abcdefgh';
const TRUE_FALSE_OPTIONS = [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }];

/** Normalize one quiz question (also used by /api/widget_action grading). */
export function normalizeQuestion(q, index = 0) {
  if (!isObj(q)) return fail(`Question ${index + 1} is not an object`);
  const prompt = pick(q, 'prompt', 'question', 'text', 'title');
  if (!prompt) return fail(`Question ${index + 1} needs a prompt`);
  let type = text(q.question_type || q.type).toLowerCase().replace(/[-\s]/g, '_');
  if (['mcq', 'single', 'multiple_choice', 'single_choice'].includes(type)) type = 'single_select';
  if (['multi', 'multiple_select', 'multi_choice'].includes(type)) type = 'multi_select';
  if (['tf', 'truefalse', 'boolean', 'binary'].includes(type)) type = 'true_false';
  const correctRaw = q.correct_values ?? q.correct_value ?? q.correct ?? q.answer ?? q.correctAnswer;
  if (!type) type = !Array.isArray(q.options) && typeof correctRaw === 'boolean' ? 'true_false' : 'single_select';
  if (!['single_select', 'multi_select', 'true_false'].includes(type)) return fail(`Question ${index + 1} has unsupported type ${type}`);
  let options;
  if (type === 'true_false' && (!Array.isArray(q.options) || q.options.length === 0)) options = TRUE_FALSE_OPTIONS.map((o) => ({ ...o }));
  else {
    if (!Array.isArray(q.options) || q.options.length < 2) return fail(`Question ${index + 1} needs 2-6 options`);
    options = q.options.slice(0, 6).map((o, i) => (isObj(o)
      ? { value: pick(o, 'value', 'id') || LETTERS[i], label: pick(o, 'label', 'text', 'value') }
      : { value: LETTERS[i], label: text(o) }));
    if (options.some((o) => !o.label)) return fail(`Question ${index + 1} has an empty option`);
    if (new Set(options.map((o) => o.value)).size !== options.length) return fail(`Question ${index + 1} has duplicate option values`);
  }
  const list = (Array.isArray(correctRaw) ? correctRaw : correctRaw == null ? [] : [correctRaw]).map((v) => (typeof v === 'boolean' ? String(v) : text(v)));
  const correct_values = [];
  for (const v of list) {
    const lc = v.toLowerCase();
    const hit = options.find((o) => o.value === v) || options.find((o) => o.value.toLowerCase() === lc || o.label.toLowerCase() === lc)
      || (/^\d+$/.test(v) && Number(v) < options.length ? options[Number(v)] : null);
    if (!hit) return fail(`Question ${index + 1}: correct value "${v}" is not one of the options`);
    if (!correct_values.includes(hit.value)) correct_values.push(hit.value);
  }
  if (correct_values.length === 0) return fail(`Question ${index + 1} needs correct_values`);
  if (type !== 'multi_select' && correct_values.length !== 1) return fail(`Question ${index + 1} must have exactly one correct value`);
  const out = { id: pick(q, 'id') || `q${index + 1}`, prompt, question_type: type, options, correct_values };
  optional(out, 'hint', pick(q, 'hint'));
  optional(out, 'explanation', pick(q, 'explanation', 'rationale', 'feedback'));
  optional(out, 'concept', pick(q, 'concept', 'skill').replace(/\s+/g, ' ').slice(0, 60).trim()); // Phase 6: mastery tag
  return ok(out);
}

function Quiz(p) {
  const raw = Array.isArray(p.questions) ? p.questions : null;
  if (!raw || raw.length === 0) return fail('Quiz needs 1-5 questions');
  const questions = [];
  const ids = new Set();
  for (const [i, q] of raw.slice(0, 5).entries()) {
    const r = normalizeQuestion(q, i);
    if (!r.ok) return r;
    if (ids.has(r.props.id)) r.props.id = `q${i + 1}`;
    ids.add(r.props.id);
    questions.push(r.props);
  }
  return ok(optional({ questions }, 'title', text(p.title)));
}

function Flashcards(p) {
  const raw = Array.isArray(p.cards) ? p.cards : null;
  if (!raw || raw.length === 0) return fail('Flashcards needs 1-12 cards');
  const cards = [];
  for (const c of raw.slice(0, 12)) {
    const front = pick(c, 'front', 'term', 'question', 'prompt');
    const back = pick(c, 'back', 'definition', 'answer');
    if (!front || !back) return fail('Every flashcard needs front and back');
    cards.push({ front, back });
  }
  return ok(optional({ cards }, 'title', text(p.title)));
}

function KeyTerm(p) {
  const term = pick(p, 'term', 'name', 'word');
  const definition = pick(p, 'definition', 'meaning', 'description');
  if (!term || !definition) return fail('KeyTerm needs term and definition');
  return ok({ term, definition });
}

const TONES = new Set(['insight', 'tip', 'info', 'warning', 'example']);
function Callout(p) {
  const tone = text(p.tone).toLowerCase();
  const out = { tone: TONES.has(tone) ? tone : 'insight' };
  optional(out, 'title', text(p.title));
  optional(out, 'body', pick(p, 'body', 'content', 'text'));
  return ok(out);
}

function Celebration(p) {
  return ok(optional({}, 'message', pick(p, 'message', 'title', 'text')));
}

// ---------------------------------------------------------------- Teacher tool cards

export const TEACHER_CARD_KINDS = Object.freeze(['approval', 'plan', 'quiz', 'memory']);
export const RESOLUTION_ID_RE = /^[\w-]{8,64}$/;

/**
 * <TeacherCard kind="plan" __resolutionId="…"/> is spliced in by the server at the point of a
 * Teacher tool call (never written by the model). Its data lives in
 * appData.opGenui.componentResults[__resolutionId], like ChatGPT's server-resolved components.
 */
function TeacherCard(p) {
  const kind = text(p.kind).toLowerCase();
  if (!TEACHER_CARD_KINDS.includes(kind)) return fail(`TeacherCard kind must be one of ${TEACHER_CARD_KINDS.join(', ')}`);
  const rid = text(p.__resolutionId);
  if (!RESOLUTION_ID_RE.test(rid)) return fail('TeacherCard needs a server-assigned __resolutionId');
  return ok({ kind, __resolutionId: rid });
}

// ---------------------------------------------------------------- registry

/** inline: may sit inside a paragraph. children: takes markdown children. */
export const LEARNING_COMPONENTS = Object.freeze({
  LessonStepper: { validate: LessonStepper },
  Reveal: { validate: Reveal },
  CompareToggle: { validate: CompareToggle },
  InputOutputSlider: { validate: InputOutputSlider },
  Flowchart: { validate: Flowchart },
  Timeline: { validate: Timeline },
  BarChart: { validate: BarChart },
  ConceptMap: { validate: ConceptMap },
  Cycle: { validate: Cycle },
  Quiz: { validate: Quiz },
  Flashcards: { validate: Flashcards },
  KeyTerm: { validate: KeyTerm, inline: true },
  Callout: { validate: Callout, children: true },
  Celebration: { validate: Celebration },
  TeacherCard: { validate: TeacherCard, resolved: true },
  FunctionGraph: { validate: validateFunctionGraph }, // Phase 5 (server/function-graph.js)
  ExplainBack: { validate: validateExplainBack }, // Phase 8 (server/grader.js)
  Diagram: { validate: validateDiagram }, // media (server/diagram.js)
  Figure: { validate: validateFigure }, // media (server/figures.js; image resolved server-side)
});
export const LEARNING_COMPONENT_NAMES = Object.freeze(Object.keys(LEARNING_COMPONENTS));

/** Meta tags are protocol, not UI: removed from the rendered program and lifted into records. */
export const META_COMPONENTS = Object.freeze({
  Followups(p) {
    const items = (Array.isArray(p.items) ? p.items : Array.isArray(p.prompts) ? p.prompts : []).map(text).filter(Boolean).slice(0, 3);
    return items.length ? ok({ items }) : fail('Followups needs items');
  },
});

export function validateComponentProps(name, props) {
  const spec = LEARNING_COMPONENTS[name];
  if (!spec) return fail(`Unknown component ${name}`);
  try { return spec.validate(isObj(props) ? props : {}); } catch (e) { return fail(`${name}: ${e.message}`); }
}

// ---------------------------------------------------------------- fallback markdown

const clean = (s) => String(s).replace(/</g, '‹').replace(/\s*\n\s*/g, ' ').trim();

/** Markdown rendition of a component whose props did not validate (or for fallbackMarkdown). */
export function fallbackMarkdownFor(name, props, { inline = false } = {}) {
  const p = isObj(props) ? props : {};
  if (name === 'TeacherCard') return '';
  if (name === 'FunctionGraph') return functionGraphFallback(p); // Phase 5
  if (name === 'ExplainBack') return explainBackFallback(p); // Phase 8
  if (name === 'Diagram') return diagramFallback(p);
  if (name === 'Figure') return figureFallback(p);
  if (name === 'KeyTerm' || inline) {
    const term = pick(p, 'term', 'title', 'label', 'name');
    const def = pick(p, 'definition', 'text');
    return term ? `**${clean(term)}**${def ? ` (${clean(def)})` : ''}` : '';
  }
  const lines = [];
  const title = pick(p, 'title', 'centerConcept');
  if (title) lines.push(`**${clean(title)}**`, '');
  if (name === 'Quiz' && Array.isArray(p.questions)) {
    p.questions.forEach((q, i) => {
      const prompt = pick(q, 'prompt', 'question', 'text');
      if (!prompt) return;
      lines.push(`${i + 1}. ${clean(prompt)}`);
      if (Array.isArray(q.options)) for (const o of q.options) { const l = isObj(o) ? pick(o, 'label', 'text') : text(o); if (l) lines.push(`   - ${clean(l)}`); }
    });
    return lines.join('\n').trim();
  }
  if (name === 'CompareToggle') {
    for (const k of ['left', 'right']) {
      const s = p[k];
      if (!isObj(s)) continue;
      lines.push(`- **${clean(pick(s, 'label', 'title') || k)}**: ${(Array.isArray(s.points) ? s.points : []).map(text).filter(Boolean).map(clean).join('; ')}`);
    }
    return lines.join('\n').trim();
  }
  if (name === 'Callout') return [title ? `**${clean(title)}**` : '', clean(pick(p, 'body', 'content', 'text'))].filter(Boolean).join(' ');
  const list = p.steps || p.items || p.events || p.bars || p.nodes || p.stages || p.stops || p.cards || [];
  if (Array.isArray(list)) {
    for (const it of list.slice(0, 12)) {
      if (!isObj(it)) { if (text(it)) lines.push(`- ${clean(text(it))}`); continue; }
      const head = pick(it, 'label', 'date', 'front', 'title', 'name') || (it.value != null ? text(it.value) : '');
      const body = pick(it, 'text', 'content', 'description', 'output', 'back');
      const extra = it.date && pick(it, 'label') ? `${clean(it.date)} — ` : '';
      if (head || body) lines.push(`- ${extra}${head ? `**${clean(pick(it, 'label') || head)}**` : ''}${head && body ? ': ' : ''}${body ? clean(body) : ''}${it.value != null && name === 'BarChart' ? ` (${clean(it.value)}${p.unit ? ' ' + clean(p.unit) : ''})` : ''}`);
    }
  }
  return lines.join('\n').trim();
}
