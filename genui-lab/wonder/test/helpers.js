import fs from 'node:fs';

process.env.WONDER_FIGURES ??= 'off'; // see test/index.js
process.env.WONDER_VIDEOS ??= 'off';
process.env.WONDER_FIGURE_CHECK ??= 'off';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningRuntime, createMirror } from '../public/learning-runtime.js';
import { citeTag } from '../server/grounding.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// hand-written lessons in the catalog's format (test/fixtures/lessons), for the compiler, catalog and pipeline tests
export const LESSON_FILES = ['transformers.md', 'sky-blue.md', 'compound-interest.md'];
export const sampleLesson = (name) => fs.readFileSync(path.join(here, 'fixtures', 'lessons', name), 'utf8');

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

/**
 * Minimal fake Anthropic client: records params, streams the given text deltas (40-char pieces,
 * `delayMs` apart when set: a slow stream that stops when the request is aborted).
 */
export function fakeClient({ text = '', chunks, stopReason = 'end_turn', error, errorAfter = -1, structured, delayMs = 0 } = {}) {
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
                if (delayMs) {
                  if (opts?.signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
                  await new Promise((r) => setTimeout(r, delayMs));
                }
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

/** A fakeClient whose reply depends on the request: `reply(params)` returns fakeClient options. */
export function fakeClientBy(reply) {
  const calls = { stream: [], create: [] };
  return {
    calls,
    beta: { messages: { stream(params, opts) { calls.stream.push({ params, opts }); return fakeClient(reply(params)).beta.messages.stream(params, opts); } } },
    messages: { async create(params) { calls.create.push(params); return fakeClient(reply(params)).messages.create(params); } },
  };
}

/** The text of a request's last user turn (a string, or the text blocks of a content array). */
export const lastUserText = (params) => {
  const c = params.messages.filter((m) => m.role === 'user').at(-1)?.content;
  return typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};

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

/**
 * Fake client for server-tool turns: each element of `turns` is one API response, a list of
 * content blocks ({type:'text', text, citations?} | {type:'server_tool_use', id, name, input} |
 * {type:'web_search_tool_result', tool_use_id, content}) streamed as SDK events, plus stop_reason.
 */
export function groundedClient(turns) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          const turn = turns[Math.min(calls.length, turns.length - 1)];
          calls.push({ params: structuredClone(params), opts });
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { id: `msg_${calls.length}` } };
              for (const [index, b] of turn.blocks.entries()) {
                if (b.type === 'text') {
                  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } };
                  for (const c of b.citations || []) yield { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: c } };
                  for (const piece of b.text.match(/[\s\S]{1,7}/g) || []) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } };
                } else if (b.type === 'server_tool_use') {
                  yield { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id: b.id, name: b.name, input: {} } };
                  const json = JSON.stringify(b.input);
                  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } };
                  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } };
                } else {
                  yield { type: 'content_block_start', index, content_block: b };
                }
                yield { type: 'content_block_stop', index };
              }
              yield { type: 'message_delta', delta: { stop_reason: turn.stop_reason } };
            },
            async finalMessage() { return { id: `msg_${calls.length}`, stop_reason: turn.stop_reason, content: turn.blocks }; },
          };
        },
      },
    },
    messages: { async create() { throw new Error('unused'); } },
  };
}

/**
 * Web-search citations for the sky-blue sample: each lands right after the exact phrase `after`
 * (short paraphrases written for the tests, not quotes from the pages).
 */
export const SKY_CITATIONS = Object.freeze([
  { after: 'and it is wildly unfair to long waves', url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering', title: 'Rayleigh scattering - Wikipedia', cited_text: 'Rayleigh scattering intensity is inversely proportional to the fourth power of the wavelength, so blue light scatters far more than red.' },
  { after: 'your eyes are much more sensitive to blue than to violet', url: 'https://spaceplace.nasa.gov/blue-sky/en/', title: 'Why Is the Sky Blue? | NASA Space Place', cited_text: 'Blue light is scattered in all directions by the gases and particles in the air, which is why we see a blue sky most of the time.' },
  { after: 'a path up to about 38 times longer', url: 'https://en.wikipedia.org/wiki/Air_mass_(astronomy)', title: 'Air mass (astronomy) - Wikipedia', cited_text: 'At the horizon the relative air mass reaches roughly 38, compared with 1 when the sun is directly overhead.' },
  { after: 'its sunsets glow **blue**', url: 'https://en.wikipedia.org/wiki/Atmosphere_of_Mars', title: 'Atmosphere of Mars - Wikipedia', cited_text: 'Fine dust in the Martian atmosphere scatters blue light toward the sun, so sunsets on Mars appear blue.' },
]);
const citation = (c) => ({ type: 'web_search_result_location', url: c.url, title: c.title, encrypted_index: 'x', cited_text: c.cited_text });

/** Text blocks for groundedClient: `markdown` split right after each cited phrase it contains. */
export function citedBlocks(markdown, cites = SKY_CITATIONS) {
  const blocks = [];
  let pos = 0;
  for (const c of cites.map((c) => ({ ...c, at: markdown.indexOf(c.after) })).filter((c) => c.at >= pos).sort((a, b) => a.at - b.at)) {
    const end = c.at + c.after.length;
    blocks.push({ type: 'text', text: markdown.slice(pos, end), citations: [citation(c)] });
    pos = end;
  }
  if (pos < markdown.length) blocks.push({ type: 'text', text: markdown.slice(pos) });
  return blocks;
}

/** The lesson with <Cite/> tags placed the way the live path places them, sources in `registry`. */
export function citeLesson(markdown, registry, cites = SKY_CITATIONS) {
  return citedBlocks(markdown, cites).map((b) => b.text + (b.citations ? citeTag(b.citations.map((c) => registry.cite(c))) : '')).join('');
}

// a lesson cut off mid-page, for steering: steerableClient streams it, then stalls until a steer
export const STEADY_LESSON = '# Steady lesson\n\nA hook sentence here.\n\n## Page one\n\nFirst page text that is complete.\n\n## Page two\n\nSecond page is still being wr';

/** Fake client: the first stream emits STEADY_LESSON slowly and stalls until aborted; later streams emit `rest`. */
export function steerableClient(rest) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          const n = calls.push({ params: structuredClone(params), opts });
          const signal = opts?.signal;
          const text = n === 1 ? STEADY_LESSON : rest;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
              for (const piece of text.match(/[\s\S]{1,12}/g)) {
                if (signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } };
                await new Promise((r) => setTimeout(r, 1));
              }
              if (n === 1) {
                // stall like a long generation until the steer aborts us
                await new Promise((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', resolve, { once: true }); });
                throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
              }
              yield { type: 'content_block_stop', index: 0 };
            },
            async finalMessage() { return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }; },
          };
        },
      },
    },
    messages: { async create() { throw new Error('unused'); } },
  };
}
