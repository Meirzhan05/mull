// SSE parsing + chat reducers. DOM-free.
//  - course-chat (chatApi.sendMessage @2818700): line-based `data: {json}`, terminator `data: [DONE]`.
//  - course-chat onChunk/onComplete reducer (@2851064-@2853900).
//  - teacher-chat (teacher chunk @628): blank-line event framing, multi-line data joined,
//    whitelisted event types; reducer `Cn` + card merge `Fs`/`_n` + dedupe key `Ge`
//    (teacherActionCard chunk @19213-@23105).
// Also: mock streams for the demo and tests (no network anywhere).

import { embedToMarker, insertEmbedAfterParagraph } from "./embeds.js";

// ============================================================ course-chat parser

export class LineSSEParser {
  constructor() {
    this.buffer = "";
    this.done = false;
  }
  /** Feed decoded text; returns {events, done}. Mirrors the shipped split("\n") loop. */
  push(text) {
    const events = [];
    if (this.done) return { events, done: true };
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") {
        this.done = true;
        return { events, done: true };
      }
      try {
        events.push(JSON.parse(payload));
      } catch (err) {
        console.error("Error parsing SSE data:", err, payload);
      }
    }
    return { events, done: false };
  }
}

/** Consumes an async iterable of text chunks (or a ReadableStream<Uint8Array>) like chatApi.sendMessage. */
export async function readCourseChatStream(source, { onChunk, onComplete, onError } = {}) {
  const parser = new LineSSEParser();
  try {
    for await (const piece of toTextIterable(source)) {
      const { events, done } = parser.push(piece);
      events.forEach((e) => onChunk?.(e));
      if (done) {
        onComplete?.();
        return;
      }
    }
    onComplete?.();
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error("Unknown chat error"));
  }
}

async function* toTextIterable(source) {
  if (source && typeof source.getReader === "function") {
    const reader = source.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield typeof value === "string" ? value : dec.decode(value, { stream: true });
    }
    return;
  }
  for await (const x of source) yield x;
}

// ============================================================ course-chat reducer

export function createCourseChatState(messages = []) {
  return { messages: [...messages], streamContent: "", citations: [], feedbackId: null, error: null, complete: false };
}

const lastAssistant = (msgs) => {
  const m = msgs[msgs.length - 1];
  return m && m.role === "assistant" ? m : null;
};
const replaceLast = (msgs, patch) => [...msgs.slice(0, -1), { ...msgs[msgs.length - 1], ...patch }];

/** Applies one course-chat SSE chunk. Pure port of the onChunk branches. */
export function courseChatReducer(state, chunk) {
  const msgs = state.messages;
  switch (chunk?.type) {
    case "content": {
      if (!chunk.content) return state;
      const streamContent = state.streamContent + chunk.content;
      const messages = lastAssistant(msgs)
        ? replaceLast(msgs, { content: streamContent, isSearching: false, isStreaming: true, isContentSanitized: false })
        : [...msgs, { role: "assistant", content: streamContent, citations: [], isStreaming: true, isContentSanitized: false }];
      return { ...state, streamContent, messages };
    }
    case "status": {
      if (chunk.status === "searching" || chunk.status === "search_complete") {
        const searching = chunk.status === "searching";
        if (lastAssistant(msgs)) return { ...state, messages: replaceLast(msgs, { isSearching: searching }) };
        return searching ? { ...state, messages: [...msgs, { role: "assistant", content: "", isStreaming: true, isSearching: true }] } : state;
      }
      if (chunk.status === "generating_visuals") {
        return lastAssistant(msgs) ? { ...state, messages: replaceLast(msgs, { isStreaming: true, isGeneratingVisuals: true }) } : state;
      }
      return state;
    }
    case "embed_progress": {
      if (typeof chunk.content !== "string") return state;
      // Replaces the whole message with the server-sanitized version (markers resolved).
      const messages = lastAssistant(msgs) ? replaceLast(msgs, { content: chunk.content, isSearching: false, isStreaming: true, isGeneratingVisuals: true, isContentSanitized: true }) : msgs;
      return { ...state, streamContent: chunk.content, messages };
    }
    case "final": {
      if (typeof chunk.content !== "string") return state;
      const messages = lastAssistant(msgs) ? replaceLast(msgs, { content: chunk.content, isSearching: false, isStreaming: false, isGeneratingVisuals: false, isContentSanitized: true }) : msgs;
      return { ...state, streamContent: chunk.content, messages };
    }
    case "citations": {
      if (!chunk.citations) return state;
      const citations = chunk.citations.map((c) => ({
        url: c.url_citation.url,
        title: c.url_citation.title,
        sourceId: c.url_citation.sourceId,
        passageId: c.url_citation.passageId,
        paragraph: c.url_citation.paragraph,
        quote: c.url_citation.quote,
        page: c.url_citation.page,
        startSeconds: c.url_citation.startSeconds,
      }));
      return { ...state, citations };
    }
    case "feedback_saved":
      return chunk.feedbackId ? { ...state, feedbackId: chunk.feedbackId } : state;
    case "feedback_id":
      return chunk.feedback_id ? { ...state, feedbackId: chunk.feedback_id } : state;
    case "quick_replies": {
      if (!chunk.quick_replies) return state;
      const messages = lastAssistant(msgs) ? replaceLast(msgs, { quickReplies: chunk.quick_replies }) : [...msgs, { role: "assistant", content: "", quickReplies: chunk.quick_replies }];
      return { ...state, messages };
    }
    case "error": {
      const messages = msgs.map((m, i) => (i === msgs.length - 1 && m.role === "assistant" ? { ...m, isSearching: false } : m));
      return { ...state, messages, error: chunk.error || "Chat request failed" };
    }
    default:
      return state;
  }
}

