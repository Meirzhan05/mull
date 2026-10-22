// application/vnd.openai.conversation-source+ndjson writer (findings §1.2, §8.1).
//
// One assistant turn = control started -> reasoning -> content rev 1 (replace, empty) ->
// content rev 2..n (append + baseRevision, markdown delta, a full recompiled `dil` every
// ~150 ms or whenever a tag closes) -> final content (status complete, full dil,
// followupPrompts) -> state -> control message-stream-complete -> control terminal-received
// -> end. Failures end with control failed -> end. Every record is checked with
// chatgpt-dil's validateRecord before it is written, so the client parser always accepts it.

import { randomUUID } from 'node:crypto';
import { validateRecord, CONTENT_TYPE, MAX_DIL_BYTES } from '../../chatgpt-dil/src/stream.js';
import { compileWonder, toWonderDil } from './compile.js';

export { CONTENT_TYPE };

export function createTurnWriter({ write, messageId = randomUUID(), operationId = randomUUID(), now = () => Date.now(), dilIntervalMs = 150, appData, appDataFor } = {}) {
  let revision = 0;
  let markdown = '';
  let lastDilAt = -Infinity;
  let lastDilLen = 0;
  let finished = false;
  const reasoningItems = [];

  const emit = (rec) => {
    const full = { version: 2, ...rec };
    validateRecord(full);
    write(JSON.stringify(full) + '\n');
  };

  function buildDil(partial) {
    try {
      const r = compileWonder(markdown, { partial, salt: messageId, fallback: !partial });
      const dil = toWonderDil(r, appDataFor ? appDataFor(r) : appData); // appDataFor: Phase 3 resolved citations
      if (Buffer.byteLength(JSON.stringify(dil)) > MAX_DIL_BYTES) return { dil: null, result: r };
      return { dil, result: r };
    } catch {
      return { dil: null, result: null };
    }
  }

  const api = {
    messageId,
    operationId,
    get markdown() { return markdown; },
    get revision() { return revision; },
    control(kind, extra = {}) { emit({ type: 'control', detail: { operationId, kind, ...extra } }); },
    reasoning(text, { active = true, icon = 'sparkles' } = {}) {
      if (text && reasoningItems[reasoningItems.length - 1] !== text) reasoningItems.push(text);
      emit({
        type: 'reasoning',
        status: { active, text, transient: true, items: [...reasoningItems], toolIcons: [icon], reasoning: { status: active ? 0 : 1 } },
        activity: { records: reasoningItems.map((t, i) => ({ sourceId: `${messageId}:r${i}`, kind: 'activity', text: t, toolIcons: [icon] })), active },
      });
    },
    start({ conversationId } = {}) {
      api.control('started', { streamType: 'initial' });
      if (conversationId) api.control('conversation-id', { conversationId });
      revision = 1;
      emit({ type: 'content', messageId, revision, mode: 'replace', markdown: '', status: 'streaming' });
    },
    append(delta) {
      if (finished || !delta) return;
      if (revision === 0) api.start();
      markdown += delta;
      revision++;
      // a tag closed since the last compiled revision -> recompile now (widget pops in)
      const tagClosed = /\/>|<\/[A-Za-z][\w.-]*\s*>/.test(markdown.slice(Math.max(0, lastDilLen - 2)));
      const rec = { type: 'content', messageId, revision, mode: 'append', baseRevision: revision - 1, markdown: delta, status: 'streaming' };
      if (revision === 2) api.control('assistant-content-started');
      if (tagClosed || now() - lastDilAt >= dilIntervalMs) {
        const { dil } = buildDil(true);
        if (dil) { rec.dil = dil; lastDilAt = now(); lastDilLen = markdown.length; }
      }
      emit(rec);
    },
    // Phase 4 (steering): replace the whole message (kept pages) in one record. Same messageId,
    // revision keeps increasing, so chatgpt-dil's ConversationTurn accepts it as a replace.
    replace(next) {
      if (finished) return;
      if (revision === 0) api.start();
      markdown = String(next ?? '');
      revision++;
      const rec = { type: 'content', messageId, revision, mode: 'replace', markdown, status: 'streaming' };
      const { dil } = buildDil(true);
      if (dil) { rec.dil = dil; lastDilAt = now(); lastDilLen = markdown.length; }
      emit(rec);
    },
    /** Final record + trailer. Returns the final compile result. */
    complete({ followupPrompts, defaultFollowups, truncated = false, conversationState } = {}) {
      if (finished) return null;
      if (revision === 0) api.start();
      finished = true;
      const { dil, result } = buildDil(false);
      revision++;
      const prompts = (followupPrompts ?? (result?.followups?.length ? result.followups : defaultFollowups) ?? []).filter(Boolean).slice(0, 3);
      const rec = { type: 'content', messageId, revision, mode: 'append', baseRevision: revision - 1, markdown: '', status: 'complete', conversationFollowupSuggestionsEligible: prompts.length > 0 };
      if (dil) rec.dil = dil;
      if (prompts.length) rec.followupPrompts = prompts;
      if (truncated) rec.debug = { truncated: true };
      emit(rec);
      if (reasoningItems.length) api.reasoning(reasoningItems[reasoningItems.length - 1], { active: false });
      emit({ type: 'state', conversationState: conversationState ?? { messageId, revision, components: (result?.components || []).map((c) => ({ name: c.name, status: c.status })) } });
      api.control('message-stream-complete', { truncated });
      api.control('terminal-received');
      emit({ type: 'end' });
      return result;
    },
    fail(message, code = 'failed', { retryAfterMs } = {}) {
      if (finished) return;
      finished = true;
      api.control('failed', { message, code, ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) });
      emit({ type: 'end' });
    },
    get finished() { return finished; },
  };
  return api;
}
