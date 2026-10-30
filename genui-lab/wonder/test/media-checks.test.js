// Diagram and Figure quality: the Figure vision check (a fake client: a fitting image is kept, a
// mismatched one dropped, verdicts cached, failures fail open, the settle budget holds), the core
// option, the lint's valid_components check, the critic's diagram/figure text, and the eval's
// media stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFigureResolver, createFigureCheck, createCommonsLookup, figureCheckParams, figureRefs, FIGURE_CHECK_MODEL, FIGURE_CHECK_SCHEMA } from '../server/figures.js';
import { createWonderCore, createWonderServer } from '../server/app.js';
import { compileWonder, scanComponentTags, BROKEN_TAG_ERROR } from '../server/compile.js';
import { lintLesson, lessonMedia, mediaDigest, criticUserMessage, CRITIC_SYSTEM_PROMPT } from '../server/critic.js';
import { summarizeMedia, reportMarkdown, summarizeRuns } from '../server/judge.js';
import { parseArgs, runEval, lessonMediaReport } from '../evals/run.js';
import { parseConversationSource } from '../../chatgpt-dil/src/stream.js';
import { sampleLesson, fakeClient, runProgram } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const HEART = { found: true, src: 'https://upload.wikimedia.org/wikipedia/commons/1/11/Heart.png', width: 960, height: 800, title: 'Heart numlabels', license: 'CC BY-SA 3.0', author: 'Wapcaplet' };
const FIG = '<Figure query="human heart diagram" caption="The four chambers of the heart." question="Which chamber is largest?" answer="The left ventricle."/>';
const compiled = (md = FIG) => compileWonder(md, { salt: 't' });
const ridOf = (out) => figureRefs(out)[0].rid;
/** A fake client whose structured answer is chosen per call: verdict(params) -> object | Error. */
function checkClient(verdict) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params, options) {
        calls.push({ params, options });
        const v = verdict(params, calls.length);
        if (v instanceof Error) throw v;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(v) }] };
      },
    },
  };
}
const captionOf = (params) => /Caption: (.*)/.exec(params.messages[0].content[1].text)?.[1] || '';

test('figure check request: the thumbnail as an image block by URL, the text, a small structured call', () => {
  const ref = { ...figureRefs(compiled())[0] };
  const p = figureCheckParams(HEART, ref);
  assert.equal(p.model, FIGURE_CHECK_MODEL);
  assert.deepEqual(p.output_config, { effort: 'low', format: { type: 'json_schema', schema: FIGURE_CHECK_SCHEMA } });
  const [image, text] = p.messages[0].content;
  assert.deepEqual(image, { type: 'image', source: { type: 'url', url: HEART.src } });
  assert.equal(text.type, 'text');
  for (const line of ['Search phrase: human heart diagram', 'Commons file: Heart numlabels', 'Caption: The four chambers of the heart.', 'Question: Which chamber is largest?', 'Answer: The left ventricle.']) assert.ok(text.text.includes(line), line);
  assert.equal(figureCheckParams(HEART, ref, { model: 'claude-opus-5-5' }).model, 'claude-opus-5-5');
});