/** onComplete: stop streaming flags and attach collected citations. */
export function completeCourseChat(state) {
  let messages = state.messages;
  if (lastAssistant(messages)) {
    messages = replaceLast(messages, { isStreaming: false, isGeneratingVisuals: false, isSearching: false, ...(state.citations.length ? { citations: state.citations } : {}) });
  }
  return { ...state, messages, complete: true };
}

/** The renderer flag used by the chat bubble (@4392794). */
export function isMessageContentStreaming(message) {
  return !!message.isStreaming && !message.isContentSanitized;
}

// ============================================================ teacher-chat parser (exact port)

export const TEACHER_EVENT_TYPES = new Set(["thread", "text_delta", "tool_start", "tool_result", "status", "done", "error"]);
const isTeacherEvent = (e) => typeof e === "object" && e !== null && TEACHER_EVENT_TYPES.has(e.type);

function parseTeacherPayload(data) {
  if (data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    return isTeacherEvent(parsed) ? parsed : null;
  } catch {
    return undefined;
  }
}

function parseTeacherBlock(block) {
  const datas = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const v = line.slice(5);
    datas.push(v.startsWith(" ") ? v.slice(1) : v);
  }
  if (datas.length === 0) return [];
  const joined = parseTeacherPayload(datas.join("\n"));
  if (joined !== undefined) return joined ? [joined] : [];
  // fall back to one JSON object per data line
  const out = [];
  for (const d of datas) {
    const ev = parseTeacherPayload(d);
    if (ev) out.push(ev);
    else if (ev === undefined) console.error("Teacher stream: unparseable event", d.slice(0, 200));
  }
  return out;
}

export class TeacherSSEParser {
  constructor() {
    this.buffer = "";
  }
  push(text) {
    this.buffer += text.replace(/\r\n?/g, "\n");
    const out = [];
    let idx = this.buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      out.push(...parseTeacherBlock(block));
      idx = this.buffer.indexOf("\n\n");
    }
    return out;
  }
  flush() {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? parseTeacherBlock(rest) : [];
  }
}

/** Port of the teacher send loop: stops at done/error, synthesises "Stream ended early". */
export async function readTeacherStream(source, onEvent) {
  const parser = new TeacherSSEParser();
  let finished = false;
  const emit = (events) => {
    for (const e of events) {
      if (finished) return;
      onEvent(e);
      if (e.type === "done" || e.type === "error") finished = true;
    }
  };
  try {
    for await (const piece of toTextIterable(source)) {
      if (finished) break;
      emit(parser.push(piece));
    }
    if (!finished) emit(parser.flush());
    if (!finished) {
      onEvent({ type: "error", message: "Stream ended early", code: "unavailable" });
      finished = true;
    }
  } catch (err) {
    if (!finished) onEvent({ type: "error", message: err instanceof Error ? err.message : String(err), code: "unavailable" });
  }
}

