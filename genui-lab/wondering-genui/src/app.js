// Demo shell: (a) lesson page, (b) simulated lesson chat over mock SSE,
// (c) voice-tutor board driven by mock tool calls, (d) FSRS practice session.
// Everything is local; nothing here performs a network request.

import { SAMPLE_LESSON, SAMPLE_PRACTICES } from "./sample-lesson.js";
import { renderMarkdown, renderSourceGroundedAnswer, renderInteractiveEntry } from "./markdown.js";
import { getInteractiveComponent } from "./components/registry.js";
import { h, clear } from "./components/dom.js";
import * as sse from "./sse.js";
import { embedToMarker } from "./embeds.js";
import { createBoard, createBoardToolHandler, boardItemPositions } from "./voice-visuals.js";
import { fsrs, createEmptyCard, Rating, RATING_NAMES, STATE_NAMES, ratingFromCorrect } from "./fsrs.js";
import { validatePracticeAnswer, splitClozeQuestion, parseMCQOptions } from "./practice.js";

// ---------------------------------------------------------------- shared

const telemetry = [];
function track(event, props) {
  telemetry.push({ event, props, at: new Date() });
  renderTelemetry();
}

let toastTimer;
function toast(content) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, content);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4200);
}

// A deliberately broken widget, registered only in the demo, to exercise the error boundary.
function DemoCrash() {
  throw new Error("demo-crash always throws");
}
const demoGetComponent = (name) => (name === "demo-crash" ? DemoCrash : getInteractiveComponent(name));

const keywords = SAMPLE_LESSON.keywords.map((k) => ({ term: k.name, definition: k.description }));
const onExplain = (term, definition) => toast([h("b", null, term), " — ", definition]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- tabs

const VIEWS = ["lesson", "chat", "voice", "practice"];
function showView(name) {
  if (!VIEWS.includes(name)) name = "lesson";
  for (const v of VIEWS) document.getElementById(`view-${v}`).hidden = v !== name;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === name)));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

// ================================================================ (a) lesson

let pageIndex = 0;
const lessonView = document.getElementById("view-lesson");
let telemetryList;

function renderLesson() {
  const pages = SAMPLE_LESSON.pages;
  const toc = h(
    "nav",
    { class: "toc", "aria-label": "Pages" },
    h("div", { class: "eyebrow", style: { margin: "0 10px 8px" } }, "Pages"),
    h("ol", null, pages.map((p, i) => h("li", null, h("button", { type: "button", "aria-current": String(i === pageIndex), onClick: () => goPage(i) }, `${i + 1}. ${p.heading}`))))
  );
  const page = pages[pageIndex];
  const body = renderMarkdown(page.content, {
    keywords,
    onExplain,
    track,
    getComponent: demoGetComponent,
    experimentContext: { lessonSessionId: "demo-lesson-session", pageIndex },
  });
  const card = h(
    "article",
    { class: "card page-card" },
    h("div", { class: "w-row-between" }, h("span", { class: "page-count" }, `PAGE ${pageIndex + 1} / ${pages.length}`), h("span", { class: "muted" }, "Highlighted words are keywords — tap one.")),
    h("div", { class: "progress", "aria-hidden": "true" }, h("span", { style: { width: `${((pageIndex + 1) / pages.length) * 100}%` } })),
    h("h2", { class: "page-heading" }, page.heading),
    body,
    h(
      "div",
      { class: "page-nav" },
      h("button", { type: "button", class: "btn", disabled: pageIndex === 0, onClick: () => goPage(pageIndex - 1) }, "← Back"),
      pageIndex < pages.length - 1
        ? h("button", { type: "button", class: "btn btn--primary", onClick: () => goPage(pageIndex + 1) }, "Continue")
        : h("button", { type: "button", class: "btn btn--primary", onClick: () => showView("practice") }, "Practice")
    )
  );
  telemetryList = h("ul", { class: "event-log", "aria-live": "polite" });
  const tel = h("div", { class: "card", style: { marginTop: "20px" } }, h("div", { class: "panel-title" }, "Renderer telemetry"), h("p", { class: "muted", style: { marginTop: 0 } }, "INTERACTIVE_COMPONENT_UNKNOWN is deduped per lesson session (LRU 100×100); render failures come from the error boundary."), telemetryList);
  clear(lessonView).append(
    h("div", { class: "view-head" }, h("div", { class: "eyebrow" }, `Lesson · ${pages.length} pages · generated UI`), h("h1", null, SAMPLE_LESSON.name), h("p", null, SAMPLE_LESSON.hook)),
    h("div", { class: "lesson-layout" }, toc, h("div", null, card, tel))
  );
  renderTelemetry();
}