test('vision check: a matching figure is kept, a mismatched one is dropped as not found; verdicts are cached', async () => {
  const client = checkClient((params) => (captionOf(params).includes('chambers')
    ? { depicts: 'A heart cross-section.', fits: true, problem: '' }
    : { depicts: 'A heart cross-section.', fits: false, problem: 'The caption describes a camera lens.' }));
  const verify = createFigureCheck({ client });
  const cache = new Map();
  let lookups = 0;
  const lookup = async () => { lookups++; return HEART; };
  const good = compiled();
  const bad = compiled('<Figure query="human heart diagram" caption="Light bending through a camera lens."/>');

  const s1 = createFigureResolver({ lookup, verify, cache, logger: quiet });
  assert.deepEqual(s1.componentResults(good)[ridOf(good)], { status: 'pending' }, 'pending until lookup and check are done');
  s1.componentResults(bad);
  await s1.settle(1000);
  assert.deepEqual(s1.componentResults(good)[ridOf(good)], { status: 'resolved', state: { ...HEART, checked: true } });
  const dropped = s1.componentResults(bad)[ridOf(bad)];
  assert.equal(dropped.state.found, false);
  assert.deepEqual(dropped.state.rejected, { title: HEART.title, depicts: 'A heart cross-section.', problem: 'The caption describes a camera lens.' });
  assert.equal(dropped.state.tried, 1, 'the next lookup returned the same image, so there was nothing else to try');
  assert.equal(client.calls.length, 2, 'one check per figure text');
  assert.equal(lookups, 3, 'each caption is looked up once (the key includes the text), plus one retry for the rejected image');

  // a later stream (a steer, a reload) reuses both verdicts: no lookup, no check
  const s2 = createFigureResolver({ lookup, verify, cache, logger: quiet });
  assert.equal(s2.componentResults(good)[ridOf(good)].state.checked, true);
  assert.equal(s2.componentResults(bad)[ridOf(bad)].state.found, false);
  assert.equal(s2.pending, 0);
  assert.equal(client.calls.length, 2);
  assert.equal(lookups, 3);
});

test('vision check: a rejected image makes way for the next-best result, up to three images', async () => {
  const img = (n) => ({ ...HEART, src: `https://upload.wikimedia.org/wikipedia/commons/a/a${n}/Img${n}.jpg`, title: `Image ${n}` });
  const asked = [];
  const lookup = async (ref, { exclude } = {}) => { asked.push([...(exclude || [])].map((u) => u.match(/Img(\d)/)[1]).join(',')); return [1, 2, 3, 4].map(img).find((x) => !exclude?.has(x.src)) || null; };
  const out = compiled();
  // image 1 does not fit, image 2 does: it is kept as the second choice
  let checks = [];
  let verify = async (state) => { checks.push(state.title); return { fits: state.title === 'Image 2', depicts: state.title, problem: 'no' }; };
  let s = createFigureResolver({ lookup, verify, cache: new Map(), logger: quiet });
  s.componentResults(out);
  await s.settle(1000);
  assert.deepEqual(s.componentResults(out)[ridOf(out)].state, { ...img(2), checked: true, choice: 2 });
  assert.deepEqual(checks, ['Image 1', 'Image 2']);
  assert.deepEqual(asked, ['', '1'], 'the retry excludes the rejected image');
  // none fits: three images are tried, then the figure is not found
  checks = []; asked.length = 0;
  verify = async (state) => { checks.push(state.title); return { fits: false, depicts: state.title, problem: `${state.title} is wrong` }; };
  s = createFigureResolver({ lookup, verify, cache: new Map(), logger: quiet });
  s.componentResults(out);
  await s.settle(1000);
  assert.deepEqual(s.componentResults(out)[ridOf(out)].state, { found: false, rejected: { title: 'Image 3', depicts: 'Image 3', problem: 'Image 3 is wrong' }, tried: 3 });
  assert.deepEqual(checks, ['Image 1', 'Image 2', 'Image 3']);
  assert.deepEqual(asked, ['', '1', '1,2']);
  // tries: 1 checks only the first result
  checks = [];
  s = createFigureResolver({ lookup, verify, tries: 1, cache: new Map(), logger: quiet });
  s.componentResults(out);
  await s.settle(1000);
  assert.equal(s.componentResults(out)[ridOf(out)].state.tried, 1);
  assert.deepEqual(checks, ['Image 1']);
});

