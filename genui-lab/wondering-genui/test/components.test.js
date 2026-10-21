import { test } from "node:test";
import assert from "node:assert/strict";
import { INTERACTIVE_COMPONENT_NAMES, INTERACTIVE_COMPONENTS, IMPLEMENTED_COMPONENTS, getInteractiveComponent, isImplemented } from "../src/components/registry.js";
import { normalizeLessonStepper, normalizeWorkedExample, normalizeLessonReveal, normalizeCompareToggle, normalizeInputOutputSlider, normalizeLessonTable, normalizeWonderingLens } from "../src/components/lesson.js";
import { normalizeVisualList, normalizeVisualCards, normalizeStatBars, normalizeVenn, normalizeTransform, normalizeQuadrant, formatWithUnit } from "../src/components/visual.js";
import { layoutFlowchart, niceScale, layoutConceptMap, attributeKeys } from "../src/components/dataviz.js";
import { SAMPLE_LESSON } from "../src/sample-lesson.js";
import { findInteractiveMarkers } from "../src/markers.js";

test("registry: 100 unique names, required widgets implemented, rest are placeholders", () => {
  assert.equal(INTERACTIVE_COMPONENT_NAMES.length, 100);
  assert.equal(new Set(INTERACTIVE_COMPONENT_NAMES).size, 100);
  const required = ["lesson-stepper", "lesson-stepper-worked-example", "lesson-reveal", "lesson-compare-toggle", "lesson-input-output-slider", "lesson-table", "wondering-lens", "visual-list", "visual-cards", "visual-stat-bars", "visual-venn", "visual-transform", "visual-quadrant", "flowchart-visualization", "timeline-visualization", "bar-chart-visualization", "concept-map-visualization", "cycle-visualization", "comparison-visualization"];
  for (const name of required) assert.ok(isImplemented(name), name);
  for (const name of Object.keys(IMPLEMENTED_COMPONENTS)) assert.ok(INTERACTIVE_COMPONENT_NAMES.includes(name), name);
  assert.equal(INTERACTIVE_COMPONENTS["pie-chart-visualization"].isPlaceholder, true);
  assert.equal(INTERACTIVE_COMPONENTS["flowchart-visualization-d3"], INTERACTIVE_COMPONENTS["flowchart-visualization"]);
  assert.equal(getInteractiveComponent("toString"), undefined, "prototype keys are not components");
  assert.equal(getInteractiveComponent("nope"), undefined);
});

test("lesson-stepper normalizer: data or spread props, description alias, default title", () => {
  assert.deepEqual(normalizeLessonStepper({ data: { steps: [{ label: " A ", description: "d" }, { label: "" }, {}] } }), { title: "Step-by-step", steps: [{ label: "A", text: "d" }] });
  assert.equal(normalizeLessonStepper({ title: "Spread", steps: [{ text: "t" }], data: { title: "ignored" } }).title, "Spread");
  assert.equal(normalizeLessonStepper({ data: "not an object" }).steps.length, 0);
});

test("worked example + reveal + compare + lens normalizers", () => {
  const we = normalizeWorkedExample({ data: { context: "c", steps: [{ label: "s", example: "e", hints: ["h", 3], image: { src: "/x.png" } }] } });
  assert.equal(we.title, "Worked Example");
  assert.deepEqual(we.steps[0].hints, ["h", "3"]);
  assert.deepEqual(we.steps[0].image, { src: "/x.png", alt: "" });
  const rv = normalizeLessonReveal({ data: { items: [{ label: "a", text: "t" }, { description: "d" }, { label: 5 }] } });
  assert.deepEqual(rv.items, [{ label: "a", content: "t" }, { label: undefined, content: "d" }]);
  assert.equal(rv.title, "Key ideas");
  assert.equal(normalizeCompareToggle({ data: { left: { label: "L", points: ["x"] } } }).right, undefined);
  assert.deepEqual(normalizeCompareToggle({ left: { points: ["a", 1, " "] }, right: { label: "R" } }).left, { label: undefined, points: ["a"] });
  assert.deepEqual(normalizeWonderingLens({ data: { content: "body" } }), { title: undefined, body: "body" });
});

test("slider normalizer: defaults, value falls back to index+1, output|description alias", () => {
  const s = normalizeInputOutputSlider({ data: { stops: [{ label: "low", description: "d" }, { value: 10, output: "o" }, null, {}] } });
  assert.equal(s.title, "Input to Output");
  assert.equal(s.inputLabel, "Input");
  assert.equal(s.outputLabel, "Output");
  assert.deepEqual(s.stops, [{ value: 1, label: "low", output: "d", description: "d" }, { value: 10, label: undefined, output: "o", description: undefined }]);
});

test("table normalizer: <=4 columns, <=6 rows, N/A padding, default column names", () => {
  const t = normalizeLessonTable({ data: { columns: ["a", "b", "c", "d", "e"], rows: Array.from({ length: 8 }, (_, i) => [i, "x"]) } });
  assert.equal(t.columns.length, 4);
  assert.equal(t.rows.length, 6);
  assert.deepEqual(t.rows[0], ["0", "x", "N/A", "N/A"]);
  assert.deepEqual(normalizeLessonTable({ rows: [["a", "b"]] }).columns, ["Column 1", "Column 2"]);
});

