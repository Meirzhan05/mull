// Voice-tutor visuals + board.
// Validators: exact port of validateVoiceVisualPayload and helpers (@5054543-@5061900).
// Board reducer + tool handlers: port of LessonVoiceTutor chunk (@17591 reducer bt,
// @18800 board API va, @20400 handler Na). DOM-free.

import { isInteractiveComponent } from "./components/registry.js";

export const VOICE_VISUAL_TYPES = Object.freeze(["flowchart", "timeline", "comparison", "bar_chart", "concept_map", "loop", "reveal", "slider"]);

export const VOICE_VISUAL_COMPONENTS = Object.freeze({
  flowchart: "flowchart-visualization",
  timeline: "timeline-visualization",
  comparison: "comparison-visualization",
  bar_chart: "bar-chart-visualization",
  concept_map: "concept-map-visualization",
  loop: "cycle-visualization",
  reveal: "lesson-reveal",
  slider: "lesson-input-output-slider",
});

// Default board titles per type (map `wa` in the chunk).
export const VOICE_VISUAL_DEFAULT_TITLES = Object.freeze({
  flowchart: "Flowchart",
  timeline: "Timeline",
  comparison: "Comparison",
  bar_chart: "Bar chart",
  concept_map: "Concept map",
  loop: "Cycle",
  reveal: "Predict, then check",
  slider: "Drag to explore",
});

const INVALID = Symbol("invalid");
const FLOWCHART_NODE_TYPES = new Set(["start", "process", "decision", "end"]);

function asRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}
function requiredText(v) {
  return typeof v !== "string" ? null : v.trim() || null;
}
function optionalText(v) {
  return v == null ? undefined : requiredText(v) ?? INVALID;
}
function optionalFlag(v) {
  if (v == null) return undefined;
  return typeof v !== "boolean" ? INVALID : v || undefined;
}
/** Keeps the first highlighted entry, strips `highlighted` from the rest. */
export function keepSingleHighlight(items) {
  let seen = false;
  return items.map((it) => {
    if (!it.highlighted) return it;
    if (seen) {
      const { highlighted, ...rest } = it;
      return rest;
    }
    seen = true;
    return it;
  });
}
/** null when not an array or shorter than min; otherwise truncated to max (NOT rejected). */
export function boundedArray(v, min, max) {
  return !Array.isArray(v) || v.length < min ? null : v.slice(0, max);
}
function optionalStringArray(v, max) {
  if (v == null) return undefined;
  if (!Array.isArray(v)) return INVALID;
  const out = [];
  for (const x of v.slice(0, max)) {
    const t = requiredText(x);
    if (!t) return INVALID;
    out.push(t);
  }
  return out;
}

function validateFlowchart(p) {
  const title = optionalText(p.title);
  const nodes = boundedArray(p.nodes, 3, 8);
  const conns = boundedArray(p.connections, 2, 12);
  if (title === INVALID || !nodes || !conns) return null;
  const outNodes = [];
  for (const n of nodes) {
    const r = asRecord(n);
    const id = requiredText(r?.id);
    const label = requiredText(r?.label);
    const type = r?.type;
    const hl = optionalFlag(r?.highlighted);
    if (!r || !id || !label || typeof type !== "string" || !FLOWCHART_NODE_TYPES.has(type) || hl === INVALID) return null;
    outNodes.push({ id, label, type, ...(hl ? { highlighted: true } : {}) });
  }
  const outConns = [];
  for (const c of conns) {
    const r = asRecord(c);
    const from = requiredText(r?.from);
    const to = requiredText(r?.to);
    const label = optionalText(r?.label);
    if (!r || !from || !to || label === INVALID) return null;
    outConns.push({ from, to, ...(label ? { label } : {}) });
  }
  return { type: "flowchart", ...(title ? { title } : {}), nodes: keepSingleHighlight(outNodes), connections: outConns };
}

