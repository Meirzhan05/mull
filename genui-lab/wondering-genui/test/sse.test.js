import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LineSSEParser,
  readCourseChatStream,
  createCourseChatState,
  courseChatReducer,
  completeCourseChat,
  isMessageContentStreaming,
  TeacherSSEParser,
  readTeacherStream,
  teacherReducer,
  createTeacherState,
  teacherSendStart,
  teacherCardKey,
  mergeTeacherCards,
  teacherErrorCode,
  mockLessonChatEvents,
  mockLessonChatSSEChunks,
  mockLessonChatStream,
  mockResolvedChatContent,
  mockTeacherEvents,
  encodeTeacherSSE,
  chunkText,
  MOCK_QUICK_REPLIES,
} from "../src/sse.js";
import { processInteractiveComponents } from "../src/markers.js";
import { visibleText, sourceCitationContent } from "../src/markdown.js";

const silenceErrors = (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
};

test("LineSSEParser: buffers partial lines, ignores non-data lines, stops at [DONE]", () => {
  const p = new LineSSEParser();
  assert.deepEqual(p.push('data: {"type":"con'), { events: [], done: false });
  assert.deepEqual(p.push('tent","content":"hi"}\n\nevent: x\n: comment\ndata: {"type":"status","status":"searching"}\n'), {
    events: [{ type: "content", content: "hi" }, { type: "status", status: "searching" }],
    done: false,
  });
  const r = silenceErrors(() => p.push('data: {broken\ndata: [DONE]\ndata: {"type":"content","content":"late"}\n'));
  assert.deepEqual(r, { events: [], done: true });
  assert.deepEqual(p.push('data: {"type":"content","content":"x"}\n'), { events: [], done: true });
});

test("course-chat reducer over the mock stream (any chunking) ends with resolved visuals + chips", async () => {
  for (const sizes of [[1], [7, 3, 19], [5000]]) {
    let state = createCourseChatState([{ role: "user", content: "q" }]);
    let completed = false;
    const seen = [];
    await readCourseChatStream(
      (async function* () {
        for (const c of mockLessonChatSSEChunks(sizes)) yield c;
      })(),
      {
        onChunk: (e) => {
          seen.push(e.type);
          state = courseChatReducer(state, e);
          const last = state.messages[state.messages.length - 1];
          if (last.role === "assistant" && last.content) {
            const shown = visibleText(sourceCitationContent(last.content, last.citations || []), { rejectInvalidEmbeddedContent: true, isContentStreaming: isMessageContentStreaming(last) });
            assert.ok(!shown.includes("{{interactive"), "raw marker never visible");
            assert.ok(!shown.includes("SOURCE:"), "raw source marker never visible");
          }
        },
        onComplete: () => {
          completed = true;
          state = completeCourseChat(state);
        },
      }
    );
    assert.ok(completed);
    assert.deepEqual([...new Set(seen)], ["status", "content", "embed_progress", "final", "citations", "quick_replies"]);
    const msg = state.messages[state.messages.length - 1];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content, mockResolvedChatContent());
    assert.equal(msg.isStreaming, false);
    assert.equal(msg.isGeneratingVisuals, false);
    assert.equal(msg.isContentSanitized, true);
    assert.deepEqual(msg.quickReplies, MOCK_QUICK_REPLIES);
    assert.equal(msg.citations.length, 2);
    assert.equal(msg.citations[0].passageId, "p-attn-01");
    const { placeholderMap } = processInteractiveComponents(msg.content, undefined, { rejectInvalidMarkers: true });
    assert.deepEqual([...placeholderMap.values()].map((e) => e.componentName).sort(), ["bar-chart-visualization", "lesson-stepper"]);
    const cited = sourceCitationContent(msg.content, msg.citations, "c");
    assert.ok(cited.includes("[1](#c-1)") && cited.includes("[2](#c-2)"));
  }
});

test("course-chat reducer: flags through the lifecycle", () => {
  let s = createCourseChatState();
  s = courseChatReducer(s, { type: "status", status: "searching" });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].isSearching, true);
  s = courseChatReducer(s, { type: "status", status: "search_complete" });
  assert.equal(s.messages[0].isSearching, false);
  s = courseChatReducer(s, { type: "content", content: "Hel" });
  s = courseChatReducer(s, { type: "content", content: "lo" });
  assert.equal(s.messages[0].content, "Hello");
  assert.equal(isMessageContentStreaming(s.messages[0]), true);
  s = courseChatReducer(s, { type: "status", status: "generating_visuals" });
  assert.equal(s.messages[0].isGeneratingVisuals, true);
  s = courseChatReducer(s, { type: "embed_progress", content: "Hello {{interactive:lesson-stepper}}" });
  assert.equal(s.messages[0].content, "Hello {{interactive:lesson-stepper}}", "embed_progress replaces, not appends");
  assert.equal(isMessageContentStreaming(s.messages[0]), false, "sanitized content renders as non-streaming");
  s = courseChatReducer(s, { type: "content", content: "!" });
  assert.equal(s.messages[0].content, "Hello {{interactive:lesson-stepper}}!", "later deltas append to the replaced buffer");
  s = courseChatReducer(s, { type: "feedback_id", feedback_id: "fb1" });
  assert.equal(s.feedbackId, "fb1");
  s = courseChatReducer(s, { type: "error", error: "boom" });
  assert.equal(s.error, "boom");
  assert.equal(courseChatReducer(s, { type: "mystery" }), s);
});