test("visual normalizers", () => {
  assert.equal(normalizeVisualList({ data: { steps: ["a", "b"] } }).variant, "stepper");
  assert.equal(normalizeVisualList({ data: { steps: ["a", "b"] } }).horizontal, true);
  const cl = normalizeVisualList({ data: { variant: "checklist", items: [{ text: "x", status: "Done" }, { label: "y" }] } });
  assert.deepEqual(cl.items.map((i) => i.checked), [true, false]);
  assert.deepEqual(normalizeVisualCards({ data: { cards: [{ label: "L", text: "T", points: ["p"], items: ["i"] }, {}] } }).cards, [{ title: "L", category: undefined, description: "T", items: ["i", "p"], tone: "secondary" }]);
  assert.equal(normalizeStatBars({ data: { items: [{ label: "a", value: 5 }, { label: "b", value: 20 }] } }).scaleMax, 20);
  assert.equal(normalizeStatBars({ data: { items: [{ label: "a", value: 5, max: 100 }, { label: "", value: 2 }] } }).scaleMax, 100);
  assert.equal(normalizeVenn({ data: { onlyLeft: ["x"] } }).sharedHeading, "A ∩ B");
  assert.deepEqual(normalizeTransform({ data: { before: { text: "a" }, after: { items: ["b"] }, changes: ["c"] } }).after.items, ["b", "c"]);
  assert.deepEqual([...normalizeQuadrant({ data: { quadrants: [{ label: "1" }, { label: "2", position: "bottom-right" }] } }).byPosition.keys()], ["top-left", "bottom-right"]);
  assert.equal(formatWithUnit(-5, "$"), "-$5");
  assert.equal(formatWithUnit(5, "%"), "5%");
  assert.equal(formatWithUnit(5, "ms"), "5 ms");
});

test("layoutFlowchart: ranks follow edges, back edges detected, caps and filtering", () => {
  const data = {
    nodes: [
      { id: "s", label: "Start", type: "start" },
      { id: "a", label: "A", type: "process" },
      { id: "d", label: "D?", type: "decision" },
      { id: "e", label: "End", type: "end" },
      { id: "s", label: "dup" },
      { id: "", label: "bad" },
    ],
    connections: [{ from: "s", to: "a" }, { from: "a", to: "d" }, { from: "d", to: "e", label: "yes" }, { from: "d", to: "a", label: "no" }, { from: "a", to: "ghost" }],
  };
  const l = layoutFlowchart(data);
  assert.equal(l.nodes.length, 4);
  assert.equal(l.edges.length, 4);
  const rank = Object.fromEntries(l.nodes.map((n) => [n.id, n.rank]));
  assert.deepEqual(rank, { s: 0, a: 1, d: 2, e: 3 });
  assert.deepEqual(l.edges.map((e) => e.back), [false, false, false, true]);
  const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.ok(byId.s.y < byId.a.y && byId.a.y < byId.d.y);
  assert.deepEqual([byId.d.width, byId.d.height], [116, 116]);
  for (const n of l.nodes) assert.ok(n.x >= 0 && n.x + n.width <= l.width && n.y + n.height <= l.height);
  const big = layoutFlowchart({ nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, type: "process" })), connections: [] });
  assert.equal(big.nodes.length, 8);
});

test("niceScale matches the shipped tick logic", () => {
  assert.deepEqual(niceScale(0, 41), { min: 0, max: 60, ticks: [0, 20, 40, 60] });
  assert.deepEqual(niceScale(0, 1), { min: 0, max: 1, ticks: [0, 0.5, 1] });
  assert.deepEqual(niceScale(0, 100).ticks, [0, 50, 100]);
  assert.deepEqual(niceScale(5, 5).min, 0);
});

test("concept map layout fits every node inside the viewBox", () => {
  const l = layoutConceptMap({ centerConcept: "C", nodes: [{ id: "a", label: "Alpha", level: 1 }, { id: "b", label: "Beta", level: 1 }, { id: "c", label: "Gamma long label", level: 2 }], connections: [{ from: "c", to: "a", relationship: "r" }] });
  for (const p of l.positions.values()) {
    assert.ok(p.x - p.box.width / 2 >= 0 && p.x + p.box.width / 2 <= l.width);
    assert.ok(p.y - p.box.height / 2 >= 0 && p.y + p.box.height / 2 <= l.height);
  }
  assert.deepEqual(attributeKeys([{ attributes: { a: 1 } }, { attributes: [{ name: "b", value: 2 }] }], { z: "Z" }), ["z", "a", "b"]);
});

test("sample lesson: every marker parses and resolves (except the deliberate edge cases)", () => {
  assert.equal(SAMPLE_LESSON.pages.length, 7);
  const seen = new Set();
  for (const page of SAMPLE_LESSON.pages.slice(0, 6)) {
    for (const m of findInteractiveMarkers(page.content)) {
      assert.ok(m.isValid, `${page.heading}: ${m.name} invalid`);
      assert.ok(getInteractiveComponent(m.name), m.name);
      seen.add(m.name);
    }
  }
  assert.ok(seen.size >= 19, `only ${seen.size} widgets used`);
});
