import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERACTIVE_MARKER_PREFIX,
  createMarkerRegex,
  parseComponentParams,
  parseValue,
  processInteractiveComponents,
  removeUnrenderableInteractiveMarkers,
  reserveUnknownComponentReport,
  resetUnknownComponentReports,
  trackedUnknownSessionCount,
  findInteractiveMarkers,
  INTERACTIVE_COMPONENT_UNKNOWN,
} from "../src/markers.js";

const quiet = { warn: () => {} };
const matchAll = (s) => [...s.matchAll(createMarkerRegex())];

test("regex: the exact shipped source", () => {
  assert.equal(
    createMarkerRegex().source,
    /\{\{interactive:([^\s}]+)(?:\s+((?:[^}'"]|'[^']*'|"[^"]*")*))\}\}|\{\{interactive:([^\s}]+)\}\}/g.source
  );
});

test("regex: bare marker uses group 3, marker with params uses groups 1+2", () => {
  const [bare] = matchAll("x {{interactive:lesson-stepper}} y");
  assert.equal(bare[1], undefined);
  assert.equal(bare[3], "lesson-stepper");
  const [withParams] = matchAll("{{interactive:movie-script-simulator hasButton=true}}");
  assert.equal(withParams[1], "movie-script-simulator");
  assert.equal(withParams[2], "hasButton=true");
});

test("regex: quoted values may contain spaces and closing braces", () => {
  const src = `{{interactive:wondering-lens title="Hello } world" body='It is }} here'}}`;
  const m = matchAll(src);
  assert.equal(m.length, 1);
  assert.equal(m[0][0], src);
  const { params, isValid } = parseComponentParams(m[0][2]);
  assert.equal(isValid, true);
  assert.deepEqual(params, { title: "Hello } world", body: "It is }} here" });
});

test("regex: data JSON with nested objects inside single quotes", () => {
  const src = `{{interactive:lesson-stepper data='{"title":"Ship it","steps":[{"label":"Read","text":"a}b"}],"meta":{"x":{"y":1}}}'}}`;
  const m = matchAll(`before ${src} after`);
  assert.equal(m.length, 1);
  assert.equal(m[0][0], src);
  const { params, isValid } = parseComponentParams(m[0][2]);
  assert.equal(isValid, true);
  assert.equal(params.data.steps[0].text, "a}b");
  assert.equal(params.data.meta.x.y, 1);
});

test("regex: a space right after the colon is not a marker; adjacent markers both match", () => {
  assert.equal(matchAll("{{interactive: lesson-stepper}}").length, 0);
  assert.equal(matchAll("{{interactive:a}}{{interactive:b x=1}}").length, 2);
});

test("parseValue: JSON literals, numbers, strings", () => {
  assert.deepEqual(parseValue("true"), { value: true, isValid: true });
  assert.deepEqual(parseValue("null"), { value: null, isValid: true });
  assert.deepEqual(parseValue("[1,2]"), { value: [1, 2], isValid: true });
  assert.deepEqual(parseValue("42"), { value: 42, isValid: true });
  assert.deepEqual(parseValue("-0.5"), { value: -0.5, isValid: true });
  assert.deepEqual(parseValue("1.2.3"), { value: "1.2.3", isValid: true });
  assert.deepEqual(parseValue("hello"), { value: "hello", isValid: true });
  assert.deepEqual(parseValue("{bad"), { value: "{bad", isValid: false });
});

test("parseValue: retries JSON after un-escaping \\\"", () => {
  const raw = '{\\"a\\":1}';
  assert.deepEqual(parseValue(raw), { value: { a: 1 }, isValid: true });
});

test("parseComponentParams: data= must be a JSON object", () => {
  assert.equal(parseComponentParams(`data='{"a":1}'`).isValid, true);
  assert.equal(parseComponentParams(`data='[1,2,3]'`).isValid, false);
  assert.equal(parseComponentParams(`data=hello`).isValid, false);
  assert.equal(parseComponentParams(`data=null`).isValid, false);
  assert.equal(parseComponentParams(`data='{"a":}'`).isValid, false);
  // other keys may hold arrays
  assert.deepEqual(parseComponentParams(`items='[1,2]'`), { params: { items: [1, 2] }, isValid: true });
});

test("parseComponentParams: quoted/bare values, numeric coercion, junk invalidates", () => {
  const r = parseComponentParams(`title="Two words" count=3 ratio='0.25' flag=false name=bare`);
  assert.deepEqual(r, { params: { title: "Two words", count: 3, ratio: 0.25, flag: false, name: "bare" }, isValid: true });
  assert.equal(parseComponentParams("a=1 junk b=2").isValid, false);
  assert.equal(parseComponentParams("a=1 trailing").isValid, false);
  assert.deepEqual(parseComponentParams("   "), { params: {}, isValid: true });
});

test("processInteractiveComponents: placeholders, reserved params, stable instance ids", () => {
  const src = [
    `{{interactive:lesson-stepper data='{"steps":[{"text":"a"}]}' instanceId="s1" altText="  Steps  "}}`,
    `{{interactive:lesson-reveal instanceId="s1"}}`,
    `{{interactive:visual-cards}}`,
  ].join("\n\n");
  const { processedContent, placeholderMap } = processInteractiveComponents(src, undefined, quiet);
  assert.equal(processedContent, "%%%INTERACTIVE_0%%%\n\n%%%INTERACTIVE_1%%%\n\n%%%INTERACTIVE_2%%%");
  const e0 = placeholderMap.get("%%%INTERACTIVE_0%%%");
  assert.equal(e0.componentName, "lesson-stepper");
  assert.deepEqual(e0.params, { data: { steps: [{ text: "a" }] } });
  assert.equal(e0.instanceId, "s1");
  assert.equal(e0.altText, "Steps");
  assert.equal(placeholderMap.get("%%%INTERACTIVE_1%%%").instanceId, undefined, "duplicate instanceId is dropped");
  assert.equal(typeof e0.Component, "function");
});

test("processInteractiveComponents: unknown names warn, stay raw on lessons, vanish in chat", () => {
  resetUnknownComponentReports();
  const warnings = [];
  const events = [];
  const opts = { warn: (m) => warnings.push(m), track: (e, p) => events.push([e, p]) };
  const src = "a {{interactive:no-such-widget x=1}} b";
  const ctx = { lessonSessionId: "sess-1" };
  const lesson = processInteractiveComponents(src, ctx, opts);
  assert.equal(lesson.processedContent, src);
  assert.equal(lesson.placeholderMap.size, 0);
  const chat = processInteractiveComponents(src, ctx, { ...opts, rejectInvalidMarkers: true });
  assert.equal(chat.processedContent, "a  b");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /not found in registry, skipping/);
  assert.equal(events.length, 1, "telemetry is deduped per (session, name)");
  assert.equal(events[0][0], INTERACTIVE_COMPONENT_UNKNOWN);
  assert.equal(events[0][1].componentName, "unknown");
  processInteractiveComponents(src, { lessonSessionId: "sess-2" }, opts);
  assert.equal(events.length, 2, "new session reports again");
  processInteractiveComponents(src, undefined, opts);
  assert.equal(events.length, 2, "no experiment context, no telemetry");
});

test("reserveUnknownComponentReport: LRU caps of 100 sessions x 100 names", () => {
  resetUnknownComponentReports();
  for (let i = 0; i < 150; i++) reserveUnknownComponentReport(`s${i}`, "x");
  assert.equal(trackedUnknownSessionCount(), 100);
  assert.equal(reserveUnknownComponentReport("s0", "x"), true, "evicted session reports again");
  for (let i = 0; i < 100; i++) assert.equal(reserveUnknownComponentReport("cap", `n${i}`), true);
  assert.equal(reserveUnknownComponentReport("cap", "n100"), false);
  assert.equal(reserveUnknownComponentReport("cap", "n1"), false);
});

test("rejectInvalidMarkers: invalid markers removed, valid kept; streaming hides everything", () => {
  const src = `ok {{interactive:lesson-table data='[1]'}} and {{interactive:lesson-table data='{"rows":[["a"]]}'}}`;
  const lesson = processInteractiveComponents(src, undefined, quiet);
  assert.equal(lesson.placeholderMap.size, 2, "lesson pages still mount invalid markers");
  const chat = processInteractiveComponents(src, undefined, { ...quiet, rejectInvalidMarkers: true });
  assert.equal(chat.processedContent, "ok  and %%%INTERACTIVE_0%%%");
  const streaming = processInteractiveComponents(src, undefined, { ...quiet, rejectInvalidMarkers: true, isStreaming: true });
  assert.equal(streaming.processedContent, "ok  and ");
  assert.equal(streaming.placeholderMap.size, 0);
});

test("removeUnrenderableInteractiveMarkers trims trailing prefixes only while streaming", () => {
  assert.equal(removeUnrenderableInteractiveMarkers("hi {{inter", true), "hi ");
  assert.equal(removeUnrenderableInteractiveMarkers("hi {", true), "hi ");
  assert.equal(removeUnrenderableInteractiveMarkers("hi {{inter", false), "hi {{inter");
  assert.equal(removeUnrenderableInteractiveMarkers("hi {{interactive:x data='{", false), "hi ");
  assert.equal(removeUnrenderableInteractiveMarkers("a {{interactive:x}} b", false), "a  b");
});

const STREAM_SAMPLE =
  "Attention mixes context.\n\n" +
  `{{interactive:lesson-stepper data='{"title":"Steps","steps":[{"label":"Embed","text":"vectors"},{"label":"Attend","text":"mix"}]}'}}` +
  "\n\nThen we score every token. " +
  `{{interactive:unknown-widget title="x y"}}` +
  " Partial at the end: " +
  `{{interactive:visual-stat-bars data='{"items":[{"label":"a","value":1,"meta":{"k":{"z":2}}}]}'}}` +
  " done.";

test("streaming: no prefix of a sample ever leaks {{interactive text", () => {
  const final = processInteractiveComponents(STREAM_SAMPLE, undefined, { ...quiet, rejectInvalidMarkers: true, isStreaming: true }).processedContent;
  assert.ok(!final.includes("{{"));
  for (let i = 0; i <= STREAM_SAMPLE.length; i++) {
    const prefix = STREAM_SAMPLE.slice(0, i);
    const out = processInteractiveComponents(prefix, undefined, { ...quiet, rejectInvalidMarkers: true, isStreaming: true }).processedContent;
    assert.ok(!out.includes("{{interactive"), `leak at prefix ${i}: ${JSON.stringify(out.slice(-40))}`);
    for (let k = 1; k < INTERACTIVE_MARKER_PREFIX.length; k++) {
      assert.ok(!out.endsWith(INTERACTIVE_MARKER_PREFIX.slice(0, k)), `partial prefix leak at ${i}`);
    }
  }
});

test("streaming: visible prose grows monotonically for marker-free stretches", () => {
  const visibleFinal = processInteractiveComponents(STREAM_SAMPLE.replace(/'\{[^']*\}'/g, "x"), undefined, { ...quiet, rejectInvalidMarkers: true, isStreaming: true }).processedContent;
  const prose = "Attention mixes context.\n\n";
  for (let i = 0; i <= prose.length; i++) {
    const out = processInteractiveComponents(STREAM_SAMPLE.slice(0, i), undefined, { ...quiet, rejectInvalidMarkers: true, isStreaming: true }).processedContent;
    assert.equal(out, prose.slice(0, i));
  }
  assert.ok(visibleFinal.startsWith(prose));
});

test("findInteractiveMarkers lists names and validity", () => {
  const list = findInteractiveMarkers(`{{interactive:a data='[1]'}} {{interactive:b n=2}}`);
  assert.deepEqual(list.map((m) => [m.name, m.isValid]), [["a", false], ["b", true]]);
});