/** HTTP status -> teacher error code (function A in the chunk). */
export function teacherErrorCode(status) {
  return status === 429 ? "limit_exceeded" : status === 400 || status === 413 ? "bad_request" : "unavailable";
}

// ============================================================ teacher reducer

export const TEACHER_CARD_TYPES = Object.freeze(["plan", "plan_diff", "approval", "course_suggestions", "course", "lesson", "lesson_list", "quiz", "review", "memory", "job", "goal", "reminder", "calendar", "sources", "library", "friends", "navigate", "visual"]);

/** Port of `Ge(card)` dedupe key. */
export function teacherCardKey(card) {
  switch (card.type) {
    case "plan_diff":
    case "approval":
    case "job":
      return `${card.type}:${card.actionId}`;
    case "memory":
      return card.actionId ? `memory:${card.actionId}` : `memory:${card.summary}`;
    case "quiz":
      return `quiz:${card.quizId}`;
    case "lesson":
      return `lesson:${card.lessonSessionId}`;
    case "course":
      return `course:${card.courseId}`;
    case "goal":
      return `goal:${card.goal.id}`;
    case "reminder":
      return `reminder:${card.reminder.id}`;
    case "library":
      return card.actionId ? `library:${card.actionId}` : `library:${card.sources.map((s) => s.id).join(",")}`;
    default:
      return `${card.type}:${JSON.stringify(card)}`;
  }
}

/** Port of `Fs` + `_n`: replace cards with an existing key in place, append new ones (deduped). */
export function mergeTeacherCards(existing, incoming) {
  if (!incoming || incoming.length === 0) return existing;
  const cards = [...existing];
  const added = [];
  for (const card of incoming) {
    const key = teacherCardKey(card);
    const i = cards.findIndex((c) => teacherCardKey(c) === key);
    if (i >= 0) {
      cards[i] = card;
      continue;
    }
    const j = added.findIndex((c) => teacherCardKey(c) === key);
    if (j >= 0) {
      added[j] = card;
      continue;
    }
    added.push(card);
  }
  return [...cards, ...added];
}

export function createTeacherState() {
  return { threadId: null, threadTitle: null, messages: [], streamingMessageId: null, pendingUserMessageId: null, isStreaming: false, activeTools: [], statusKind: null, error: null, answeredQuizzes: {} };
}

/** Optimistic send: adds the user message and an empty streaming assistant message. */
export function teacherSendStart(state, { text, userMessageId = "user-" + Date.now(), assistantMessageId = "assistant-" + Date.now() }) {
  return {
    ...state,
    error: null,
    isStreaming: true,
    statusKind: "thinking",
    streamingMessageId: assistantMessageId,
    pendingUserMessageId: userMessageId,
    messages: [...state.messages, { id: userMessageId, role: "user", content: text, cards: [] }, { id: assistantMessageId, role: "assistant", content: "", cards: [], isStreaming: true }],
  };
}

const updateMessage = (messages, id, fn) => (id ? messages.map((m) => (m.id === id ? fn(m) : m)) : messages);

function applyQuizAnswers(state, cards) {
  return cards.map((c) => {
    if (c.type !== "quiz") return c;
    const answered = state.answeredQuizzes[c.quizId];
    return answered && c.learnerAnswer === null ? answered : c;
  });
}

function finishStream(state) {
  const sid = state.streamingMessageId;
  const messages = state.messages
    .filter((m) => !(m.id === sid && !m.content.trim() && m.cards.length === 0))
    .map((m) => (m.id === sid ? { ...m, isStreaming: false } : m));
  return { ...state, messages, isStreaming: false, streamingMessageId: null, pendingUserMessageId: null, activeTools: [], statusKind: null };
}

