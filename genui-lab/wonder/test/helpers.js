import fs from 'node:fs';

process.env.WONDER_FIGURES ??= 'off'; // see test/index.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningRuntime, createMirror } from '../public/learning-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_FILES = ['transformers.md', 'sky-blue.md', 'compound-interest.md'];
export const demo = (name) => fs.readFileSync(path.join(here, '..', 'server', 'demo', name), 'utf8');

/** Run a compiled program in the chatgpt-dil runtime + learning catalog; returns a DOM-free mirror. */
export function runProgram({ code, constants, appData = {} }, { viewportWidth = 800 } = {}) {
  const mirror = createMirror();
  const errors = [];
  const actions = [];
  const rt = createLearningRuntime({
    viewportWidth,
    onOps: (ops) => mirror.apply(ops),
    onError: (e) => errors.push(e),
    onHostAction: (a) => actions.push(a),
    schedule: (fn) => fn(),
  });
  rt.render({ source: code, constants, appData });
  return { rt, mirror, errors, actions };
}

export const catalogNodes = (mirror, name) => mirror.findAll((n) => n.props?.__component === name);

/** Find a host node with an onClick whose subtree text contains `label`; click it. */
export function click(env, label, root) {
  const nodes = env.mirror.findAll((n) => n.props?.onClick && env.mirror.text(n).includes(label), root);
  if (!nodes.length) throw new Error(`no clickable "${label}"`);
  const target = nodes[nodes.length - 1]; // innermost match
  const r = env.rt.invokeFunction(target.props.onClick.__fn, []);
  if (!r.ok) throw new Error(`invoke failed: ${r.error}`);
  return target;
}

/** Minimal fake Anthropic client: records params, streams the given text deltas. */
export function fakeClient({ text = '', chunks, stopReason = 'end_turn', error, errorAfter = -1, structured } = {}) {
  const calls = { stream: [], create: [] };
  const pieces = chunks || (text ? text.match(/[\s\S]{1,40}/g) : []);
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          calls.stream.push({ params, opts });
          return {
            async *[Symbol.asyncIterator]() {
              if (error && errorAfter < 0) throw error;
              yield { type: 'message_start', message: { id: 'msg_fake' } };
              yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
              yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } };
              yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } };
              let i = 0;
              for (const p of pieces) {
                if (error && i === errorAfter) throw error;
                yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } };
                i++;
              }
              yield { type: 'message_delta', delta: { stop_reason: stopReason } };
            },
            async finalMessage() { return { id: 'msg_fake', stop_reason: stopReason, content: [{ type: 'text', text: pieces.join('') }] }; },
          };
        },
      },
    },
    messages: {
      async create(params) {
        calls.create.push(params);
        if (error) throw error;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(structured ?? {}) }] };
      },
    },
  };
}

/**
 * Fake streaming client for tool loops. `turns[i]` scripts the i-th stream call:
 *   {content:[{type:'thinking'|'text'|'tool_use', ...}], stop_reason, textChunks?} or {error}.
 * Text blocks stream as text_delta pieces (split with `|` in the text, or 25-char pieces);
 * tool_use blocks stream content_block_start + input_json_delta. Records a deep copy of
 * every request's params so later mutations of the message list don't leak into assertions.
 */
export function fakeToolClient(turns) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          calls.push({ params: structuredClone(params), opts });
          const turn = turns[Math.min(calls.length - 1, turns.length - 1)];
          const content = (turn.content || []).map((b) => (b.type === 'text' ? { type: 'text', text: b.text.replaceAll('|', '') } : b));
          return {
            async *[Symbol.asyncIterator]() {
              if (turn.error && turn.errorAt == null) throw turn.error;
              yield { type: 'message_start', message: { id: `msg_${calls.length}`, content: [] } };
              for (const [index, b] of (turn.content || []).entries()) {
                if (b.type === 'text') {
                  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
                  const pieces = b.text.includes('|') ? b.text.split('|') : b.text.match(/[\s\S]{1,25}/g) || [];
                  for (const p of pieces) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } };
                } else if (b.type === 'tool_use') {
                  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } };
                  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } };
                } else {
                  yield { type: 'content_block_start', index, content_block: b };
                }
                yield { type: 'content_block_stop', index };
              }
              if (turn.error) throw turn.error;
              yield { type: 'message_delta', delta: { stop_reason: turn.stop_reason || 'end_turn' } };
            },
            async finalMessage() {
              if (turn.error) throw turn.error;
              return { id: `msg_${calls.length}`, role: 'assistant', stop_reason: turn.stop_reason || 'end_turn', content: structuredClone(content) };
            },
          };
        },
      },
    },
    messages: { async create() { throw new Error('not scripted'); } },
  };
}

/** Collect every TeacherCard in a mirror. */
export const teacherCards = (mirror) => mirror.findAll((n) => n.props?.__component === 'TeacherCard');
