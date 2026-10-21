// application/vnd.openai.conversation-source+ndjson parser, validator, turn reducer and
// replayer. Rules from conversation-source-client / conversation-source-turn (findings §1.2).

export const CONTENT_TYPE = 'application/vnd.openai.conversation-source+ndjson';
export const MAX_RECORD_BYTES = 6291456; // 6 MiB
export const MAX_DIL_BYTES = 262144;
export const RECORD_TYPES = ['content', 'control', 'reasoning', 'state', 'diagnostic', 'shared', 'media', 'end', 'paragen', 'primary-complete'];
export const DIL_KEYS = ['kind', 'renderer', 'status', 'code', 'constants', 'appData', 'requiredComponents', 'clientDefinedWidgets', 'fallbackMarkdown', 'viewState', 'viewStateSync'];

export class ConversationSourceError extends Error {
  constructor(message, code, line) {
    super(message);
    this.name = 'ConversationSourceError';
    this.code = code;
    this.line = line;
  }
}

const utf8Length = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s));

/** Validate one already-parsed record (shape level, as the client does before applying). */
export function validateRecord(rec, line) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new ConversationSourceError('Conversation source record is not an object', 'record_invalid', line);
  if (rec.version !== 1 && rec.version !== 2) throw new ConversationSourceError(`Unsupported ${CONTENT_TYPE} version`, 'version_unsupported', line);
  if (!RECORD_TYPES.includes(rec.type)) throw new ConversationSourceError(`Unknown conversation source record type: ${rec.type}`, 'type_unknown', line);
  if (rec.type === 'content') {
    if (typeof rec.messageId !== 'string' || !rec.messageId) throw new ConversationSourceError('Content record is missing messageId', 'content_invalid', line);
    if (!Number.isInteger(rec.revision) || rec.revision < 0) throw new ConversationSourceError('Content record has an invalid revision', 'content_invalid', line);
    if (rec.mode === 'append' && !Number.isInteger(rec.baseRevision)) throw new ConversationSourceError('Append record is missing baseRevision', 'content_invalid', line);
    if (rec.markdown != null && typeof rec.markdown !== 'string') throw new ConversationSourceError('Content markdown must be a string', 'content_invalid', line);
    if (rec.status != null && !['streaming', 'complete', 'retracted'].includes(rec.status)) throw new ConversationSourceError('Content record has an invalid status', 'content_invalid', line);
    if (rec.dil != null) validateDil(rec.dil, line);
  }
  if (rec.type === 'media' && rec.status != null && !['streaming', 'complete', 'retracted'].includes(rec.status)) {
    throw new ConversationSourceError('Media record has an invalid status', 'media_invalid', line);
  }
  return rec;
}

export function validateDil(dil, line) {
  const bad = typeof dil !== 'object' || dil.kind !== 'dil' || dil.renderer !== 'dil-v2' || dil.status !== 'pending' || typeof dil.code !== 'string'
    || !Object.keys(dil).every((k) => DIL_KEYS.includes(k));
  if (bad) throw new ConversationSourceError('Content record has an invalid dil payload', 'dil_invalid', line);
  if (utf8Length(JSON.stringify(dil)) > MAX_DIL_BYTES) throw new ConversationSourceError('DIL payload exceeds its limit', 'dil_too_large', line);
}

/**
 * Incremental parser: push() text chunks, receive validated records via onRecord.
 * Enforces: per-record byte limit, versions, known types, nothing after `end`,
 * and (on finish) that the stream ended with `end`.
 */