/** Port of reducer `Cn` (teacherActionCard chunk @23105). */
export function teacherReducer(state, ev) {
  switch (ev.type) {
    case "thread":
      return { ...state, threadId: ev.threadId, threadTitle: ev.title ?? state.threadTitle };
    case "text_delta":
      return { ...state, statusKind: state.activeTools.length > 0 ? "tool" : null, messages: updateMessage(state.messages, state.streamingMessageId, (m) => ({ ...m, content: m.content + ev.text })) };
    case "tool_start":
      return { ...state, statusKind: "tool", activeTools: [...state.activeTools.filter((t) => t.toolCallId !== ev.toolCallId), { toolCallId: ev.toolCallId, name: ev.name, label: ev.label }] };
    case "tool_result": {
      const activeTools = state.activeTools.filter((t) => t.toolCallId !== ev.toolCallId);
      return {
        ...state,
        activeTools,
        statusKind: activeTools.length > 0 ? "tool" : "thinking",
        messages: updateMessage(state.messages, state.streamingMessageId, (m) => ({ ...m, cards: mergeTeacherCards(m.cards, applyQuizAnswers(state, ev.cards ?? [])) })),
      };
    }
    case "status":
      return ev.status === "search_complete" ? { ...state, statusKind: state.activeTools.length > 0 ? "tool" : "thinking" } : { ...state, statusKind: ev.status };
    case "done": {
      const finalId = ev.messageId || state.streamingMessageId;
      return {
        ...state,
        isStreaming: false,
        streamingMessageId: null,
        pendingUserMessageId: null,
        activeTools: [],
        statusKind: null,
        messages: updateMessage(state.messages, state.streamingMessageId, (m) => ({ ...m, renderKey: m.renderKey ?? m.id, id: finalId ?? m.id, isStreaming: false, cards: mergeTeacherCards(m.cards, applyQuizAnswers(state, ev.cards ?? [])) })),
      };
    }
    case "error": {
      const unsent = ev.code === "busy" || ev.code === "limit_exceeded" || ev.code === "bad_request";
      return finishStream({ ...state, error: { message: ev.message, code: ev.code }, messages: unsent ? updateMessage(state.messages, state.pendingUserMessageId, (m) => ({ ...m, unsent: true })) : state.messages });
    }
    default:
      return state;
  }
}

// ============================================================ mocks

/** Serialises course-chat events the way an edge function would stream them. */
export function encodeCourseChatSSE(events, { done = true } = {}) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

export function encodeTeacherSSE(events) {
  return events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** Chops text into network-ish chunks (deterministic). */
export function chunkText(text, sizes = [7, 3, 19, 1, 11, 5, 23, 2]) {
  const out = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const n = sizes[k % sizes.length];
    out.push(text.slice(i, i + n));
    i += n;
    k += 1;
  }
  return out;
}

function splitDeltas(text, sizes = [6, 3, 8, 4, 9, 2, 5]) {
  return chunkText(text, sizes);
}

const PASSAGE_ATTN = "p-attn-01";
const PASSAGE_SOFTMAX = "p-softmax-02";

export const MOCK_CHAT_QUESTION = "Why does the model pick “mat” instead of “moon” after “The cat sat on the”?";

const PROSE_P1 =
  "Great question. At every step the transformer turns the whole prompt into one vector per token, and the **last** token's vector is what gets scored against every word in the vocabulary [[SOURCE:" +
  PASSAGE_ATTN +
  "]].";
const PROSE_P2 =
  "Those scores (called *logits*) go through a softmax, which turns them into probabilities that add up to 1. “mat” wins because, in the training data, “sat on the” was followed by furniture-and-floor words far more often than by sky words [[SOURCE:" +
  PASSAGE_SOFTMAX +
  "]].";
const PROSE_P3 = "Here is the pipeline in three moves:";
// The model writes a marker itself mid-stream: it must never flash as raw text.
const STREAMED_MARKER = `{{interactive:lesson-stepper data='{"title":"From prompt to next word","steps":[{"label":"Embed","text":"Each token becomes a vector."},{"label":"Attend","text":"Layers mix context into the last vector."},{"label":"Score","text":"Logits -> softmax -> pick a word."}]}'}}`;
const PROSE_P4 = "Want to see how temperature changes the pick?";

export const MOCK_CHAT_STREAMED_TEXT = [PROSE_P1, PROSE_P2, PROSE_P3, STREAMED_MARKER, PROSE_P4].join("\n\n");

