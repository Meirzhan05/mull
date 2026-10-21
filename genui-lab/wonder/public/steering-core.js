// Phase 4: mid-turn steering, shared by the server and the browser (no DOM, no Node APIs).
//
// ChatGPT steers a running turn with /backend-api/f/steer_turn and reports the outcome as
// `steering-status: accepted|rejected` and `steering-message` control records on the same
// stream (chatgpt-findings §1.5). Wonder does the same for lessons: the server keeps every
// complete "## " page, replaces the message tail (a `replace` content record with a higher
// revision), and continues with the learner's instruction applied.

export const STEER_CHIPS = Object.freeze([
  { label: 'Simpler', instruction: 'Make it simpler: plainer words, shorter sentences, one idea at a time.' },
  { label: 'More examples', instruction: 'Add more concrete, everyday examples.' },
  { label: 'Go deeper', instruction: 'Go deeper: more precise detail and the "why" behind each idea.' },
  { label: 'Shorter', instruction: 'Make the rest shorter: keep only the essentials.' },
]);

export const MAX_STEER_CHARS = 300;

/**
 * Keep everything before the "## " page that is still being written. With no page heading
 * yet, keep only a finished "# Title" line. Never cuts inside a code fence.
 */
export function trimToLastPage(markdown) {
  const md = String(markdown ?? '');
  const heads = [];
  let inFence = false;
  let pos = 0;
  for (const line of md.split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^## /.test(line)) heads.push(pos);
    pos += line.length + 1;
  }
  if (heads.length) return md.slice(0, heads[heads.length - 1]);
  const m = /^# [^\n]+\n/.exec(md);
  return m ? m[0] : '';
}

export const pageCount = (markdown) => (('\n' + String(markdown ?? '')).match(/\n## /g) || []).length;

/** Client reducer for steering controls: {status:'idle'|'pending'|'accepted'|'rejected', instruction, count}. */
export function steerReducer(state, event) {
  const s = state || { status: 'idle', instruction: '', count: 0 };
  switch (event?.type) {
    case 'request': return { ...s, status: 'pending', instruction: String(event.instruction || '') };
    case 'control':
      if (event.detail?.kind === 'steering-status') {
        const ok = event.detail.status === 'accepted';
        return { ...s, status: ok ? 'accepted' : 'rejected', count: s.count + (ok ? 1 : 0), reason: event.detail.reason };
      }
      return s;
    case 'rejected': return { ...s, status: 'rejected', reason: event.reason };
    case 'complete': return { ...s, status: 'idle' };
    default: return s;
  }
}