function validateTimeline(p) {
  const title = optionalText(p.title);
  const events = boundedArray(p.events, 3, 7);
  if (title === INVALID || !events) return null;
  const out = [];
  for (const e of events) {
    const r = asRecord(e);
    const date = requiredText(r?.date);
    const label = requiredText(r?.label);
    const description = optionalText(r?.description);
    const hl = optionalFlag(r?.highlighted);
    if (!r || !date || !label || description === INVALID || hl === INVALID) return null;
    out.push({ date, label, ...(description ? { description } : {}), ...(hl ? { highlighted: true } : {}) });
  }
  return { type: "timeline", ...(title ? { title } : {}), events: keepSingleHighlight(out) };
}

function validateNamedValues(v, min, max) {
  const arr = boundedArray(v, min, max);
  if (!arr) return null;
  const out = [];
  for (const x of arr) {
    const r = asRecord(x);
    const name = requiredText(r?.name);
    const value = requiredText(r?.value);
    if (!r || !name || !value) return null;
    out.push({ name, value });
  }
  return out;
}

function validateComparison(p) {
  const title = optionalText(p.title);
  const common = optionalStringArray(p.commonFeatures, 5);
  const items = boundedArray(p.items, 2, 4);
  if (title === INVALID || common === INVALID || !items) return null;
  const out = [];
  for (const it of items) {
    const r = asRecord(it);
    const label = requiredText(r?.label);
    const attributes = validateNamedValues(r?.attributes, 1, 6);
    const details = r?.details === undefined || r?.details === null ? undefined : validateNamedValues(r.details, 0, 6);
    if (!r || !label || !attributes || details === null) return null;
    out.push({ label, attributes, ...(details ? { details } : {}) });
  }
  return { type: "comparison", ...(title ? { title } : {}), items: out, ...(common ? { commonFeatures: common } : {}) };
}

function validateBarChart(p) {
  const title = optionalText(p.title);
  const unit = requiredText(p.unit);
  const xLabel = optionalText(p.xLabel);
  const yLabel = optionalText(p.yLabel);
  const bars = boundedArray(p.bars, 2, 6);
  if (title === INVALID || !unit || xLabel === INVALID || yLabel === INVALID || !bars) return null;
  const out = [];
  for (const b of bars) {
    const r = asRecord(b);
    const label = requiredText(r?.label);
    const description = optionalText(r?.description);
    const hl = optionalFlag(r?.highlighted);
    if (!r || !label || typeof r.value !== "number" || !Number.isFinite(r.value) || description === INVALID || hl === INVALID) return null;
    out.push({ label, value: r.value, ...(description ? { description } : {}), ...(hl ? { highlighted: true } : {}) });
  }
  return { type: "bar_chart", ...(title ? { title } : {}), unit, ...(xLabel ? { xLabel } : {}), ...(yLabel ? { yLabel } : {}), bars: keepSingleHighlight(out) };
}

function validateConceptMap(p) {
  const title = optionalText(p.title);
  const center = requiredText(p.centerConcept);
  const nodes = boundedArray(p.nodes, 3, 8);
  const conns = boundedArray(p.connections, 2, 10);
  if (title === INVALID || !center || !nodes || !conns) return null;
  const outNodes = [];
  for (const n of nodes) {
    const r = asRecord(n);
    const id = requiredText(r?.id);
    const label = requiredText(r?.label);
    const level = r?.level;
    const hl = optionalFlag(r?.highlighted);
    if (!r || !id || !label || (level != null && level !== 1 && level !== 2) || hl === INVALID) return null;
    outNodes.push({ id, label, ...(level === 1 || level === 2 ? { level } : {}), ...(hl ? { highlighted: true } : {}) });
  }
  const outConns = [];
  for (const c of conns) {
    const r = asRecord(c);
    const from = requiredText(r?.from);
    const to = requiredText(r?.to);
    const relationship = requiredText(r?.relationship);
    if (!r || !from || !to || !relationship) return null;
    outConns.push({ from, to, relationship });
  }
  return { type: "concept_map", ...(title ? { title } : {}), centerConcept: center, nodes: keepSingleHighlight(outNodes), connections: outConns };
}