export function mockResolvedChatContent() {
  // Server post-processing: placeholders resolved into markers and spliced after paragraphs.
  let content = [PROSE_P1, PROSE_P2, PROSE_P3, STREAMED_MARKER, PROSE_P4].join("\n\n");
  const bars = embedToMarker({
    type: "bar_chart",
    title: "Next-word probabilities after “The cat sat on the”",
    unit: "%",
    bars: [
      { label: "mat", value: 41, highlighted: true, description: "Most frequent continuation in similar contexts." },
      { label: "floor", value: 22 },
      { label: "couch", value: 17 },
      { label: "roof", value: 9 },
      { label: "moon", value: 0.4, description: "Grammatical, but rare in this context." },
    ],
  });
  content = insertEmbedAfterParagraph(content, bars, 2);
  return content;
}

export const MOCK_CHAT_CITATIONS = [
  { url_citation: { url: "https://arxiv.org/abs/1706.03762", title: "Attention Is All You Need (Vaswani et al., 2017)", sourceId: "src-1", passageId: PASSAGE_ATTN, paragraph: 3, quote: "The decoder is auto-regressive, consuming the previously generated symbols as additional input." } },
  { url_citation: { url: "https://en.wikipedia.org/wiki/Softmax_function", title: "Softmax function", sourceId: "src-2", passageId: PASSAGE_SOFTMAX, paragraph: 1, quote: "The softmax function converts a vector of K real numbers into a probability distribution of K possible outcomes." } },
];

export const MOCK_QUICK_REPLIES = [{ text: "Show me temperature" }, { text: "What is a logit?" }, { text: "Quiz me on this", action: "start_quiz" }];

/** Realistic lesson-chat answer: search, prose deltas (with a raw marker), visuals pass, final, citations, chips. */
export function mockLessonChatEvents() {
  const events = [{ type: "status", status: "searching" }, { type: "status", status: "search_complete" }];
  for (const piece of splitDeltas(MOCK_CHAT_STREAMED_TEXT)) events.push({ type: "content", content: piece });
  events.push({ type: "status", status: "generating_visuals" });
  const resolved = mockResolvedChatContent();
  events.push({ type: "embed_progress", content: resolved });
  events.push({ type: "final", content: resolved });
  events.push({ type: "citations", citations: MOCK_CHAT_CITATIONS });
  events.push({ type: "quick_replies", quick_replies: MOCK_QUICK_REPLIES });
  return events;
}

/** Raw SSE body for the mock answer, chopped into irregular network chunks. */
export function mockLessonChatSSEChunks(sizes) {
  return chunkText(encodeCourseChatSSE(mockLessonChatEvents()), sizes);
}

/** Async generator with optional delay, useful for playback. */
export async function* mockLessonChatStream({ delayMs = 0, sizes } = {}) {
  for (const c of mockLessonChatSSEChunks(sizes)) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield c;
  }
}

export function mockTeacherEvents() {
  const visualMarkdown = "Here is the loop you just described:\n\n" + embedToMarker({ type: "loop", title: "Training loop", centerLabel: "repeat", stages: [{ label: "Predict" }, { label: "Measure loss" }, { label: "Nudge weights" }] });
  const quiz = { type: "quiz", quizId: "q1", kind: "mcq", question: "What does softmax output?", options: ["Probabilities", "Embeddings", "Tokens"], learnerAnswer: null, correct: null };
  return [
    { type: "thread", threadId: "t-1", title: "Transformers" },
    { type: "text_delta", text: "Let me make " },
    { type: "text_delta", text: "a quick visual." },
    { type: "tool_start", toolCallId: "c1", name: "show_visual", label: "Drawing a diagram" },
    { type: "tool_result", toolCallId: "c1", cards: [{ type: "visual", markdown: visualMarkdown }] },
    { type: "tool_start", toolCallId: "c2", name: "create_quiz", label: "Writing a question" },
    { type: "tool_result", toolCallId: "c2", cards: [quiz] },
    { type: "done", messageId: "m-42", cards: [{ ...quiz }, { type: "visual", markdown: visualMarkdown }] },
  ];
}
