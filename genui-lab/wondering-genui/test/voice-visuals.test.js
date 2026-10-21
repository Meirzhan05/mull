import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_VISUAL_TYPES,
  VOICE_VISUAL_COMPONENTS,
  validateVoiceVisualPayload as v,
  keepSingleHighlight,
  boundedArray,
  toVisualComponentProps,
  boardReducer,
  initialBoardState,
  boardItemPositions,
  createBoard,
  createBoardToolHandler,
  truncateWords,
} from "../src/voice-visuals.js";
import { isInteractiveComponent } from "../src/components/registry.js";

const nodes = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Node ${i}`, type: "process", ...extra }));
const conns = (n) => Array.from({ length: n }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
const flow = (over = {}) => ({ type: "flowchart", nodes: nodes(3), connections: conns(2), ...over });
const events = (n) => Array.from({ length: n }, (_, i) => ({ date: `${2000 + i}`, label: `E${i}` }));
const attrs = (n) => Array.from({ length: n }, (_, i) => ({ name: `k${i}`, value: `v${i}` }));
const items = (n, a = 1) => Array.from({ length: n }, (_, i) => ({ label: `I${i}`, attributes: attrs(a) }));
const bars = (n) => Array.from({ length: n }, (_, i) => ({ label: `B${i}`, value: i + 1 }));
const stops = (n) => Array.from({ length: n }, (_, i) => ({ value: i, output: `o${i}` }));

test("8 voice visual types map to registered components", () => {
  assert.deepEqual(VOICE_VISUAL_TYPES, ["flowchart", "timeline", "comparison", "bar_chart", "concept_map", "loop", "reveal", "slider"]);
  for (const t of VOICE_VISUAL_TYPES) assert.ok(isInteractiveComponent(VOICE_VISUAL_COMPONENTS[t]));
  assert.equal(v({ type: "pie_chart" }), null);
  assert.equal(v(null), null);
  assert.equal(v([]), null);
});

test("boundedArray: below min is null, above max is truncated (not rejected)", () => {
  assert.equal(boundedArray([1], 2, 3), null);
  assert.equal(boundedArray("x", 0, 3), null);
  assert.deepEqual(boundedArray([1, 2, 3, 4], 2, 3), [1, 2, 3]);
});

test("flowchart: nodes[3..8], connections[2..12], typed nodes", () => {
  assert.ok(v(flow()));
  assert.equal(v(flow({ nodes: nodes(2) })), null);
  assert.equal(v(flow({ connections: conns(1) })), null);
  assert.equal(v(flow({ nodes: nodes(9) })).nodes.length, 8);
  assert.equal(v(flow({ connections: [...conns(2), ...conns(11)] })).connections.length, 12);
  assert.equal(v(flow({ nodes: nodes(3, { type: "subroutine" }) })), null);
  assert.equal(v(flow({ nodes: [{ id: " ", label: "x", type: "start" }, ...nodes(2)] })), null);
  assert.equal(v(flow({ title: 5 })), null, "optional text must be a non-empty string when present");
  assert.equal(v(flow({ nodes: nodes(3, { highlighted: "yes" }) })), null);
  const out = v(flow({ title: "  T  ", connections: [{ from: "n0", to: "n1", label: "go" }, { from: "n1", to: "n2" }] }));
  assert.equal(out.title, "T");
  assert.deepEqual(out.connections[0], { from: "n0", to: "n1", label: "go" });
});

test("timeline: events[3..7] with date+label", () => {
  assert.ok(v({ type: "timeline", events: events(3) }));
  assert.equal(v({ type: "timeline", events: events(2) }), null);
  assert.equal(v({ type: "timeline", events: events(9) }).events.length, 7);
  assert.equal(v({ type: "timeline", events: [{ date: "1", label: "" }, ...events(2)] }), null);
});

test("comparison: items[2..4], attributes[1..6], details[0..6], commonFeatures<=5", () => {
  assert.ok(v({ type: "comparison", items: items(2) }));
  assert.equal(v({ type: "comparison", items: items(1) }), null);
  assert.equal(v({ type: "comparison", items: items(2, 0) }), null);
  assert.equal(v({ type: "comparison", items: items(6) }).items.length, 4);
  assert.equal(v({ type: "comparison", items: items(2, 9) }).items[0].attributes.length, 6);
  assert.equal(v({ type: "comparison", items: items(2), commonFeatures: ["a", "b", "c", "d", "e", "f"] }).commonFeatures.length, 5);
  assert.equal(v({ type: "comparison", items: items(2), commonFeatures: ["a", ""] }), null);
  assert.equal(v({ type: "comparison", items: [{ label: "x", attributes: attrs(1), details: [{ name: "a" }] }, ...items(1)] }), null);
  const withDetails = v({ type: "comparison", items: [{ label: "x", attributes: attrs(1), details: [] }, ...items(1)] });
  assert.ok(withDetails, "empty details array is allowed (min 0)");
});

test("bar_chart: unit required, bars[2..6] with finite numeric values", () => {
  assert.ok(v({ type: "bar_chart", unit: "%", bars: bars(2) }));
  assert.equal(v({ type: "bar_chart", bars: bars(2) }), null);
  assert.equal(v({ type: "bar_chart", unit: " ", bars: bars(2) }), null);
  assert.equal(v({ type: "bar_chart", unit: "%", bars: bars(1) }), null);
  assert.equal(v({ type: "bar_chart", unit: "%", bars: bars(8) }).bars.length, 6);
  assert.equal(v({ type: "bar_chart", unit: "%", bars: [{ label: "a", value: "3" }, ...bars(1)] }), null);
  assert.equal(v({ type: "bar_chart", unit: "%", bars: [{ label: "a", value: Infinity }, ...bars(1)] }), null);
  assert.equal(v({ type: "bar_chart", unit: "%", xLabel: "", bars: bars(2) }), null);
});

test("concept_map: centerConcept, nodes[3..8] level 1|2, connections[2..10] with relationship", () => {
  const base = { type: "concept_map", centerConcept: "C", nodes: [{ id: "a", label: "A", level: 1 }, { id: "b", label: "B" }, { id: "c", label: "C", level: 2 }], connections: [{ from: "a", to: "b", relationship: "r" }, { from: "b", to: "c", relationship: "r" }] };
  const out = v(base);
  assert.ok(out);
  assert.equal(out.nodes[1].level, undefined);
  assert.equal(v({ ...base, centerConcept: "" }), null);
  assert.equal(v({ ...base, nodes: [{ id: "a", label: "A", level: 3 }, ...base.nodes.slice(1)] }), null);
  assert.equal(v({ ...base, connections: [{ from: "a", to: "b" }, ...base.connections] }), null);
  assert.equal(v({ ...base, connections: Array(11).fill(base.connections[0]) }).connections.length, 10);
});

test("loop, reveal, slider bounds", () => {
  const stages = (n) => Array.from({ length: n }, (_, i) => ({ label: `S${i}` }));
  assert.ok(v({ type: "loop", stages: stages(3) }));
  assert.equal(v({ type: "loop", stages: stages(2) }), null);
  assert.equal(v({ type: "loop", stages: stages(7) }).stages.length, 6);
  const rev = (n) => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, content: `C${i}` }));
  assert.ok(v({ type: "reveal", items: rev(1) }));
  assert.equal(v({ type: "reveal", items: [] }), null);
  assert.equal(v({ type: "reveal", items: rev(5) }).items.length, 4);
  assert.equal(v({ type: "reveal", items: [{ label: "x" }] }), null);
  assert.ok(v({ type: "slider", inputLabel: "in", outputLabel: "out", stops: stops(3) }));
  assert.equal(v({ type: "slider", inputLabel: "in", outputLabel: "out", stops: stops(2) }), null);
  assert.equal(v({ type: "slider", inputLabel: "in", outputLabel: "out", stops: stops(9) }).stops.length, 7);
  assert.equal(v({ type: "slider", outputLabel: "out", stops: stops(3) }), null);
  assert.equal(v({ type: "slider", inputLabel: "in", outputLabel: "out", stops: [{ value: "1", output: "x" }, ...stops(2)] }), null);
});

test("keepSingleHighlight keeps only the first highlight", () => {
  const out = keepSingleHighlight([{ a: 1 }, { a: 2, highlighted: true }, { a: 3, highlighted: true }]);
  assert.deepEqual(out, [{ a: 1 }, { a: 2, highlighted: true }, { a: 3 }]);
  const chart = v({ type: "bar_chart", unit: "%", bars: [{ label: "a", value: 1, highlighted: true }, { label: "b", value: 2, highlighted: true }] });
  assert.deepEqual(chart.bars.map((b) => !!b.highlighted), [true, false]);
  assert.equal(v({ type: "loop", stages: [{ label: "a", highlighted: false }, { label: "b" }, { label: "c" }] }).stages[0].highlighted, undefined);
});

test("toVisualComponentProps: ids, {name,value}[] -> records, reveal startCollapsed", () => {
  const cmp = v({ type: "comparison", title: "T", items: [{ label: "x", attributes: [{ name: "Speed", value: "fast" }], details: [{ name: "Note", value: "n" }] }, ...items(1)] });
  const props = toVisualComponentProps("comparison", cmp);
  assert.equal(props.data.title, undefined, "title is lifted out");
  assert.deepEqual(props.data.items[0], { id: "item-0", label: "x", attributes: { Speed: "fast" }, details: { Note: "n" } });
  const tl = toVisualComponentProps("timeline", v({ type: "timeline", events: events(3) }));
  assert.deepEqual(tl.data.events.map((e) => e.id), ["event-0", "event-1", "event-2"]);
  assert.equal(toVisualComponentProps("bar_chart", v({ type: "bar_chart", unit: "x", bars: bars(2) })).data.bars[1].id, "bar-1");
  assert.equal(toVisualComponentProps("loop", v({ type: "loop", stages: [{ label: "a" }, { label: "b" }, { label: "c" }] })).data.stages[2].id, "stage-2");
  assert.deepEqual(toVisualComponentProps("reveal", v({ type: "reveal", items: [{ label: "a", content: "b" }] })), { data: { items: [{ label: "a", content: "b" }] }, startCollapsed: true });
  assert.throws(() => toVisualComponentProps("timeline", cmp), /Visual type mismatch/);
});

test("board reducer: add-item, update-item, report-height, clear", () => {
  const item = { id: "a", title: "A", payload: { kind: "text", markdown: "x" }, measuredHeight: null };
  let s = boardReducer(initialBoardState, { type: "add-item", item });
  assert.equal(s.items.length, 1);
  assert.equal(s.focusItemId, "a");
  assert.equal(s.focusSeq, 1);
  assert.equal(boardReducer(s, { type: "update-item", itemId: "zzz", item }), s);
  s = boardReducer(s, { type: "update-item", itemId: "a", item: { title: "A2", payload: { kind: "text", markdown: "y" } } });
  assert.equal(s.items[0].title, "A2");
  assert.equal(s.focusSeq, 2);
  s = boardReducer(s, { type: "report-height", itemId: "a", height: 200 });
  assert.equal(s.items[0].measuredHeight, 200);
  assert.equal(boardReducer(s, { type: "report-height", itemId: "a", height: 201 }), s, "<2px change ignored");
  assert.equal(boardReducer(s, { type: "report-height", itemId: "a", height: -1 }), s);
  assert.equal(boardReducer(s, { type: "report-height", itemId: "nope", height: 50 }), s);
  assert.deepEqual(boardReducer(s, { type: "clear" }), initialBoardState);
  assert.equal(boardReducer(initialBoardState, { type: "clear" }), initialBoardState);
});

test("boardItemPositions stacks items with gap 56 and default height 320", () => {
  assert.deepEqual(boardItemPositions([{ measuredHeight: null }, { measuredHeight: 100 }, { measuredHeight: 10 }]), [{ x: 0, y: 0 }, { x: 0, y: 376 }, { x: 0, y: 532 }]);
});

test("truncateWords keeps the first N words", () => {
  assert.equal(truncateWords("one two three", 5), "one two three");
  assert.equal(truncateWords("a b c d e f g h i j", 8), "a b c d e f g h");
});

test("tool handlers: show_text / show_visual / get_board_state and error codes", async () => {
  const board = createBoard();
  const lessonVisuals = [{ id: "lv1", kind: "visual", title: "Steps", componentName: "lesson-stepper", params: { title: "drop", data: { title: "drop", steps: [{ text: "a" }] } } }];
  const handle = createBoardToolHandler(() => board, () => lessonVisuals);
  assert.deepEqual(await handle({ name: "make_coffee", args: {} }), { ok: false, error: "unknown_tool" });
  assert.deepEqual(await createBoardToolHandler(() => null)({ name: "show_text", args: {} }), { ok: false, error: "board_unavailable" });
  assert.deepEqual(await handle({ name: "show_text", args: "nope" }), { ok: false, error: "invalid_arguments" });
  assert.deepEqual(await handle({ name: "show_text", args: { title: "x" } }), { ok: false, error: "invalid_arguments" });

  const longMd = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const t = await handle({ name: "show_text", args: { title: "one two three four five six seven eight nine ten", markdown: longMd } });
  assert.equal(t.ok, true);
  assert.equal(t.summary, 'text "one two three four five six seven eight"');
  assert.equal(board.state.items[0].payload.markdown.split(" ").length, 80);

  const sv = await handle({ name: "show_visual", args: { visual: { type: "loop", stages: [{ label: "a" }, { label: "b" }, { label: "c" }] } } });
  assert.equal(sv.ok, true);
  assert.equal(sv.summary, 'loop "Cycle"', "default title per type");
  const item = board.state.items.find((i) => i.id === sv.item_id);
  assert.equal(item.payload.componentName, "cycle-visualization");
  assert.equal(item.payload.params.data.stages[0].id, "stage-0");

  assert.deepEqual(await handle({ name: "show_visual", args: { visual: { type: "flowchart", nodes: nodes(2), connections: conns(2) } } }), { ok: false, error: "invalid_arguments" });
  assert.deepEqual(await handle({ name: "show_visual", args: { replaces_item_id: "ghost", visual: { type: "reveal", items: [{ label: "a", content: "b" }] } } }), { ok: false, error: "unknown_item" });
  assert.deepEqual(await handle({ name: "show_visual", args: { replaces_item_id: "  ", visual: { type: "reveal", items: [{ label: "a", content: "b" }] } } }), { ok: false, error: "invalid_arguments" });
  const upd = await handle({ name: "show_visual", args: { replaces_item_id: sv.item_id, visual: { type: "bar_chart", title: "Bars", unit: "%", bars: bars(2) } } });
  assert.deepEqual(upd, { ok: true, item_id: sv.item_id, summary: 'updated bar chart "Bars"' });

  const lv = await handle({ name: "show_lesson_visual", args: { visual_id: "lv1" } });
  assert.equal(lv.ok, true);
  const lvItem = board.state.items.find((i) => i.id === lv.item_id);
  assert.equal(lvItem.payload.params.title, undefined);
  assert.equal(lvItem.payload.params.data.title, undefined);
  assert.deepEqual(await handle({ name: "show_lesson_visual", args: { visual_id: "nope" } }), { ok: false, error: "unknown_lesson_visual" });
  assert.deepEqual(await handle({ name: "search_image", args: { query: "q", subject: "s", title: "t" } }), { ok: false, error: "tool_unavailable" });

  const state = await handle({ name: "get_board_state", args: {} });
  assert.equal(state.ok, true);
  assert.deepEqual(state.board.items.map((i) => i.kind), ["text", "visual", "visual"]);
  assert.equal(state.board.items[1].title, "Bars");
});

test("createBoard refuses visuals with unknown component names", () => {
  const board = createBoard();
  assert.throws(() => board.addItem({ title: "x", payload: { kind: "visual", componentName: "nope", params: {} } }), /Unknown interactive component/);
});