function renderTelemetry() {
  if (!telemetryList) return;
  telemetryList.replaceChildren(
    ...(telemetry.length
      ? telemetry.map((t) => h("li", null, h("span", { class: "t" }, t.event), " ", JSON.stringify({ requestedName: t.props.requestedName ?? t.props.componentName, page: t.props.pageIndex })))
      : [h("li", null, "No events yet. Open the last page (Renderer edge cases).")])
  );
}

function goPage(i) {
  pageIndex = Math.max(0, Math.min(SAMPLE_LESSON.pages.length - 1, i));
  renderLesson();
  lessonView.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ================================================================ (b) lesson chat

const chatView = document.getElementById("view-chat");
let chatState = sse.createCourseChatState();
let playing = false;
let rawPane, transcript, eventLog, playBtn, speedSel, flagsDl;
const SPEEDS = { slow: 140, normal: 32, fast: 8 };

function buildChatView() {
  transcript = h("div", { class: "chat", "aria-live": "polite" });
  playBtn = h("button", { type: "button", class: "btn btn--primary", onClick: () => playMockChat() }, "Simulate lesson chat");
  speedSel = h("select", { "aria-label": "Playback speed" }, Object.keys(SPEEDS).map((k) => h("option", { value: k, selected: k === "normal" }, k)));
  rawPane = h("pre", { class: "raw-pane", "aria-label": "Raw streamed content" }, "—");
  eventLog = h("ul", { class: "event-log" });
  flagsDl = h("dl", { class: "kv" });
  clear(chatView).append(
    h(
      "div",
      { class: "view-head" },
      h("div", { class: "eyebrow" }, "course-chat · SSE over fetch (mocked)"),
      h("h1", null, "Lesson chat"),
      h("p", null, "Plays a mock stream through the real line parser and reducer. While streaming, the bubble renders with rejectInvalidMarkers + isStreaming, so half-written {{interactive:…}} markers never show. Then embed_progress swaps in the server-sanitized answer with resolved visuals.")
    ),
    h(
      "div",
      { class: "grid-2" },
      h("div", { class: "card" }, h("div", { class: "btn-row", style: { marginBottom: "18px" } }, playBtn, h("label", { class: "speed" }, "Speed", speedSel), h("button", { type: "button", class: "btn btn--small", onClick: resetChat }, "Reset")), transcript),
      h(
        "div",
        { class: "grid-stack", style: { display: "grid", gap: "20px", alignContent: "start" } },
        h("div", { class: "card" }, h("div", { class: "panel-title" }, "Raw stream buffer (what the model sent)"), rawPane, h("p", { class: "muted" }, "Highlighted = marker text the renderer is hiding."), flagsDl),
        h("div", { class: "card" }, h("div", { class: "panel-title" }, "SSE events"), eventLog)
      )
    )
  );
  renderChat();
}

function resetChat() {
  if (playing) return;
  chatState = sse.createCourseChatState();
  eventLog.replaceChildren();
  rawPane.textContent = "—";
  renderChat();
}

function renderRaw(text) {
  rawPane.replaceChildren();
  const re = /\{\{interactive:[\s\S]*?(\}\}|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    rawPane.append(text.slice(last, m.index), h("span", { class: "hl" }, m[0]));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  rawPane.append(text.slice(last) || (text ? "" : "—"));
  // also highlight a dangling partial prefix
  rawPane.scrollTop = rawPane.scrollHeight;
}

function renderChat() {
  const msgs = chatState.messages;
  transcript.replaceChildren(
    ...(msgs.length === 0 ? [h("div", { class: "muted" }, "Press “Simulate lesson chat”. The question is about page 5 of the lesson.")] : []),
    ...msgs.map((m, i) => (m.role === "user" ? h("div", { class: "bubble-user" }, m.content) : renderAssistant(m, i === msgs.length - 1)))
  );
  const last = msgs[msgs.length - 1];
  if (flagsDl && last && last.role === "assistant") {
    flagsDl.replaceChildren(
      ...["isStreaming", "isSearching", "isGeneratingVisuals", "isContentSanitized"].flatMap((k) => [h("dt", null, k), h("dd", null, String(!!last[k]))]),
      h("dt", null, "renderer isStreaming"),
      h("dd", null, String(sse.isMessageContentStreaming(last)))
    );
  }
}

function renderAssistant(m, isLast) {
  const streaming = sse.isMessageContentStreaming(m);
  const parts = [];
  if (m.isSearching) parts.push(h("div", { class: "chat-status" }, "Searching sources…"));
  if (m.content) {
    const body = renderSourceGroundedAnswer(m.content, m.citations || [], { rejectInvalidEmbeddedContent: true, isContentStreaming: streaming, citationPrefix: "chat", keywords, onExplain });
    if (m.isStreaming && !m.isGeneratingVisuals) body.lastElementChild?.append(h("span", { class: "caret", "aria-hidden": "true" }));
    parts.push(body);
  }
  if (m.isGeneratingVisuals) parts.push(h("div", { class: "chat-status" }, "Generating visuals…"));
  if (m.quickReplies && !m.isStreaming && isLast) {
    parts.push(
      h(
        "div",
        { class: "chips" },
        m.quickReplies.map((b) => h("button", { type: "button", class: `chip${b.action ? " chip--action" : ""}`, disabled: playing, onClick: () => onQuickReply(b) }, b.text))
      )
    );
  }
  return h("div", { class: "bubble-assistant" }, parts);
}

function logEvent(ev) {
  const short = { ...ev };
  if (typeof short.content === "string" && short.content.length > 60) short.content = short.content.slice(0, 57) + "…";
  if (short.citations) short.citations = `[${short.citations.length} citations]`;
  eventLog.append(h("li", null, h("span", { class: "t" }, ev.type), " ", JSON.stringify(short).slice(0, 140)));
  eventLog.scrollTop = eventLog.scrollHeight;
}

async function playSSE(question, rawSSE, sizes = [48, 17, 60, 9, 33, 70, 21]) {
  playing = true;
  playBtn.disabled = true;
  chatState = { ...sse.courseChatReducer(chatState, { type: "noop" }), messages: [...chatState.messages, { role: "user", content: question }], streamContent: "", citations: [], complete: false };
  renderChat();
  const parser = new sse.LineSSEParser();
  for (const chunk of sse.chunkText(rawSSE, sizes)) {
    await sleep(SPEEDS[speedSel.value] ?? 45);
    const { events, done } = parser.push(chunk);
    for (const ev of events) {
      logEvent(ev);
      chatState = sse.courseChatReducer(chatState, ev);
      renderRaw(chatState.streamContent);
      renderChat();
      if (ev.type === "status" && ev.status === "generating_visuals") await sleep(1400);
      if (ev.type === "status" && ev.status === "searching") await sleep(700);
    }
    if (done) {
      logEvent({ type: "[DONE]" });
      break;
    }
  }
  chatState = sse.completeCourseChat(chatState);
  playing = false;
  playBtn.disabled = false;
  renderChat();
}

function playMockChat() {
  if (playing) return;
  playSSE(sse.MOCK_CHAT_QUESTION, sse.encodeCourseChatSSE(sse.mockLessonChatEvents()));
}

function onQuickReply(btn) {
  if (playing) return;
  if (btn.action) {
    toast(["Quick reply with ", h("b", null, `action: ${btn.action}`), " triggers an app action instead of sending text."]);
    return;
  }
  const slider = embedToMarker({
    type: "slider",
    title: "Temperature",
    inputLabel: "Temperature",
    outputLabel: "Typical pick",
    stops: [
      { value: 0, label: "0", output: "always “mat”" },
      { value: 0.7, label: "0.7", output: "mostly “mat”" },
      { value: 1.5, label: "1.5", output: "“roof”, “moon”…" },
    ],
  });
  const text = btn.text.toLowerCase().includes("logit")
    ? "A **logit** is the raw score for one vocabulary entry, before softmax. Bigger logit, bigger probability, but only relative to the others."
    : "Temperature divides every logit before the softmax. Low values sharpen the distribution; high values flatten it.";
  const events = [
    ...sse.chunkText(text + "\n\n{{interactive:lesson-input-output-sli", [3, 2, 4]).map((c) => ({ type: "content", content: c })),
    { type: "status", status: "generating_visuals" },
    { type: "embed_progress", content: text + "\n\n" + slider },
    { type: "final", content: text + "\n\n" + slider },
    { type: "quick_replies", quick_replies: [{ text: "What is a logit?" }, { text: "Show me temperature" }] },
  ];
  playSSE(btn.text, sse.encodeCourseChatSSE(events));
}

// ================================================================ (c) voice board

const voiceView = document.getElementById("view-voice");
let boardEl, toolLog;
const boardNodes = new Map();
let lastFocusSeq = 0;
let lastVisualId = null;

const board = createBoard({ onChange: (state, action) => renderBoard(state, action) });
const lessonVisuals = [
  { id: "lv-attn", kind: "visual", title: "Attention, step by step", componentName: "lesson-stepper", params: { data: { title: "ignored by board", steps: [{ label: "Query", text: "What am I looking for?" }, { label: "Key", text: "What do I contain?" }, { label: "Value", text: "What do I pass on?" }] } } },
];
const handleTool = createBoardToolHandler(() => board, () => lessonVisuals, async () => null);

const MOCK_CALLS = [
  { label: "show_text", call: () => ({ name: "show_text", args: { title: "Why only the last token's vector gets scored at each step", markdown: "Every position predicts the token after it, but at generation time only the **last** position matters: its vector is multiplied by the vocabulary matrix to give one logit per token." } }) },
  {
    label: "show_visual · flowchart",
    call: () => ({
      name: "show_visual",
      args: {
        visual: {
          type: "flowchart",
          title: "One generation step",
          nodes: [
            { id: "in", label: "Tokens so far", type: "start" },
            { id: "tf", label: "Transformer layers", type: "process" },
            { id: "sm", label: "Softmax", type: "process", highlighted: true },
            { id: "pick", label: "Pick token", type: "process", highlighted: true },
            { id: "stop", label: "Stop token?", type: "decision" },
            { id: "out", label: "Done", type: "end" },
          ],
          connections: [
            { from: "in", to: "tf" },
            { from: "tf", to: "sm" },
            { from: "sm", to: "pick" },
            { from: "pick", to: "stop" },
            { from: "stop", to: "out", label: "yes" },
            { from: "stop", to: "in", label: "no, append" },
          ],
        },
      },
    }),
  },
  {
    label: "show_visual · bar_chart",
    call: () => ({ name: "show_visual", args: { visual: { type: "bar_chart", title: "Next token after “The cat sat on the”", unit: "%", bars: [{ label: "mat", value: 41, highlighted: true }, { label: "floor", value: 22 }, { label: "couch", value: 17, highlighted: true }, { label: "moon", value: 0.4 }] } } }),
  },
  {
    label: "show_visual · timeline (9→7)",
    call: () => ({
      name: "show_visual",
      args: {
        visual: {
          type: "timeline",
          title: "Language models, briefly",
          events: [
            { date: "1948", label: "Shannon n-grams" },
            { date: "2003", label: "Neural LM" },
            { date: "2013", label: "word2vec" },
            { date: "2017", label: "Transformer", highlighted: true },
            { date: "2018", label: "GPT-1" },
            { date: "2020", label: "GPT-3" },
            { date: "2022", label: "ChatGPT" },
            { date: "2023", label: "GPT-4" },
            { date: "2024", label: "Reasoning models" },
          ],
        },
      },
    }),
  },
  {
    label: "show_visual · concept_map",
    call: () => ({
      name: "show_visual",
      args: { visual: { type: "concept_map", title: "Pieces of a prediction", centerConcept: "Next token", nodes: [{ id: "lg", label: "Logits", level: 1 }, { id: "sm", label: "Softmax", level: 1, highlighted: true }, { id: "t", label: "Temperature", level: 2 }, { id: "v", label: "Vocabulary", level: 2 }], connections: [{ from: "lg", to: "sm", relationship: "fed into" }, { from: "t", to: "sm", relationship: "sharpens" }, { from: "v", to: "lg", relationship: "one per entry" }] } },
    }),
  },
  { label: "show_visual · loop", call: () => ({ name: "show_visual", args: { visual: { type: "loop", title: "Autoregression", centerLabel: "one token per turn", stages: [{ label: "Read prompt" }, { label: "Predict" }, { label: "Append" }] } } }) },
  { label: "show_lesson_visual", call: () => ({ name: "show_lesson_visual", args: { visual_id: "lv-attn" } }) },
  { label: "update bar chart", call: () => ({ name: "show_visual", args: { replaces_item_id: lastVisualId ?? "none-yet", visual: { type: "bar_chart", title: "Same prompt at T = 1.5", unit: "%", bars: [{ label: "mat", value: 19 }, { label: "floor", value: 15 }, { label: "couch", value: 14 }, { label: "moon", value: 6, highlighted: true }] } } }) },
  { label: "get_board_state", call: () => ({ name: "get_board_state", args: {} }) },
  { label: "✗ flowchart, 2 nodes", bad: true, call: () => ({ name: "show_visual", args: { visual: { type: "flowchart", nodes: [{ id: "a", label: "A", type: "start" }, { id: "b", label: "B", type: "end" }], connections: [{ from: "a", to: "b" }, { from: "b", to: "a" }] } } }) },
  { label: "✗ bar_chart, no unit", bad: true, call: () => ({ name: "show_visual", args: { visual: { type: "bar_chart", bars: [{ label: "a", value: 1 }, { label: "b", value: 2 }] } } }) },
  { label: "✗ replace unknown item", bad: true, call: () => ({ name: "show_visual", args: { replaces_item_id: "item-404", visual: { type: "reveal", items: [{ label: "Guess", content: "Answer" }] } } }) },
  { label: "✗ unknown tool", bad: true, call: () => ({ name: "draw_unicorn", args: {} }) },
];

function buildVoiceView() {
  boardEl = h("div", { class: "board" });
  toolLog = h("ol", { class: "tool-log", reversed: true });
  const buttons = h(
    "div",
    { class: "tool-btns" },
    MOCK_CALLS.map((mc) => h("button", { type: "button", class: `btn btn--small${mc.bad ? " btn--danger" : ""}`, onClick: () => runTool(mc.call()) }, mc.label)),
    h("button", { type: "button", class: "btn btn--small", onClick: () => board.clear() }, "clear board")
  );
  clear(voiceView).append(
    h(
      "div",
      { class: "view-head" },
      h("div", { class: "eyebrow" }, "Live tutor · board tools (mocked)"),
      h("h1", null, "Voice tutor board"),
      h("p", null, "Each button issues a tool call the realtime model could make. Calls go through the shipped strict validators (bounded arrays, single highlight, required fields) and the board reducer (add-item, update-item, report-height, clear).")
    ),
    h("div", { class: "grid-2" }, h("div", { class: "card" }, h("div", { class: "panel-title" }, "Board"), boardEl), h("div", { style: { display: "grid", gap: "20px", alignContent: "start" } }, h("div", { class: "card" }, h("div", { class: "panel-title" }, "Tool calls"), buttons), h("div", { class: "card" }, h("div", { class: "panel-title" }, "Call log"), toolLog)))
  );
  renderBoard(board.state);
}

async function runTool(call) {
  const result = await handleTool(call);
  if (result.ok && call.name === "show_visual" && call.args.visual?.type === "bar_chart") lastVisualId = result.item_id;
  toolLog.prepend(
    h(
      "li",
      null,
      h("div", null, h("b", null, call.name), " → ", h("span", { class: result.ok ? "ok" : "err" }, result.ok ? "ok" : result.error), result.summary ? ` · ${result.summary}` : ""),
      h("pre", null, `args: ${JSON.stringify(call.args).slice(0, 400)}\nresult: ${JSON.stringify(result)}`)
    )
  );
}

const heightObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => entries.forEach((e) => board.reportItemHeight(e.target.dataset.itemId, Math.round(e.contentRect.height)))) : null;

function renderPayload(item) {
  const p = item.payload;
  if (p.kind === "text") return renderMarkdown(p.markdown, { rejectInvalidEmbeddedContent: true });
  if (p.kind === "image") return h("img", { src: p.url, alt: p.alt, class: "md-img" });
  return renderInteractiveEntry({ componentName: p.componentName, Component: getInteractiveComponent(p.componentName), params: p.params }, { track });
}

function renderBoard(state, action) {
  if (!boardEl) return;
  if (state.items.length === 0) {
    boardNodes.forEach((n) => heightObserver?.unobserve(n.el));
    boardNodes.clear();
    boardEl.replaceChildren(h("div", { class: "board-empty" }, "The board is empty. Ask the tutor to show something →"));
    return;
  }
  boardEl.querySelector(".board-empty")?.remove();
  const positions = boardItemPositions(state.items);
  state.items.forEach((item, i) => {
    let node = boardNodes.get(item.id);
    const stale = node && (node.payload !== item.payload || node.title !== item.title);
    if (!node || stale) {
      const body = h("div", { class: "board-item__body" }, renderPayload(item));
      const meta = h("span", { class: "board-item__meta" });
      const el = h("div", { class: "board-item", "data-item-id": item.id }, h("div", { class: "board-item__head" }, h("span", { class: "board-item__title" }, item.title), meta), body);
      if (node) {
        heightObserver?.unobserve(node.el);
        node.el.replaceWith(el);
      } else boardEl.appendChild(el);
      node = { el, meta, payload: item.payload, title: item.title };
      boardNodes.set(item.id, node);
      heightObserver?.observe(el);
    }
    node.meta.textContent = `${item.payload.kind}${item.payload.componentName ? " · " + item.payload.componentName : ""} · y=${positions[i].y} h=${item.measuredHeight ?? "?"}`;
    node.el.classList.toggle("is-focused", item.id === state.focusItemId);
  });
  if (state.focusSeq !== lastFocusSeq) {
    lastFocusSeq = state.focusSeq;
    boardNodes.get(state.focusItemId)?.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ================================================================ (d) practice

const practiceView = document.getElementById("view-practice");
const scheduler = fsrs(); // shipped defaults: w[19], retention .9, max 36500, no fuzz, short-term on
let clock = new Date();
const cards = new Map(SAMPLE_PRACTICES.map((p) => [p.id, { card: createEmptyCard(clock), logs: [] }]));
let queue = SAMPLE_PRACTICES.map((p) => p.id);
let current = 0;
let answered = null; // {correct, rating, preview}
let answerState = {};
let practiceCard, schedBody, clockEl;

function fmtDelta(from, to) {
  const mins = Math.round((to - from) / 6e4);
  if (mins < 60) return `${mins} min`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = hours / 24;
  return days < 60 ? `${Math.round(days)} d` : `${(days / 30.4).toFixed(1)} mo`;
}
const fmtDate = (d) => d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function buildPracticeView() {
  practiceCard = h("div", { class: "card" });
  schedBody = h("tbody");
  clockEl = h("span", { class: "clock" });
  clear(practiceView).append(
    h(
      "div",
      { class: "view-head" },
      h("div", { class: "eyebrow" }, "practices · FSRS v5 (ts-fsrs defaults)"),
      h("h1", null, "Practice"),
      h("p", null, "Answers are checked with the shipped validators; binary correctness maps to Good/Again, then FSRS schedules the next review. Use time travel to come back when cards are due.")
    ),
    h(
      "div",
      { class: "grid-2" },
      practiceCard,
      h(
        "div",
        { class: "card" },
        h("div", { class: "w-row-between" }, h("div", { class: "panel-title" }, "Schedule"), clockEl),
        h("div", { class: "sched-scroll" }, h("table", { class: "sched-table" }, h("thead", null, h("tr", null, ["Card", "State", "Due", "S (days)", "D", "R now", "Reps"].map((x) => h("th", null, x)))), schedBody)),
        h("div", { class: "btn-row", style: { marginTop: "16px" } }, h("button", { type: "button", class: "btn btn--small", onClick: () => travel(1) }, "+1 day"), h("button", { type: "button", class: "btn btn--small", onClick: jumpToDue }, "Jump to next due"), h("button", { type: "button", class: "btn btn--small", onClick: resetPractice }, "Reset"))
      )
    )
  );
  renderPractice();
}

function resetPractice() {
  clock = new Date();
  for (const p of SAMPLE_PRACTICES) cards.set(p.id, { card: createEmptyCard(clock), logs: [] });
  queue = SAMPLE_PRACTICES.map((p) => p.id);
  current = 0;
  answered = null;
  answerState = {};
  renderPractice();
}

function travel(days) {
  clock = new Date(clock.getTime() + days * 864e5);
  rebuildQueue();
}
function jumpToDue() {
  const next = Math.min(...[...cards.values()].map((c) => c.card.due.getTime()));
  if (next > clock.getTime()) clock = new Date(next);
  rebuildQueue();
}
function rebuildQueue() {
  queue = [...cards.entries()].filter(([, c]) => c.card.due <= clock).sort((a, b) => a[1].card.due - b[1].card.due).map(([id]) => id);
  current = 0;
  answered = null;
  answerState = {};
  renderPractice();
}

function renderSchedule() {
  clockEl.textContent = `now: ${fmtDate(clock)}`;
  schedBody.replaceChildren(
    ...SAMPLE_PRACTICES.map((p) => {
      const { card } = cards.get(p.id);
      const due = card.due <= clock ? "due now" : `in ${fmtDelta(clock, card.due)}`;
      return h(
        "tr",
        null,
        h("td", null, p.type),
        h("td", null, h("span", { class: `pill pill--${STATE_NAMES[card.state]}` }, STATE_NAMES[card.state])),
        h("td", { title: card.due.toISOString() }, due),
        h("td", null, card.stability ? card.stability.toFixed(2) : "—"),
        h("td", null, card.difficulty ? card.difficulty.toFixed(2) : "—"),
        h("td", null, card.state ? scheduler.get_retrievability(card, clock).toFixed(3) : "—"),
        h("td", null, String(card.reps))
      );
    })
  );
}

function renderPractice() {
  renderSchedule();
  if (current >= queue.length) {
    const next = Math.min(...[...cards.values()].map((c) => c.card.due.getTime()));
    practiceCard.replaceChildren(
      h("div", { class: "eyebrow" }, "Session complete"),
      h("p", { class: "practice-q" }, queue.length ? "Nice. Everything due is reviewed." : "Nothing is due right now."),
      h("p", { class: "muted" }, `Next card is due in ${fmtDelta(clock, new Date(next))} (${fmtDate(new Date(next))}). Learning-step cards come back within minutes; review cards in days.`),
      h("div", { class: "btn-row" }, h("button", { type: "button", class: "btn btn--primary", onClick: jumpToDue }, "Jump to next due"))
    );
    return;
  }
  const p = SAMPLE_PRACTICES.find((x) => x.id === queue[current]);
  const entry = cards.get(p.id);
  const head = h("div", { class: "w-row-between" }, h("span", { class: "eyebrow" }, `${p.type.replace("_", " ")} · ${current + 1}/${queue.length}`), h("span", { class: `pill pill--${STATE_NAMES[entry.card.state]}` }, STATE_NAMES[entry.card.state]));
  const body = [];
  let getAnswer;
  if (p.type === "mcq" || p.type === "binary_choice") {
    const choices = parseMCQOptions(p.options);
    const picked = answerState.picked ?? new Set();
    body.push(h("p", { class: "practice-q" }, p.question));
    body.push(
      h(
        "div",
        { class: "options", role: "group" },
        choices.map((c) => {
          let cls = "option";
          if (answered) cls += c.isCorrect ? " is-correct" : picked.has(c.id) ? " is-wrong" : "";
          return h(
            "button",
            {
              type: "button",
              class: cls,
              "aria-pressed": String(picked.has(c.id)),
              disabled: !!answered,
              onClick: () => {
                answerState.picked = new Set([c.id]);
                renderPractice();
              },
            },
            c.text
          );
        })
      )
    );
    getAnswer = () => (p.type === "mcq" ? picked : [...picked][0]);
  } else if (p.type === "cloze") {
    const vals = (answerState.cloze ??= {});
    const line = h("p", { class: "cloze-line" });
    for (const seg of splitClozeQuestion(p.question)) {
      if (seg.type === "text") line.append(seg.value);
      else {
        const spec = p.options.clozes.find((c) => c.id === seg.id);
        const ok = answered && validatePracticeAnswer({ type: "cloze", options: { clozes: [spec] } }, { [seg.id]: vals[seg.id] ?? "" });
        line.append(h("input", { class: `cloze-input${answered ? (ok ? " is-correct" : " is-wrong") : ""}`, "aria-label": `Blank ${seg.id}`, value: vals[seg.id] ?? "", disabled: !!answered, autocomplete: "off", onInput: (e) => (vals[seg.id] = e.target.value) }));
      }
    }
    body.push(line);
    getAnswer = () => vals;
  }
  const actions = h("div", { class: "btn-row", style: { marginTop: "20px" } });
  if (!answered) {
    actions.append(
      h(
        "button",
        {
          type: "button",
          class: "btn btn--primary",
          onClick: () => {
            const correct = validatePracticeAnswer(p, getAnswer()) === true;
            const rating = ratingFromCorrect(correct);
            const preview = scheduler.repeat(entry.card, clock);
            const result = scheduler.next(entry.card, clock, rating);
            entry.card = result.card;
            entry.logs.push(result.log);
            answered = { correct, rating, preview };
            renderPractice();
          },
        },
        "Check"
      )
    );
  } else {
    actions.append(h("button", { type: "button", class: "btn btn--primary", onClick: () => { current += 1; answered = null; answerState = {}; renderPractice(); } }, "Continue"));
  }
  const fb = answered
    ? h(
        "div",
        null,
        h("div", { class: `feedback ${answered.correct ? "ok" : "bad"}` }, h("b", null, answered.correct ? "Correct. " : "Not quite. "), p.explanation),
        h("p", { class: "muted", style: { margin: "14px 0 4px" } }, `Rated ${RATING_NAMES[answered.rating]} → next review in ${fmtDelta(clock, entry.card.due)} (${STATE_NAMES[entry.card.state]}). All four outcomes from this state:`),
        h(
          "div",
          { class: "preview-grid" },
          [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].map((r) => {
            const out = answered.preview[r].card;
            return h("div", { style: r === answered.rating ? { outline: "2px solid var(--brand-border)" } : {} }, RATING_NAMES[r], h("b", null, fmtDelta(clock, out.due)), `S ${out.stability.toFixed(2)}`);
          })
        )
      )
    : null;
  practiceCard.replaceChildren(head, ...body, fb ?? "", actions);
}

// ---------------------------------------------------------------- boot

renderLesson();
buildChatView();
buildVoiceView();
buildPracticeView();
showView(location.hash.slice(1) || "lesson");