test("quick_replies without an assistant message creates one", () => {
  const s = courseChatReducer(createCourseChatState([{ role: "user", content: "q" }]), { type: "quick_replies", quick_replies: [{ text: "a" }] });
  assert.deepEqual(s.messages[1], { role: "assistant", content: "", quickReplies: [{ text: "a" }] });
});

test("mockLessonChatStream yields the same bytes as the chunk list", async () => {
  let all = "";
  for await (const c of mockLessonChatStream()) all += c;
  assert.equal(all, mockLessonChatSSEChunks().join(""));
  assert.ok(all.endsWith("data: [DONE]\n\n"));
  const contentEvents = mockLessonChatEvents().filter((e) => e.type === "content");
  assert.ok(contentEvents.map((e) => e.content).join("").includes("{{interactive:lesson-stepper"), "the model writes a raw marker mid-stream");
});

test("TeacherSSEParser: blank-line framing, multi-line data, CRLF, whitelist, flush", () => {
  const p = new TeacherSSEParser();
  const events = p.push('event: message\r\ndata: {"type":"text_delta",\r\ndata: "text":"hi"}\r\n\r\ndata: {"type":"bogus"}\n\ndata: {"type":"thread","threadId":"t"}\n\ndata: {"type":"do');
  assert.deepEqual(events, [{ type: "text_delta", text: "hi" }, { type: "thread", threadId: "t" }]);
  assert.deepEqual(p.push('ne","messageId":"m"}'), []);
  assert.deepEqual(p.flush(), [{ type: "done", messageId: "m" }]);
  // per-line fallback when the joined payload is not JSON
  const q = new TeacherSSEParser();
  const ev = silenceErrors(() => q.push('data: {"type":"status","status":"searching"}\ndata: {"type":"text_delta","text":"x"}\ndata: garbage\n\n'));
  assert.deepEqual(ev, [{ type: "status", status: "searching" }, { type: "text_delta", text: "x" }]);
  assert.deepEqual(new TeacherSSEParser().push("data: [DONE]\n\n"), []);
});

test("readTeacherStream stops at done and synthesises 'Stream ended early'", async () => {
  const got = [];
  await readTeacherStream([encodeTeacherSSE([{ type: "text_delta", text: "a" }, { type: "done" }, { type: "text_delta", text: "ignored" }])], (e) => got.push(e));
  assert.deepEqual(got.map((e) => e.type), ["text_delta", "done"]);
  const cut = [];
  await readTeacherStream([encodeTeacherSSE([{ type: "text_delta", text: "a" }])], (e) => cut.push(e));
  assert.deepEqual(cut[cut.length - 1], { type: "error", message: "Stream ended early", code: "unavailable" });
  assert.equal(teacherErrorCode(429), "limit_exceeded");
  assert.equal(teacherErrorCode(413), "bad_request");
  assert.equal(teacherErrorCode(500), "unavailable");
});

test("teacher reducer: tool status, cards merged + deduped, final id", async () => {
  let s = teacherSendStart(createTeacherState(), { text: "explain", userMessageId: "u1", assistantMessageId: "a1" });
  const statuses = [];
  await readTeacherStream(chunkText(encodeTeacherSSE(mockTeacherEvents()), [13, 4, 40]), (e) => {
    s = teacherReducer(s, e);
    statuses.push(s.statusKind);
  });
  assert.equal(s.threadId, "t-1");
  assert.equal(s.isStreaming, false);
  assert.deepEqual(s.activeTools, []);
  assert.ok(statuses.includes("tool"));
  const msg = s.messages.find((m) => m.role === "assistant");
  assert.equal(msg.id, "m-42");
  assert.equal(msg.renderKey, "a1");
  assert.equal(msg.content, "Let me make a quick visual.");
  assert.deepEqual(msg.cards.map((c) => c.type), ["visual", "quiz"], "done re-sends both cards; they are deduped by key");
  assert.ok(msg.cards[0].markdown.includes("{{interactive:cycle-visualization"));
});

test("teacher reducer: busy/limit errors mark the user message unsent and drop the empty assistant", () => {
  let s = teacherSendStart(createTeacherState(), { text: "hi", userMessageId: "u1", assistantMessageId: "a1" });
  s = teacherReducer(s, { type: "error", message: "busy", code: "busy" });
  assert.deepEqual(s.messages.map((m) => [m.id, !!m.unsent]), [["u1", true]]);
  assert.deepEqual(s.error, { message: "busy", code: "busy" });
  let t = teacherSendStart(createTeacherState(), { text: "hi", userMessageId: "u1", assistantMessageId: "a1" });
  t = teacherReducer(t, { type: "text_delta", text: "partial" });
  t = teacherReducer(t, { type: "error", message: "x", code: "unavailable" });
  assert.deepEqual(t.messages.map((m) => [m.id, !!m.unsent, m.isStreaming]), [["u1", false, undefined], ["a1", false, false]]);
});

test("teacherCardKey / mergeTeacherCards", () => {
  assert.equal(teacherCardKey({ type: "approval", actionId: "x" }), "approval:x");
  assert.equal(teacherCardKey({ type: "memory", summary: "s" }), "memory:s");
  assert.equal(teacherCardKey({ type: "library", sources: [{ id: 1 }, { id: 2 }] }), "library:1,2");
  assert.equal(teacherCardKey({ type: "goal", goal: { id: "g" } }), "goal:g");
  const merged = mergeTeacherCards([{ type: "job", actionId: "j", status: "running" }], [{ type: "job", actionId: "j", status: "done" }, { type: "quiz", quizId: "q" }, { type: "quiz", quizId: "q", correct: true }]);
  assert.deepEqual(merged, [{ type: "job", actionId: "j", status: "done" }, { type: "quiz", quizId: "q", correct: true }]);
});
