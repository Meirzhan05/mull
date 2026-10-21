import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationSource, ConversationSourceParser, ConversationTurn, ConversationSourceError, replayRecords, MAX_RECORD_BYTES } from '../src/stream.js';
import { finalDil, finalMarkdown, streamText } from './helpers.js';

test('fixture: 87 valid version-2 records ending with end', () => {
  const recs = parseConversationSource(streamText());
  assert.equal(recs.length, 87);
  assert.ok(recs.every((r) => r.version === 2));
  assert.equal(recs.at(-1).type, 'end');
  const counts = {};
  for (const r of recs) counts[r.type] = (counts[r.type] || 0) + 1;
  for (const t of ['control', 'shared', 'reasoning', 'content', 'state', 'end']) assert.ok(counts[t] > 0, t);
});

test('fixture: reducing content records yields the final markdown and dil', () => {
  const turn = new ConversationTurn();
  for (const r of parseConversationSource(streamText())) turn.apply(r);
  const msg = turn.primary;
  assert.equal(msg.markdown, finalMarkdown());
  assert.equal(msg.status, 'complete');
  assert.equal(msg.revision, 70);
  assert.equal(msg.dil.code, finalDil().code);
  assert.deepEqual(msg.dil.constants, finalDil().constants);
  assert.ok(turn.ended);
  assert.ok(turn.conversationState);
});

test('incremental parser accepts arbitrary chunk boundaries', () => {
  const text = streamText();
  const out = [];
  const p = new ConversationSourceParser((r) => out.push(r));
  for (let i = 0; i < text.length; i += 7919) p.push(text.slice(i, i + 7919));
  p.finish();
  assert.equal(out.length, 87);
});

const rec = (o) => JSON.stringify({ version: 2, ...o });
const body = (...lines) => lines.join('\n') + '\n';

test('validation errors', () => {
  const expectCode = (text, code) => assert.throws(() => parseConversationSource(text), (e) => e instanceof ConversationSourceError && e.code === code);
  expectCode(body(rec({ type: 'control', detail: {} })), 'missing_end');
  expectCode(body(rec({ type: 'end' }), rec({ type: 'control', detail: {} })), 'after_end');
  expectCode(body(JSON.stringify({ version: 3, type: 'end' })), 'version_unsupported');
  expectCode(body(rec({ type: 'bogus' }), rec({ type: 'end' })), 'type_unknown');
  expectCode(body('{not json', rec({ type: 'end' })), 'json_invalid');
  expectCode(body(rec({ type: 'content', messageId: 'm', revision: 1, dil: { kind: 'dil', renderer: 'dil-v1', status: 'pending', code: '' } }), rec({ type: 'end' })), 'dil_invalid');
  expectCode(body(rec({ type: 'content', messageId: 'm', revision: 1, mode: 'append' }), rec({ type: 'end' })), 'content_invalid');
  const huge = rec({ type: 'diagnostic', payload: 'x'.repeat(MAX_RECORD_BYTES) });
  expectCode(body(huge, rec({ type: 'end' })), 'record_too_large');
  // version 1 is accepted
  assert.equal(parseConversationSource(body(JSON.stringify({ version: 1, type: 'end' }))).length, 1);
});

test('turn reducer enforces revision ordering and append bases', () => {
  const t = new ConversationTurn();
  t.apply({ version: 2, type: 'content', messageId: 'm', revision: 1, mode: 'replace', markdown: 'a' });
  t.apply({ version: 2, type: 'content', messageId: 'm', revision: 2, mode: 'append', baseRevision: 1, markdown: 'b' });
  assert.equal(t.primary.markdown, 'ab');
  assert.throws(() => t.apply({ version: 2, type: 'content', messageId: 'm', revision: 2, mode: 'append', baseRevision: 1, markdown: 'c' }), /revision mismatch/);
  assert.throws(() => t.apply({ version: 2, type: 'content', messageId: 'm', revision: 4, mode: 'append', baseRevision: 3, markdown: 'c' }), /revision mismatch/);
  t.apply({ version: 2, type: 'content', messageId: 'm', revision: 5, markdown: 'replaced' });
  assert.equal(t.primary.markdown, 'replaced');
});

test('replayer feeds records in order and can be cancelled', async () => {
  const recs = parseConversationSource(streamText());
  const seen = [];
  await replayRecords(recs, (r) => seen.push(r.type), { delay: 0 }).done;
  assert.equal(seen.length, 87);
  const seen2 = [];
  const r = replayRecords(recs, () => { seen2.push(1); if (seen2.length === 3) r.cancel(); }, { delay: 0 });
  const res = await r.done;
  assert.equal(res.cancelled, true);
  assert.equal(seen2.length, 3);
});