export class ConversationSourceParser {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.buffer = '';
    this.line = 0;
    this.ended = false;
    this.count = 0;
  }
  push(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this._line(raw);
    }
    if (this.buffer.length > MAX_RECORD_BYTES && utf8Length(this.buffer) > MAX_RECORD_BYTES) {
      throw new ConversationSourceError('Conversation source record exceeds its limit', 'record_too_large', this.line + 1);
    }
  }
  _line(raw) {
    this.line++;
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.trim() === '') return;
    if (utf8Length(text) > MAX_RECORD_BYTES) throw new ConversationSourceError('Conversation source record exceeds its limit', 'record_too_large', this.line);
    if (this.ended) throw new ConversationSourceError('Conversation source continued after its terminal record', 'after_end', this.line);
    let rec;
    try { rec = JSON.parse(text); } catch { throw new ConversationSourceError('Conversation source record is not valid JSON', 'json_invalid', this.line); }
    validateRecord(rec, this.line);
    if (rec.type === 'end') this.ended = true;
    this.count++;
    this.onRecord(rec, this.line);
  }
  finish() {
    if (this.buffer.trim() !== '') { const rest = this.buffer; this.buffer = ''; this._line(rest); }
    if (!this.ended) throw new ConversationSourceError('Conversation source ended before its terminal record', 'missing_end', this.line);
  }
}

/** Parse a whole NDJSON body into validated records. */
export function parseConversationSource(text) {
  const records = [];
  const p = new ConversationSourceParser((r) => records.push(r));
  p.push(text);
  p.finish();
  return records;
}

/**
 * Turn reducer (conversation-source-turn): folds records into per-message state.
 * `content` append: markdown = prev.markdown + rec.markdown, requires baseRevision === prev.revision;
 * replace: markdown = rec.markdown. Revisions must increase strictly. A record without `dil`
 * keeps the previous dil.
 */
export class ConversationTurn {
  constructor() {
    this.messages = new Map();
    this.order = [];
    this.controls = [];
    this.reasoning = null;
    this.conversationState = null;
    this.ended = false;
  }
  apply(rec) {
    switch (rec.type) {
      case 'content': return this._content(rec);
      case 'control': this.controls.push(rec.detail); return { type: 'control', detail: rec.detail };
      case 'reasoning': this.reasoning = { status: rec.status ?? this.reasoning?.status ?? null, activity: rec.activity ?? this.reasoning?.activity ?? null }; return { type: 'reasoning', reasoning: this.reasoning };
      case 'state': this.conversationState = rec.conversationState; return { type: 'state' };
      case 'end': this.ended = true; return { type: 'end' };
      default: return { type: rec.type };
    }
  }
  _content(rec) {
    const prev = this.messages.get(rec.messageId);
    if (prev && rec.revision <= prev.revision) throw new ConversationSourceError('Conversation source revision mismatch', 'revision_mismatch');
    let markdown;
    if (rec.mode === 'append') {
      if (!prev || rec.baseRevision !== prev.revision) throw new ConversationSourceError('Conversation source revision mismatch', 'revision_mismatch');
      markdown = prev.markdown + (rec.markdown ?? '');
    } else {
      markdown = rec.markdown ?? '';
    }
    const msg = {
      messageId: rec.messageId,
      revision: rec.revision,
      markdown,
      appended: rec.mode === 'append' ? rec.markdown ?? '' : markdown,
      dil: rec.dil ?? prev?.dil ?? null,
      dilChanged: rec.dil != null,
      references: rec.references ?? prev?.references ?? [],
      status: rec.status ?? prev?.status ?? 'streaming',
    };
    if (!prev) this.order.push(rec.messageId);
    this.messages.set(rec.messageId, msg);
    return { type: 'content', message: msg };
  }
  get primary() {
    const id = this.order[this.order.length - 1];
    return id ? this.messages.get(id) : null;
  }
}

/**
 * Replay records with a delay. `delay` may be a number (ms) or fn(rec, i) -> ms.
 * Returns {done: Promise, cancel()}.
 */
export function replayRecords(records, onRecord, { delay = 40, signal } = {}) {
  let cancelled = false;
  let timer = null;
  const done = new Promise((resolve, reject) => {
    let i = 0;
    const step = () => {
      if (cancelled || signal?.aborted) return resolve({ cancelled: true, index: i });
      if (i >= records.length) return resolve({ cancelled: false, index: i });
      try { onRecord(records[i], i); } catch (e) { return reject(e); }
      i++;
      const ms = typeof delay === 'function' ? delay(records[i - 1], i - 1) : delay;
      timer = setTimeout(step, Math.max(0, ms));
    };
    step();
  });
  return { done, cancel() { cancelled = true; if (timer) clearTimeout(timer); } };
}
