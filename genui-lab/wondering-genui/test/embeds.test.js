import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBED_TYPE_TO_COMPONENT, EMBED_TYPES, embedToMarker, insertEmbedAfterParagraph, splitParagraphs, applyEmbedEntry, applyEmbedEntries } from "../src/embeds.js";
import { processInteractiveComponents } from "../src/markers.js";
import { isInteractiveComponent } from "../src/components/registry.js";

test("29 snake_case embed types, all mapped to registered components", () => {
  assert.equal(EMBED_TYPES.length, 29);
  for (const [type, name] of Object.entries(EMBED_TYPE_TO_COMPONENT)) {
    assert.match(type, /^[a-z]+(_[a-z]+)*$/);
    assert.ok(isInteractiveComponent(name), `${name} missing from registry`);
  }
  assert.equal(EMBED_TYPE_TO_COMPONENT.loop, "cycle-visualization");
  assert.equal(EMBED_TYPE_TO_COMPONENT.stepper_worked_example, "lesson-stepper-worked-example");
});

test("embedToMarker: strips type, escapes single quotes as \\u0027, round-trips through the parser", () => {
  const embed = { type: "reveal", title: "Don't guess", items: [{ label: "It's", content: "{curly} 'quoted'" }] };
  const marker = embedToMarker({ embed, insertAfterParagraph: 1 });
  assert.ok(marker.startsWith("{{interactive:lesson-reveal data='"));
  assert.ok(!marker.slice("{{interactive:lesson-reveal data='".length, -3).includes("'"), "no raw single quote inside the attribute");
  assert.ok(marker.includes("\\u0027"));
  const { placeholderMap } = processInteractiveComponents(marker, undefined, { warn: () => {} });
  const entry = placeholderMap.get("%%%INTERACTIVE_0%%%");
  assert.equal(entry.componentName, "lesson-reveal");
  assert.deepEqual(entry.params.data, { title: "Don't guess", items: [{ label: "It's", content: "{curly} 'quoted'" }] });
  assert.equal(entry.isValid, true);
});

test("embedToMarker: unknown or missing type -> null; bare embed accepted", () => {
  assert.equal(embedToMarker({ embed: { type: "hologram" } }), null);
  assert.equal(embedToMarker({}), null);
  assert.equal(embedToMarker(null), null);
  assert.equal(embedToMarker({ type: "venn", leftLabel: "A" }), `{{interactive:visual-venn data='{"leftLabel":"A"}'}}`);
});

test("splitParagraphs splits on blank lines (including whitespace-only ones)", () => {
  assert.deepEqual(splitParagraphs("a\n\nb\n  \t\nc\nstill c\n\n\n"), ["a", "b", "c\nstill c"]);
});

test("insertEmbedAfterParagraph: position n, clamped to [0, length]", () => {
  const content = "P0\n\nP1\n\nP2";
  assert.equal(insertEmbedAfterParagraph(content, "M", 0), "M\n\nP0\n\nP1\n\nP2");
  assert.equal(insertEmbedAfterParagraph(content, "M", 1), "P0\n\nM\n\nP1\n\nP2");
  assert.equal(insertEmbedAfterParagraph(content, "M", 3), "P0\n\nP1\n\nP2\n\nM");
  assert.equal(insertEmbedAfterParagraph(content, "M", 99), "P0\n\nP1\n\nP2\n\nM");
  assert.equal(insertEmbedAfterParagraph(content, "M", -4), "M\n\nP0\n\nP1\n\nP2");
});

test("applyEmbedEntry / applyEmbedEntries splice markers into pages", () => {
  const page = { heading: "H", content: "one\n\ntwo" };
  const out = applyEmbedEntry(page, { embed: { type: "stat_bars", items: [{ label: "x", value: 1 }] }, insertAfterParagraph: 1 });
  assert.equal(out.content.split("\n\n")[1].startsWith("{{interactive:visual-stat-bars"), true);
  assert.equal(page.content, "one\n\ntwo", "input page is not mutated");
  assert.equal(applyEmbedEntry(page, { embed: { type: "nope" }, insertAfterParagraph: 0 }), page);
  const pages = applyEmbedEntries([page, { heading: "B", content: "x" }], [{ pageIndex: 1, embed: { type: "wondering_lens", title: "t" }, insertAfterParagraph: 0 }]);
  assert.ok(pages[1].content.startsWith("{{interactive:wondering-lens"));
  assert.equal(pages[0].content, page.content);
});