function validateLoop(p) {
  const title = optionalText(p.title);
  const centerLabel = optionalText(p.centerLabel);
  const stages = boundedArray(p.stages, 3, 6);
  if (title === INVALID || centerLabel === INVALID || !stages) return null;
  const out = [];
  for (const st of stages) {
    const r = asRecord(st);
    const label = requiredText(r?.label);
    const description = optionalText(r?.description);
    const hl = optionalFlag(r?.highlighted);
    if (!r || !label || description === INVALID || hl === INVALID) return null;
    out.push({ label, ...(description ? { description } : {}), ...(hl ? { highlighted: true } : {}) });
  }
  return { type: "loop", ...(title ? { title } : {}), ...(centerLabel ? { centerLabel } : {}), stages: keepSingleHighlight(out) };
}

function validateReveal(p) {
  const title = optionalText(p.title);
  const items = boundedArray(p.items, 1, 4);
  if (title === INVALID || !items) return null;
  const out = [];
  for (const it of items) {
    const r = asRecord(it);
    const label = requiredText(r?.label);
    const content = requiredText(r?.content);
    if (!r || !label || !content) return null;
    out.push({ label, content });
  }
  return { type: "reveal", ...(title ? { title } : {}), items: out };
}

function validateSlider(p) {
  const title = optionalText(p.title);
  const inputLabel = requiredText(p.inputLabel);
  const outputLabel = requiredText(p.outputLabel);
  const unit = optionalText(p.unit);
  const stops = boundedArray(p.stops, 3, 7);
  if (title === INVALID || !inputLabel || !outputLabel || unit === INVALID || !stops) return null;
  const out = [];
  for (const st of stops) {
    const r = asRecord(st);
    const label = optionalText(r?.label);
    const output = requiredText(r?.output);
    const description = optionalText(r?.description);
    if (!r || typeof r.value !== "number" || !Number.isFinite(r.value) || !output || label === INVALID || description === INVALID) return null;
    out.push({ value: r.value, ...(label ? { label } : {}), output, ...(description ? { description } : {}) });
  }
  return { type: "slider", ...(title ? { title } : {}), inputLabel, outputLabel, ...(unit ? { unit } : {}), stops: out };
}

/** Returns a normalized visual or null. */
export function validateVoiceVisualPayload(payload) {
  const p = asRecord(payload);
  if (!p || !VOICE_VISUAL_TYPES.includes(p.type)) return null;
  switch (p.type) {
    case "flowchart":
      return validateFlowchart(p);
    case "timeline":
      return validateTimeline(p);
    case "comparison":
      return validateComparison(p);
    case "bar_chart":
      return validateBarChart(p);
    case "concept_map":
      return validateConceptMap(p);
    case "loop":
      return validateLoop(p);
    case "reveal":
      return validateReveal(p);
    case "slider":
      return validateSlider(p);
    default:
      return null;
  }
}