test('Commons lookup: exclude skips images already rejected, in rank order', async () => {
  const pages = [1, 2, 3].map((n) => ({ index: n, title: `File:Heart ${n}.jpg`, imageinfo: [{ mime: 'image/jpeg', width: 2000, height: 1500, thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/h/h${n}/Heart${n}.jpg/960px-Heart${n}.jpg`, thumbwidth: 960, thumbheight: 720, extmetadata: { LicenseShortName: { value: 'CC0' } } }] }));
  const fetch = async () => new Response(JSON.stringify({ query: { pages } }));
  const lookup = createCommonsLookup({ fetch });
  assert.equal((await lookup({ query: 'heart' })).title, 'Heart 1');
  const first = (await lookup({ query: 'heart' })).src;
  assert.equal((await lookup({ query: 'heart' }, { exclude: new Set([first]) })).title, 'Heart 2');
  const all = new Set(pages.map((p) => p.imageinfo[0].thumburl));
  assert.equal(await lookup({ query: 'heart' }, { exclude: all }), null);
});

test('vision check: a failed check keeps the image for this stream only; the next stream checks again', async () => {
  let fail = true;
  const client = checkClient(() => (fail ? Object.assign(new Error('overloaded'), { status: 529 }) : { depicts: 'A heart.', fits: true, problem: '' }));
  const verify = createFigureCheck({ client });
  const cache = new Map();
  const out = compiled();
  const s1 = createFigureResolver({ lookup: async () => HEART, verify, cache, logger: quiet });
  s1.componentResults(out);
  await s1.settle(1000);
  assert.deepEqual(s1.componentResults(out)[ridOf(out)].state, HEART, 'fail open: the unchecked image is shown');
  assert.equal(cache.size, 0, 'an unchecked image is not cached');
  fail = false;
  const s2 = createFigureResolver({ lookup: async () => HEART, verify, cache, logger: quiet });
  s2.componentResults(out);
  await s2.settle(1000);
  assert.deepEqual(s2.componentResults(out)[ridOf(out)].state, { ...HEART, checked: true });
  assert.equal(client.calls.length, 2);
  // no verdict in the answer counts as a failed check, too
  const empty = createFigureCheck({ client: checkClient(() => ({})) });
  await assert.rejects(empty(HEART, {}), /no verdict/);
  await assert.rejects(createFigureCheck({ client: null })(HEART, {}), /no Claude client/);
});

test('vision check: when the API cannot download the URL, the server sends the thumbnail inline once', async () => {
  const client = checkClient((params, n) => (n === 1
    ? Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Unable to download the file. Please verify the URL and try again."}}'), { status: 400 })
    : { depicts: 'A heart.', fits: true, problem: '' }));
  const fetched = [];
  const fetch = async (url, init) => { fetched.push({ url, ua: init.headers['User-Agent'] }); return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }); };
  const v = await createFigureCheck({ client, fetch })(HEART, { query: 'heart' });
  assert.equal(v.fits, true);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, HEART.src);
  assert.match(fetched[0].ua, /WonderLessons/);
  assert.deepEqual(client.calls[0].params.messages[0].content[0].source, { type: 'url', url: HEART.src });
  assert.deepEqual(client.calls[1].params.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: 'iVBORw==' });
  assert.ok(client.calls[0].options.signal instanceof AbortSignal, 'the call is abortable (stream signal + timeout)');
  // only a download error falls back; never for a URL outside the Wikimedia hosts
  const other = checkClient(() => Object.assign(new Error('400 bad schema'), { status: 400 }));
  await assert.rejects(createFigureCheck({ client: other, fetch })(HEART, {}), /bad schema/);
  const dl = checkClient(() => Object.assign(new Error('Unable to download the file'), { status: 400 }));
  await assert.rejects(createFigureCheck({ client: dl, fetch })({ ...HEART, src: 'https://evil.example/a.png' }, {}), /not a figure image URL/);
  assert.equal(fetched.length, 1);
});

test('vision check stays within the settle budget: a slow check is not waited for, then times out unchecked', async () => {
  let release;
  const verify = () => new Promise((r) => { release = r; });
  const cache = new Map();
  const out = compiled();
  const s = createFigureResolver({ lookup: async () => HEART, verify, cache, logger: quiet });
  s.componentResults(out);
  const t0 = Date.now();
  await s.settle(60);
  assert.ok(Date.now() - t0 < 500, 'settle returns at its budget');
  s.finalize();
  assert.deepEqual(s.componentResults(out)[ridOf(out)].state, { found: false }, 'still checking at the end of the stream -> not shown');
  release({ fits: true, depicts: '', problem: '' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal([...cache.values()][0].state.checked, true, 'the late verdict is cached for the next stream');
  // the check's own timeout (here 30 ms) aborts the request; the resolver then keeps the image unchecked
  const hang = { messages: { create: (_p, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) } };
  await assert.rejects(createFigureCheck({ client: hang, timeoutMs: 30 })(HEART, {}), /aborted/);
});

test('core option: the check is on with a Claude client, off without one, off with figureCheck:false or WONDER_FIGURE_CHECK=off', () => {
  const core = (o) => createWonderCore({ client: null, memoryFile: null, logger: quiet, figureLookup: null, ...o });
  const client = fakeClient();
  assert.equal(core({ client, env: {} }).state.figureCheck, FIGURE_CHECK_MODEL);
  assert.equal(core({ client, env: { WONDER_FIGURE_CHECK_MODEL: 'claude-opus-5-5' } }).state.figureCheck, 'claude-opus-5-5');
  assert.equal(core({ client, env: {}, figureCheckModel: 'claude-sonnet-5-5' }).state.figureCheck, 'claude-sonnet-5-5');
  assert.equal(core({ client: null, env: {} }).state.figureCheck, null);
  assert.equal(core({ client: null, env: {}, figureCheck: true }).state.figureCheck, null, 'no check without a client');
  assert.equal(core({ client, env: { WONDER_FIGURE_CHECK: 'off' } }).state.figureCheck, null);
  assert.equal(core({ client, env: {}, figureCheck: false }).state.figureCheck, null);
  assert.equal(core({ client }).state.figureCheck, null, 'tests run with WONDER_FIGURE_CHECK=off');
  assert.equal(core({ client, figureCheck: async () => ({ fits: true }) }).state.figureCheck, 'custom');
});

async function claudeLesson(text, serverOpts) {
  const client = fakeClient({ text, structured: { depicts: 'A diagram of a camera.', fits: false, problem: 'The caption is about clouds; the image shows a camera.' } });
  const server = createWonderServer({ client, logger: quiet, memoryFile: null, figureSettleMs: 2000, ...serverOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'why is the sky blue?', useWebSearch: false, verify: false }) });
    return { client, final: parseConversationSource(await res.text()).filter((r) => r.type === 'content').at(-1) };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('lesson stream (claude mode): the vision check runs on the found image and a mismatch leaves the Figure out', async () => {
  const { client, final } = await claudeLesson(sampleLesson('sky-blue.md'), { figureLookup: async () => HEART, figureCheck: true });
  assert.equal(final.status, 'complete');
  assert.equal(client.calls.create.length, 1, 'one check (the critic is off for this request)');
  assert.equal(client.calls.create[0].model, FIGURE_CHECK_MODEL);
  assert.deepEqual(client.calls.create[0].messages[0].content[0].source, { type: 'url', url: HEART.src });
  // the Figure's result only (the sky-blue sample also has a Video, left out here)
  const rid = [...final.dil.code.matchAll(/__dil\.jsx\(Figure,\{[^{}]*"__resolutionId":__dilConstants\["(\d+)"\]/g)].map((m) => final.dil.constants[m[1]]);
  const states = rid.map((r) => final.dil.appData.opGenui.componentResults[r]?.state).filter((s) => s && 'found' in s);
  assert.equal(states.length, 1);
  assert.equal(states[0].found, false);
  assert.match(states[0].rejected.problem, /camera/);
  const media = lessonMediaReport(sampleLesson('sky-blue.md'), final.dil);
  assert.equal(media.figures[0].found, false);
  assert.match(media.figures[0].rejected, /camera/);
});

// ---------------------------------------------------------------- broken tags

const BROKEN = 'Intro.\n\n<Diagram title="Heart" shapes={[{"type":"rect","x":1,"y":1,"w":9,"h":9}/>\n\nThe text **after** it.\n\n<Figure query="human heart diagram" caption="Chambers."/>\n\n## Page 2\n\nThe end.';
const texts = (r) => JSON.stringify(r.constants);

test('compile: a finished message keeps everything after a tag that never closes; a partial one still cuts there', () => {
  const final = compileWonder(BROKEN);
  assert.deepEqual(final.components.map((c) => [c.name, c.status, c.error]), [['Diagram', 'invalid', BROKEN_TAG_ERROR], ['Figure', 'valid', undefined]]);
  for (const t of ['The text ', 'after', 'Page 2', 'The end.']) assert.ok(texts(final).includes(t), t);
  assert.ok(!texts(final).includes('rect'), 'the broken tag\'s own paragraph is dropped, not shown as raw JSON');
  assert.match(final.fallbackMarkdown, /Intro\.\n\nThe text \*\*after\*\* it\.[\s\S]*## Page 2\n\nThe end\./);
  const env = runProgram(final);
  assert.deepEqual(env.errors, []);
  assert.match(env.mirror.text(env.mirror.root), /The text after it\.[\s\S]*The end\./);

  // while streaming, the same tag is a half-written tail: cut, and nothing after it yet
  const partial = compileWonder(BROKEN, { partial: true });
  assert.deepEqual(partial.components.map((c) => [c.name, c.status]), [['Diagram', 'streaming']]);
  assert.ok(!texts(partial).includes('Page 2'));
  // the scanner: broken spans to the end of its paragraph and scanning goes on
  const tags = scanComponentTags(BROKEN, { partial: false });
  assert.deepEqual(tags.map((t) => t.kind), ['broken', 'open']);
  assert.equal(BROKEN.slice(tags[0].end, tags[0].end + 2), '\n\n');
  assert.deepEqual(scanComponentTags(BROKEN).map((t) => t.kind), ['incomplete'], 'partial is the default');
  // a broken tag at the very end of a finished message
  const tail = compileWonder('Intro.\n\n<Diagram shapes={[{"type":"rect"');
  assert.deepEqual(tail.components.map((c) => c.status), ['invalid']);
  assert.ok(texts(tail).includes('Intro.'));
});

test('lesson stream: the final record of a lesson with a broken tag still has the rest of the lesson', async () => {
  const { final } = await claudeLesson(BROKEN, { figureLookup: null });
  assert.equal(final.status, 'complete');
  assert.ok(texts(final.dil).includes('The end.'));
  assert.deepEqual(runProgram(final.dil).errors, []);
});

// ---------------------------------------------------------------- lint and critic

test('lint: an invalid Diagram or Figure, or an unclosed tag, fails valid_components with its error', () => {
  const md = sampleLesson('sky-blue.md');
  const badDiagram = md.replace(/(<Diagram [^>]*?)width=\{\d+\}/, '$1width={5000}');
  let c = lintLesson(badDiagram).checks.find((x) => x.id === 'valid_components');
  assert.equal(c.ok, false);
  assert.match(c.detail, /1 invalid component\(s\) replaced by text: Diagram \(Diagram width must be 100-1000/);
  assert.deepEqual(lintLesson(badDiagram).stats.media, { Diagram: { valid: 0, invalid: 1 }, Figure: { valid: 1, invalid: 0 } });

  const badFigure = md.replace(/<Figure query="[^"]*"/, '<Figure query="https://example.com/clouds.jpg"');
  c = lintLesson(badFigure).checks.find((x) => x.id === 'valid_components');
  assert.equal(c.ok, false);
  assert.match(c.detail, /Figure \(Figure query is a search phrase, not a URL\)/);

  // unbalanced JSON never closes the tag: the lint fails it (the final compile drops its paragraph)
  const unclosed = 'Intro\n\n<Diagram shapes={[{"type":"rect","x":1}/>\n\n## Page 2\n\nMore.';
  c = lintLesson(unclosed).checks.find((x) => x.id === 'valid_components');
  assert.equal(c.ok, false);
  assert.match(c.detail, /Diagram \(Unclosed tag: its props have unbalanced braces or quotes\)/);
  assert.deepEqual(lessonMedia(unclosed).diagrams, [{ status: 'invalid', error: 'Unclosed tag: its props have unbalanced braces or quotes' }]);

  assert.equal(lintLesson(md).checks.find((x) => x.id === 'valid_components').ok, true);
  assert.deepEqual(lintLesson(md).stats.media, { Diagram: { valid: 1, invalid: 0 }, Figure: { valid: 1, invalid: 0 } });
});

test('critic: the prompt covers diagram parts/steps and figure captions, questions and answers; the message lists their text', () => {
  for (const re of [/Diagram/, /part's text/, /step's label and text/, /<Figure>/, /caption/, /question/, /answer/, /"factual"/, /"widget"/]) assert.match(CRITIC_SYSTEM_PROMPT, re);
  const md = sampleLesson('sky-blue.md');
  const digest = mediaDigest(md);
  assert.match(digest, /- Page 3, Figure:\n  query: cumulus clouds blue sky\n  caption: /);
  assert.match(digest, /question: Look at the clouds/);
  assert.match(digest, /answer: Cloud droplets are much bigger/);
  assert.match(digest, /- Page 4, Diagram:\n  title: Noon vs sunset/);
  assert.match(digest, /part "Sunset light": Skims sideways/);
  assert.match(digest, /step 2 "Sunset": Near the horizon/);
  assert.match(digest, /labels: Atmosphere · Noon sun/);
  const msg = criticUserMessage({ markdown: md, topic: 'sky', level: 'beginner' });
  assert.ok(msg.indexOf('Diagram and figure text') > msg.indexOf('</lesson>'));
  assert.ok(msg.includes(digest));
  // invalid components are not listed (the lint reports them); a lesson without media adds nothing
  assert.equal(mediaDigest(md.replace(/(<Diagram [^>]*?)width=\{\d+\}/, '$1width={5000}')).includes('Diagram:'), false);
  assert.equal(mediaDigest('# T\n\nHook.\n\n## A\n\nText.'), '');
  assert.ok(!criticUserMessage({ markdown: '# T\n\n## A\n\nText.', topic: 't' }).includes('Diagram and figure text'));
});

// ---------------------------------------------------------------- eval media stats

test('eval: per-lesson media (valid, found, dropped, not found) and the aggregate in the report', async () => {
  const md = `${FIG}\n\n<Figure query="water cycle diagram" caption="The water cycle."/>\n\n<Figure query="moon phases" caption="Phases."/>\n\n<Figure query="https://x.example/a.jpg"/>\n\n<Diagram shapes={[{"type":"blob"}]}/>`;
  const out = compiled(md);
  const [a, b, c] = figureRefs(out).map((r) => r.rid);
  const dil = { code: out.code, constants: out.constants, appData: { opGenui: { componentResults: {
    [a]: { status: 'resolved', state: { ...HEART, checked: true, choice: 2 } },
    [b]: { status: 'resolved', state: { found: false, rejected: { title: 'X', depicts: 'A map.', problem: 'Shows a map, not the cycle.' }, tried: 3 } },
    [c]: { status: 'resolved', state: { found: false } },
  } } } };
  const media = lessonMediaReport(md, dil);
  assert.deepEqual(media.figures.map((f) => [f.status, f.found ?? null, f.rejected ?? null]), [['valid', true, null], ['valid', false, 'Shows a map, not the cycle.'], ['valid', false, null], ['invalid', null, null]]);
  assert.equal(media.figures[0].image, HEART.title);
  assert.equal(media.figures[0].checked, true);
  assert.equal(media.figures[0].choice, 2);
  assert.equal(media.figures[1].tried, 3);
  assert.match(media.figures[3].error, /not a URL/);
  assert.equal(media.diagrams[0].status, 'invalid');

  const runs = [
    { topic: 'Heart', level: 'beginner', lint: { score: 1, failed: [] }, media },
    { topic: 'Lens', level: 'beginner', lint: { score: 1, failed: [] }, media: { diagrams: [{ status: 'valid', title: 'Lens', shapes: 9, parts: 3, steps: 4 }], figures: [] } },
    { topic: 'Broken', error: 'HTTP 500' },
  ];
  const m = summarizeMedia(runs.filter((r) => !r.error));
  assert.deepEqual(m, { lessons: 2, withDiagram: 2, withFigure: 1, withImage: 1, diagrams: { total: 2, valid: 1 }, figures: { total: 4, valid: 3, found: 1, laterChoice: 1, rejected: 1, missing: 1 } });
  const summary = summarizeRuns(runs);
  assert.deepEqual(summary.media, m);
  const report = reportMarkdown({ meta: { startedAt: 'now', model: 'm', webSearch: false, verify: true, judge: false }, summary, runs });
  assert.match(report, /## Diagrams and figures/);
  assert.match(report, /Diagram in 2\/2 lessons \(1\/2 valid\) · Figure in 1\/2 lessons \(3\/4 valid\) · images found 1\/3 \(1 after the vision check rejected the top result\), 1 dropped by the vision check, 1 not found · a shown image in 1\/2 lessons/);
  assert.match(report, /\| Lens \| 1 valid \(3 parts, 4 steps\) \| – \| – \|/);
  assert.match(report, /\| Heart \| 1 invalid \| 4: 3 valid, 1 invalid \| found: Heart numlabels \(choice 2\); dropped \(3 tried\): Shows a map, not the cycle.; not found \(moon phases\) \|/);
  assert.match(report, /- Figure invalid: Figure query is a search phrase/);
  assert.match(report, /- Diagram invalid: Shape 1 has unknown type/);
});

test('eval: --tag picks the physical/spatial topics; a run reports the sky-blue Diagram and its found Figure', async () => {
  assert.equal(parseArgs(['--tag', 'media']).tag, 'media');
  const topics = JSON.parse(fs.readFileSync(new URL('../evals/topics.json', import.meta.url), 'utf8'));
  const media = topics.filter((t) => t.tags?.includes('media'));
  assert.ok(media.length >= 4 && media.length <= 6, `${media.length} media topics`);
  assert.ok(media.some((t) => /heart/i.test(t.topic)) && media.some((t) => /lens/i.test(t.topic)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonder-eval-media-'));
  const file = path.join(dir, 'topics.json');
  fs.writeFileSync(file, JSON.stringify([{ topic: 'Why the sky is blue', tags: ['media'] }, { topic: 'Compound interest' }]));
  const CLOUDS = { ...HEART, title: 'Clouds in the sky' };
  const client = fakeClient({ text: sampleLesson('sky-blue.md') });
  const report = await runEval({ ...parseArgs(['--tag', 'media', '--no-judge', '--no-verify']), topics: file }, { serverOpts: { client, figureLookup: async () => CLOUDS, figureSettleMs: 2000 }, log() {} });
  assert.equal(report.runs.length, 1, 'only the tagged topic');
  assert.equal(report.meta.tag, 'media');
  assert.equal(report.meta.figureCheck, null, 'the tests run with WONDER_FIGURE_CHECK=off');
  const r = report.runs[0];
  assert.deepEqual(r.media.diagrams.map((d) => [d.status, d.parts, d.steps]), [['valid', 4, 3]]);
  assert.deepEqual(r.media.figures.map((f) => [f.status, f.found, f.image]), [['valid', true, 'Clouds in the sky']]);
  assert.deepEqual(report.summary.media.figures, { total: 1, valid: 1, found: 1, laterChoice: 0, rejected: 0, missing: 0 });
});
