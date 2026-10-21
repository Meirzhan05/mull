// Phase 4: mid-turn steering for lessons (ChatGPT steer_turn, chatgpt-findings §1.5).
//
//   POST /api/lesson/steer {operationId, instruction}
//     -> the in-flight lesson operation aborts its current Claude (or demo) stream
//     -> the open NDJSON response emits control steering-status accepted + steering-message,
//        a `replace` content record with the kept pages (trimmed to the last complete "## ")
//     -> a continuation request streams the rest: the original lesson request + a user turn
//        holding the lesson so far + the instruction. No assistant prefill.

import { trimToLastPage, MAX_STEER_CHARS, STEER_CHIPS } from '../public/steering-core.js';
import { stripGroundingTags } from './grounding.js';

export { trimToLastPage };

/** In-flight steerable operations, keyed by the NDJSON operationId. */
export function createSteeringRegistry() {
  const ops = new Map();
  return {
    /** Register an operation. `parent` is the response-close signal. */
    open(operationId, parent, { onReject } = {}) {
      let ctrl = null;
      let pendingSteer = null;
      const op = {
        operationId,
        steerCount: 0,
        /** A fresh AbortSignal for the next upstream attempt (aborted by steer or by `parent`). */
        attempt() {
          ctrl = new AbortController();
          if (parent?.aborted) ctrl.abort();
          else parent?.addEventListener('abort', () => ctrl.abort(), { once: true });
          return ctrl.signal;
        },
        steer(instruction) {
          if (!ctrl || parent?.aborted || pendingSteer) { onReject?.(pendingSteer ? 'busy' : 'not_streaming', instruction); return false; }
          pendingSteer = instruction;
          op.steerCount++;
          ctrl.abort();
          return true;
        },
        takeSteer() { const s = pendingSteer; pendingSteer = null; return s; },
        get hasSteer() { return pendingSteer != null; },
        close() { ops.delete(operationId); },
      };
      ops.set(operationId, op);
      return op;
    },
    get(operationId) { return ops.get(operationId) || null; },
    get size() { return ops.size; },
  };
}

export function cleanInstruction(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STEER_CHARS);
}

/**
 * The continuation request's single user turn: the original request, the lesson so far
 * (already on screen) and the instruction. Server-inserted Cite/Sources tags are removed so
 * Claude does not imitate them.
 */
export function steeringUserContent(originalRequest, keptMarkdown, instruction) {
  const kept = stripGroundingTags(keptMarkdown).trim();
  return [
    { type: 'text', text: String(originalRequest) },
    {
      type: 'text',
      text: [
        'You already started this lesson and the learner is reading it. Here is everything shown so far:',
        `<lesson_so_far>\n${kept || '(nothing yet)'}\n</lesson_so_far>`,
        `While it was streaming, the learner asked you to change course: "${instruction}"`,
        kept
          ? 'Continue the lesson from here, applying that request to every remaining page. Start directly with the next "## " page heading. Do not repeat or rewrite anything above, and do not acknowledge the request in prose. Keep the lesson format, and still finish with the "## Check your understanding" page and its Quiz.'
          : 'Write the whole lesson now with that request applied, following the lesson format.',
      ].join('\n\n'),
    },
  ];
}

// ---------------------------------------------------------------- demo mode

const isProse = (block) => !/^\s*[<|>#-]/.test(block) && !/^\s*\d+\.\s/.test(block);

function shorten(paragraph) {
  if (/[<{]/.test(paragraph)) return paragraph; // tags inside: keep intact
  const sentences = paragraph.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return sentences.slice(0, 2).join(' ');
}

/**
 * Deterministic "steered" rewrite of the remaining demo pages: each page keeps its heading,
 * its first prose paragraph (two sentences at most) and every visual; extra prose is dropped.
 * The quiz page is kept as is. A tip callout acknowledges the request on the first page.
 */
export function steerDemoRemainder(remaining, instruction) {
  const text = String(remaining ?? '');
  const pages = text.split(/\n(?=## )/);
  const chip = STEER_CHIPS.find((c) => c.instruction === instruction || c.label.toLowerCase() === String(instruction || '').trim().toLowerCase());
  const label = (chip ? chip.label : String(instruction || 'Simpler')).replace(/["<>{}\\]/g, '').slice(0, 60);
  let acknowledged = false;
  const out = pages.map((page) => {
    const lines = page.split('\n');
    if (!/^## /.test(lines[0]) || /^## Check your understanding/i.test(lines[0])) return page;
    const blocks = lines.slice(1).join('\n').split(/\n{2,}/);
    const kept = [];
    let prose = 0;
    for (const b of blocks) {
      if (!b.trim()) continue;
      if (isProse(b)) { if (prose++ === 0) kept.push(shorten(b.trim())); continue; }
      kept.push(b.trim());
    }
    if (!acknowledged) acknowledged = true, kept.unshift(`<Callout title="Steered: ${label}" tone="tip">Got it. The rest of this lesson keeps each page to its core idea, in fewer words.</Callout>`);
    return `${lines[0]}\n\n${kept.join('\n\n')}\n`;
  });
  return out.join('\n');
}