export function namedValuesToRecord(list) {
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

/** Port of toVisualComponentProps: validated visual -> component props ({data}). */
export function toVisualComponentProps(type, visual) {
  if (visual.type !== type) throw new Error(`Visual type mismatch: expected ${type}, got ${visual.type}`);
  const { type: _t, title: _title, ...rest } = visual;
  let data = rest;
  switch (visual.type) {
    case "timeline":
      data = { ...rest, events: visual.events.map((e, i) => ({ id: `event-${i}`, ...e })) };
      break;
    case "comparison":
      data = {
        ...rest,
        items: visual.items.map((it, i) => ({ id: `item-${i}`, label: it.label, attributes: namedValuesToRecord(it.attributes), ...(it.details ? { details: namedValuesToRecord(it.details) } : {}) })),
      };
      break;
    case "bar_chart":
      data = { ...rest, bars: visual.bars.map((b, i) => ({ id: `bar-${i}`, ...b })) };
      break;
    case "loop":
      data = { ...rest, stages: visual.stages.map((st, i) => ({ id: `stage-${i}`, ...st })) };
      break;
    case "reveal":
      return { data, startCollapsed: true };
  }
  return { data };
}

// ============================================================ board

export const BOARD_ITEM_WIDTH = 720;
export const BOARD_GAP = 56;
export const BOARD_DEFAULT_HEIGHT = 320;

export const initialBoardState = Object.freeze({ items: [], focusSeq: 0, focusItemId: null });

/** Port of reducer `bt`. Actions: add-item, update-item, report-height, clear. */
export function boardReducer(state, action) {
  switch (action.type) {
    case "add-item":
      return { ...state, items: [...state.items, action.item], focusSeq: state.focusSeq + 1, focusItemId: action.item.id };
    case "update-item": {
      const i = state.items.findIndex((it) => it.id === action.itemId);
      if (i < 0) return state;
      const items = [...state.items];
      items[i] = { ...items[i], title: action.item.title, payload: action.item.payload };
      return { ...state, items, focusSeq: state.focusSeq + 1, focusItemId: action.itemId };
    }
    case "report-height": {
      const i = state.items.findIndex((it) => it.id === action.itemId);
      if (i < 0 || !Number.isFinite(action.height) || action.height <= 0) return state;
      const it = state.items[i];
      if (it.measuredHeight !== null && Math.abs(it.measuredHeight - action.height) < 2) return state;
      const items = [...state.items];
      items[i] = { ...it, measuredHeight: action.height };
      return { ...state, items };
    }
    case "clear":
      return state.items.length === 0 && state.focusItemId === null ? state : initialBoardState;
    default:
      return state;
  }
}

/** Port of `ri`: stacked vertical layout. */
export function boardItemPositions(items) {
  let y = 0;
  return items.map((it) => {
    const p = { x: 0, y };
    y += (it.measuredHeight ?? BOARD_DEFAULT_HEIGHT) + BOARD_GAP;
    return p;
  });
}

let fallbackId = 0;
function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  fallbackId += 1;
  return `item-${fallbackId}`;
}

/** Imperative board API (port of hook `va` without React). */
export function createBoard({ onChange, isKnownComponent = isInteractiveComponent } = {}) {
  let state = initialBoardState;
  const dispatch = (action) => {
    const next = boardReducer(state, action);
    if (next !== state) {
      state = next;
      onChange?.(state, action);
    }
  };
  const assertRenderable = (item) => {
    if (item.payload.kind === "visual" && !isKnownComponent(item.payload.componentName)) throw new Error(`Unknown interactive component: ${item.payload.componentName}`);
  };
  return {
    get state() {
      return state;
    },
    dispatch,
    addItem(item) {
      assertRenderable(item);
      const id = uuid();
      dispatch({ type: "add-item", item: { id, title: item.title, payload: item.payload, measuredHeight: null } });
      return id;
    },
    updateItem(itemId, item) {
      assertRenderable(item);
      if (!state.items.some((it) => it.id === itemId)) return false;
      dispatch({ type: "update-item", itemId, item });
      return true;
    },
    getBoardState() {
      return { items: state.items.map((it) => ({ id: it.id, title: it.title, kind: it.payload.kind })) };
    },
    clear() {
      dispatch({ type: "clear" });
    },
    reportItemHeight(itemId, height) {
      dispatch({ type: "report-height", itemId, height });
    },
  };
}

// ============================================================ tool handlers

export const BOARD_TOOL_NAMES = Object.freeze({
  getBoardState: "get_board_state",
  showText: "show_text",
  showLessonVisual: "show_lesson_visual",
  showVisual: "show_visual",
  searchImage: "search_image",
});
const BOARD_TOOLS = new Set(Object.values(BOARD_TOOL_NAMES));

function nonEmpty(v) {
  return typeof v !== "string" ? null : v.trim() || null;
}

/** Port of `ss`: keep the first `maxWords` whitespace-delimited words. */
export function truncateWords(text, maxWords) {
  const words = Array.from(text.matchAll(/\S+/gu));
  if (words.length <= maxWords) return text;
  const last = words[maxWords - 1];
  return text.slice(0, (last.index ?? 0) + last[0].length).trim();
}

