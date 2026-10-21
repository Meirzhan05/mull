import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLatexDelimiters as n,
  replaceSourceMarkers,
  sourceMarkerHoldIndex,
  sourceCitationContent,
  parseKeywordsInText,
  withoutPageMarkers,
  parseBlocks,
  parseInline,
  prepareMarkdown,
  visibleText,
  expandFractions,
} from "../src/markdown.js";

test("normalizeLatexDelimiters: \\( \\) and \\[ \\] become $$…$$", () => {
  assert.equal(n("a \\(x^2\\) b"), "a $$x^2$$ b");
  assert.equal(n("\\[\\sum_i x_i\\]"), "$$\\sum_i x_i$$");
  assert.equal(n("unclosed \\(x"), "unclosed \\(x");
  assert.equal(n("\\\\(not math)"), "\\\\(not math)");
});

test("normalizeLatexDelimiters: code spans, fences and existing $$ are untouched", () => {
  assert.equal(n("`\\(x\\)` and \\(y\\)"), "`\\(x\\)` and $$y$$");
  assert.equal(n("```\n\\(x\\)\n```\n\\(y\\)"), "```\n\\(x\\)\n```\n$$y$$");
  assert.equal(n("~~~\n$a+b$\n~~~\n$a+b$"), "~~~\n$a+b$\n~~~\n$$a+b$$");
  assert.equal(n("$$x$$ and $$y"), "$$x$$ and $$y");
});

test("normalizeLatexDelimiters: single-dollar heuristics", () => {
  assert.equal(n("let $x$ be"), "let $$x$$ be");
  assert.equal(n("$a = b + c$"), "$$a = b + c$$");
  assert.equal(n("$\\alpha$"), "$$\\alpha$$");
  assert.equal(n("costs $5 and $10"), "costs $5 and $10");
  assert.equal(n("$ x$"), "$ x$", "leading space is not math");
  assert.equal(n("escaped \\$x$"), "escaped \\$x$");
  assert.equal(n("f(x) is $f(x)$"), "f(x) is $$f(x)$$");
});

test("replaceSourceMarkers handles [[SOURCE:id]], [SOURCE:id] and grouped markers", () => {
  const map = { a: "[S1]", b: "[S2]" };
  assert.equal(replaceSourceMarkers("x [[SOURCE:a]] y", (id) => map[id]), "x [S1] y");
  assert.equal(replaceSourceMarkers("x [SOURCE:b] y", (id) => map[id]), "x [S2] y");
  assert.equal(replaceSourceMarkers("x [[SOURCE:a], [SOURCE:b]] y", (id) => map[id]), "x [S1], [S2] y");
  assert.equal(replaceSourceMarkers("x [[SOURCE:zzz]] y", (id) => map[id]), "x  y");
});

test("sourceMarkerHoldIndex holds back partial markers", () => {
  assert.equal(sourceMarkerHoldIndex("done [[SOURCE:a]] ok"), -1);
  assert.equal(sourceMarkerHoldIndex("text [[SOU"), 5);
  assert.equal(sourceMarkerHoldIndex("text ["), 5);
  assert.equal(sourceMarkerHoldIndex("text [[SOURCE:abc"), 5);
  assert.equal(sourceMarkerHoldIndex("a [link] b"), -1);
});

test("sourceCitationContent numbers quoted passages, dedupes and sorts groups", () => {
  const cites = [{ passageId: "p1", quote: "q1" }, { passageId: "nq" }, { passageId: "p2", quote: "q2" }];
  // the shipped regex also swallows the whitespace before a citation group
  assert.equal(sourceCitationContent("A [[SOURCE:p2]] B [[SOURCE:p1]].", cites, "c"), "A[2](#c-2) B[1](#c-1).");
  assert.equal(sourceCitationContent("A [[SOURCE:p2], [SOURCE:p1], [SOURCE:p2]]", cites, "c"), "A[1](#c-1)[2](#c-2)");
  assert.equal(sourceCitationContent("A [[SOURCE:nq]] B", cites, "c"), "A  B", "unquoted citations are dropped");
  assert.equal(sourceCitationContent("streaming [[SOURCE:p", cites, "c"), "streaming ");
});

test("parseKeywordsInText: whole word, case-insensitive, longest first, no overlaps", () => {
  const kws = [{ term: "attention", definition: "d1" }, { term: "attention head", definition: "d2" }, { term: "token", definition: "d3" }];
  const out = parseKeywordsInText("Each Attention head reads tokens; attention is a token mixer.", kws);
  const hits = out.filter((x) => typeof x !== "string");
  assert.deepEqual(hits.map((h) => [h.term, h.matchedText]), [["attention head", "Attention head"], ["attention", "attention"], ["token", "token"]]);
  assert.equal(out.map((x) => (typeof x === "string" ? x : x.matchedText)).join(""), "Each Attention head reads tokens; attention is a token mixer.");
  assert.deepEqual(parseKeywordsInText("plain", []), ["plain"]);
});

test("withoutPageMarkers strips <!-- page N -->", () => {
  assert.equal(withoutPageMarkers("<!-- page 2 -->\nHello"), "Hello");
});

test("parseBlocks: headings, lists, quotes, code, hr, paragraphs", () => {
  const blocks = parseBlocks("# Title\n\nPara one\ncontinues\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```js\nconst a = 1;\n```\n\n---");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "list", "list", "blockquote", "code", "hr"]);
  assert.equal(blocks[1].text, "Para one\ncontinues");
  assert.deepEqual(blocks[2].items, ["a", "b"]);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[5].lang, "js");
});

test("parseInline: placeholders are atomic, underscores inside them do not italicise", () => {
  const toks = parseInline("A **b** _c_ `d` $$e$$ [f](https://x.test) %%%INTERACTIVE_12%%% snake_case_word");
  assert.deepEqual(toks.map((t) => t.type), ["text", "strong", "text", "em", "text", "code", "text", "math", "text", "link", "text", "placeholder", "text"]);
  assert.equal(toks.find((t) => t.type === "placeholder").key, "%%%INTERACTIVE_12%%%");
  assert.equal(toks[toks.length - 1].value, " snake_case_word");
});

test("prepareMarkdown: latex first, then markers -> placeholders, then blocks", () => {
  const { blocks, placeholderMap } = prepareMarkdown("Intro \\(x\\)\n\n{{interactive:lesson-stepper data='{\"steps\":[{\"text\":\"a\"}]}'}}\n\nEnd", { warn: () => {} });
  assert.equal(placeholderMap.size, 1);
  assert.deepEqual(blocks.map((b) => b.text), ["Intro $$x$$", "%%%INTERACTIVE_0%%%", "End"]);
});

test("visibleText in chat mode during streaming hides partial markers", () => {
  const s = "Answer.\n\n{{interactive:lesson-stepper data='{\"steps\":[";
  assert.equal(visibleText(s, { rejectInvalidEmbeddedContent: true, isContentStreaming: true }), "Answer.\n\n");
});

test("expandFractions handles nested braces", () => {
  assert.equal(expandFractions("\\frac{a}{\\frac{b}{c}}"), "(a)/((b)/(c))");
});
