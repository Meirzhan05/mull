// Fetch + parse a conversation-source NDJSON stream with chatgpt-dil's parser/validator and
// turn reducer. Calls back per record so the UI can render each revision.

import { ConversationSourceParser, ConversationTurn, CONTENT_TYPE } from '../../chatgpt-dil/src/stream.js';

export async function streamTurn(url, body, { onContent, onReasoning, onControl, signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: CONTENT_TYPE },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  if (!(res.headers.get('content-type') || '').startsWith(CONTENT_TYPE)) throw new Error('Unexpected response type');
  const turn = new ConversationTurn();
  let failure = null;
  let lastContent = null;
  const parser = new ConversationSourceParser((rec) => {
    const ev = turn.apply(rec);
    if (ev.type === 'content') { lastContent = { record: rec, message: ev.message }; onContent?.(ev.message, rec); }
    else if (ev.type === 'reasoning') onReasoning?.(rec.status || {}, rec);
    else if (ev.type === 'control') {
      if (rec.detail?.kind === 'failed') failure = rec.detail;
      onControl?.(rec.detail || {}, rec);
    }
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.finish();
  return { turn, message: turn.primary, failure, final: lastContent?.record };
}

export async function postJson(url, body, { signal } = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data || data.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