const invalidArguments = () => ({ ok: false, error: "invalid_arguments" });

function stripTitle(params) {
  const out = { ...params };
  delete out.title;
  const data = asRecord(out.data);
  if (!data) return out;
  const d = { ...data };
  delete d.title;
  return { ...out, data: d };
}

/**
 * Port of `Na(getBoard, getLessonVisuals, searchImage)`.
 * Returns async (call:{name,args}) => {ok:true,...} | {ok:false,error}.
 */
export function createBoardToolHandler(getBoard, getLessonVisuals = () => [], searchImage) {
  return async (call) => {
    if (!BOARD_TOOLS.has(call.name)) return { ok: false, error: "unknown_tool" };
    const board = getBoard();
    if (!board) return { ok: false, error: "board_unavailable" };
    const args = asRecord(call.args);
    if (!args) return invalidArguments();
    try {
      if (call.name === BOARD_TOOL_NAMES.getBoardState) return { ok: true, board: board.getBoardState() };
      if (call.name === BOARD_TOOL_NAMES.showLessonVisual) {
        const id = nonEmpty(args.visual_id);
        if (!id) return invalidArguments();
        const v = getLessonVisuals().find((x) => x.id === id);
        if (!v) return { ok: false, error: "unknown_lesson_visual" };
        if (v.kind === "image") {
          return { ok: true, item_id: board.addItem({ title: v.title, payload: { kind: "image", url: v.url, alt: v.alt, ...(v.captionMarkdown ? { captionMarkdown: v.captionMarkdown } : {}) } }), summary: `lesson image "${v.title}"` };
        }
        return { ok: true, item_id: board.addItem({ title: v.title, payload: { kind: "visual", componentName: v.componentName, params: stripTitle(v.params) } }), summary: `lesson visual "${v.title}"` };
      }
      if (call.name === BOARD_TOOL_NAMES.showText) {
        const title = nonEmpty(args.title);
        const markdown = nonEmpty(args.markdown);
        if (!title || !markdown) return invalidArguments();
        const t = truncateWords(title, 8);
        return { ok: true, item_id: board.addItem({ title: t, payload: { kind: "text", markdown: truncateWords(markdown, 80) } }), summary: `text "${t}"` };
      }
      if (call.name === BOARD_TOOL_NAMES.searchImage) {
        if (!searchImage) return { ok: false, error: "tool_unavailable" };
        const query = nonEmpty(args.query);
        const subject = nonEmpty(args.subject);
        const title = nonEmpty(args.title);
        if (!query || !subject || !title) return invalidArguments();
        const img = await searchImage({ query, subject });
        if (!img) return { ok: false, error: "no_image_found" };
        const t = truncateWords(title, 8);
        return { ok: true, item_id: board.addItem({ title: t, payload: { kind: "image", url: img.url, alt: subject, ...(img.captionMarkdown ? { captionMarkdown: img.captionMarkdown } : {}) } }), summary: `photo "${t}"` };
      }
      // show_visual
      const visual = validateVoiceVisualPayload(args.visual);
      if (!visual) return invalidArguments();
      const replaces = args.replaces_item_id === undefined || args.replaces_item_id === null ? undefined : nonEmpty(args.replaces_item_id);
      if (replaces === null) return invalidArguments();
      const title = visual.title ?? VOICE_VISUAL_DEFAULT_TITLES[visual.type];
      const item = { title, payload: { kind: "visual", componentName: VOICE_VISUAL_COMPONENTS[visual.type], params: toVisualComponentProps(visual.type, visual) } };
      const label = visual.type.replaceAll("_", " ");
      if (replaces) return board.updateItem(replaces, item) ? { ok: true, item_id: replaces, summary: `updated ${label} "${title}"` } : { ok: false, error: "unknown_item" };
      return { ok: true, item_id: board.addItem(item), summary: `${label} "${title}"` };
    } catch {
      return { ok: false, error: "execution_failed" };
    }
  };
}
