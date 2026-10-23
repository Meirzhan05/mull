// <Video/>: validation, picking a video and its segment (chapters), the YouTube lookup, the
// per-stream resolver, the sandbox component (predict -> player -> cue -> questions), the embed
// policy and the lesson stream. No network: every lookup here is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVideo, videoFallback, parseDuration, parseChapters, pickSegment, videoCandidate, pickVideo, createYouTubeLookup, createDemoVideoLookup, createVideoResolver, DEMO_VIDEOS, CLIP } from '../server/videos.js';
import { createFigureResolver } from '../server/figures.js';
import { combineResolvers } from '../server/media-resolver.js';
import { validateComponentProps } from '../server/catalog-schema.js';
import { compileWonder } from '../server/compile.js';
import { lintLesson } from '../server/critic.js';
import { lessonRecipe } from '../public/outcomes-core.js';
import { createWonderServer } from '../server/app.js';
import { createVideoEmbedPolicy } from '../public/dil-surface.js';
import { isVideoId, videoIdsOf } from '../public/video-hosts.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../server/prompts.js';
import { parseConversationSource } from '../../chatgpt-dil/src/stream.js';
import { createLearningRuntime, createMirror } from '../public/learning-runtime.js';
import { demo, runProgram, catalogNodes } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const CLIP_STATE = { found: true, videoId: 'Ab3_dEf-9hI', start: 65, end: 190, duration: 300, title: 'Why is the sky blue?', channel: 'Physics Girl', chapter: 'Why blue light scatters', pageUrl: 'https://www.youtube.com/watch?v=Ab3_dEf-9hI&t=65s' };
const PREDICT = { when: 'before', prompt: 'Which color scatters more?', options: ['Red', 'Blue'], correct_values: ['Blue'], explanation: 'Shorter waves scatter more.' };
const AFTER = { prompt: 'Why are sunsets red?', options: [{ value: 'a', label: 'A long path through air' }, { value: 'b', label: 'Dust' }], correct_values: ['a'], explanation: 'The blue is scattered out on the way.' };
const item = (over = {}, { snippet = {}, contentDetails = {}, status = {} } = {}) => ({
  id: 'Ab3_dEf-9hI', ...over,
  snippet: { title: 'Why is the sky blue?', channelTitle: 'Physics Girl', liveBroadcastContent: 'none', description: '0:00 Intro\n1:05 Why blue light scatters\n3:10 Sunsets', ...snippet },
  contentDetails: { duration: 'PT5M', caption: 'true', ...contentDetails },
  status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', ...status },
});

test('valid Video props normalize; ids, URLs and bad questions are refused', () => {
  const r = validateVideo({ search: '  rayleigh   scattering ', show: 'why blue scatters', caption: 'Watch.', questions: [PREDICT, { ...AFTER, when: 'end', hint: 'think' }] });
  assert.ok(r.ok, r.error);
  assert.equal(r.props.query, 'rayleigh scattering');
  assert.equal(r.props.shows, 'why blue scatters');
  assert.deepEqual(r.props.questions.map((q) => [q.id, q.when, q.question_type, q.correct_values]), [['q1', 'before', 'single_select', ['b']], ['q2', 'after', 'single_select', ['a']]]);
  assert.equal(r.props.questions[1].hint, undefined, 'no hints: the clip is the hint');
  assert.equal(validateVideo({ query: 'pendulum', questions: [{ prompt: 'It swings?', question_type: 'true_false', correct_values: ['true'] }] }).props.questions[0].question_type, 'true_false');
  assert.deepEqual(validateVideo({ query: 'pendulum' }).props, { query: 'pendulum' });
  assert.ok(validateComponentProps('Video', { query: 'pendulum motion' }).ok, 'registered in the learning catalog');
  const bad = (p, re) => { const v = validateVideo(p); assert.equal(v.ok, false, JSON.stringify(p)); assert.match(v.error, re); };
  bad({}, /needs query/);
  bad({ query: 'ab' }, /too short/);
  bad({ query: 'https://youtube.com/watch?v=x' }, /not a URL/);
  bad({ query: 'see youtu.be/abc' }, /not a URL/);
  bad({ query: 'pendulum', videoId: 'dQw4w9WgXcQ' }, /never a video id or URL/);
  bad({ query: 'pendulum', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, /never a video id or URL/);
  bad({ query: 'pendulum', questions: [PREDICT, { ...PREDICT }] }, /at most one "before"/);
  bad({ query: 'pendulum', questions: [AFTER, AFTER, AFTER] }, /at most 2 "after"/);
  bad({ query: 'pendulum', questions: [AFTER, AFTER, AFTER, AFTER] }, /at most 3 questions/);
  bad({ query: 'pendulum', questions: [{ ...AFTER, question_type: 'multi_select', correct_values: ['a', 'b'] }] }, /single choice/);
  bad({ query: 'pendulum', questions: [{ prompt: 'x?' }] }, /Video question 1 needs/);
  assert.equal(videoFallback({ caption: 'A <b> clip' }), '*A ‹b> clip*');
  assert.equal(videoFallback({ query: 'x' }), '');
});

test('segments: chapters by YouTube rules, the best-matching chapter plays, else the start', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT4M'), 240);
  assert.equal(parseDuration('P0D'), 0);
  assert.ok(Number.isNaN(parseDuration('4:00')));
  const ch = parseChapters('Great video!\n\n0:00 Intro\n1:05 - Why blue light scatters\n(3:10) Sunsets\n\nThanks to Ann at 1:00', 300);
  assert.deepEqual(ch, [{ start: 0, title: 'Intro', end: 65 }, { start: 65, title: 'Why blue light scatters', end: 190 }, { start: 190, title: 'Sunsets', end: 300 }]);
  assert.deepEqual(parseChapters('Intro – 0:00\nRayleigh – 0:45\nSunsets – 2:30', 200).map((c) => c.start), [0, 45, 150], 'timestamps after the title');
  assert.deepEqual(parseChapters('1:00 A\n2:00 B\n3:00 C', 300), [], 'must start at 0:00');
  assert.deepEqual(parseChapters('0:00 A\n1:00 B', 300), [], 'at least three');
  assert.deepEqual(parseChapters('0:00 A\n0:05 B\n1:00 C', 300), [], 'each at least 10 s');
  assert.deepEqual(parseChapters('0:00 A\n1:00 B\n9:00 C', 300), [], 'past the end');
  const seg = (shows, duration = 300, chapters = ch) => pickSegment({ duration, chapters, query: 'sky blue', shows });
  assert.deepEqual(seg('why blue light scatters more than red'), { start: 65, end: 190, chapter: 'Why blue light scatters' });
  assert.deepEqual(seg('red sunsets'), { start: 190, end: 300, chapter: 'Sunsets' }, 'plural/singular match');
  assert.deepEqual(seg('the intro'), { start: 0, end: CLIP.cap }, 'filler chapters (Intro) never win: a 5-minute video plays its start, capped');
  assert.deepEqual(seg('anything', 200, []), { start: 0, end: 200 }, 'a short video plays whole');
  assert.deepEqual(seg('nothing related', 900, []), { start: 0, end: CLIP.cap }, 'a long video without a match plays its start, capped');
  const long = [{ start: 0, title: 'Intro', end: 60 }, { start: 60, title: 'Scattering', end: 900 }];
  assert.deepEqual(seg('scattering', 900, long), { start: 60, end: 60 + CLIP.short, chapter: 'Scattering' }, 'a long chapter is capped');
});

test('candidates: only public, embeddable, unrestricted, normal-length videos; chapter matches and short videos win', () => {
  const c = videoCandidate(item(), 0, { query: 'sky blue', shows: 'why blue light scatters' });
  assert.deepEqual(c.state, CLIP_STATE);
  for (const [why, it] of [
    ['not embeddable', item({}, { status: { embeddable: false } })],
    ['unlisted', item({}, { status: { privacyStatus: 'unlisted' } })],
    ['live', item({}, { snippet: { liveBroadcastContent: 'live' } })],
    ['age restricted', item({}, { contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } } })],
    ['region restricted', item({}, { contentDetails: { regionRestriction: { blocked: ['DE'] } } })],
    ['too long', item({}, { contentDetails: { duration: 'PT45M' } })],
    ['too short', item({}, { contentDetails: { duration: 'PT12S' } })],
    ['a Short', item({}, { snippet: { title: 'Sky! #shorts' } })],
    ['bad id', item({ id: 'nope' })],
  ]) assert.equal(videoCandidate(it, 0, { query: 'sky' }), null, why);
  assert.equal(videoCandidate(item({}, { snippet: { title: 'Why &quot;blue&quot;?', description: '' } }), 0, { query: 'sky' }).state.title, 'Why "blue"?');
  const plainLong = item({ id: 'LongVideo01' }, { snippet: { description: 'no chapters' }, contentDetails: { duration: 'PT12M' } });
  const short = item({ id: 'ShortVid002' }, { snippet: { description: '' }, contentDetails: { duration: 'PT3M' } });
  const chaptered = item({ id: 'Chaptered03' }, { contentDetails: { duration: 'PT9M' }, snippet: { description: '0:00 Intro\n2:00 Rayleigh scattering\n5:00 Sunsets' } });
  const ref = { query: 'sky blue', shows: 'rayleigh scattering' };
  assert.equal(pickVideo([plainLong, short], ref).videoId, 'ShortVid002', 'a whole short video beats the start of a long one');
  assert.equal(pickVideo([plainLong, short, chaptered], ref).videoId, 'Chaptered03', 'a matching chapter wins');
  assert.equal(pickVideo([item({ id: 'Spanish0001' }, { snippet: { defaultAudioLanguage: 'es' } }), short], { query: 'sky blue', shows: 'why blue light scatters' }).videoId, 'ShortVid002', 'English audio preferred');
  assert.equal(pickVideo([], ref), null);
});

test('lookup: the key travels in a header, never the URL; search then video details', async () => {
  const urls = [];
  const fetch = async (u, init) => {
    urls.push(u);
    assert.equal(init.headers['X-Goog-Api-Key'], 'test-key');
    if (u.pathname.endsWith('/search')) return { ok: true, json: async () => ({ items: [{ id: { videoId: 'Ab3_dEf-9hI' } }, { id: { videoId: 'bad' } }, { id: { videoId: 'Ab3_dEf-9hI' } }] }) };
    return { ok: true, json: async () => ({ items: [item()] }) };
  };
  const look = createYouTubeLookup({ apiKey: 'test-key', fetch });
  assert.deepEqual(await look({ query: 'sky blue', shows: 'why blue light scatters' }), CLIP_STATE);
  assert.equal(urls.length, 2);
  for (const u of urls) { assert.equal(u.hostname, 'www.googleapis.com'); assert.doesNotMatch(u.href, /test-key/); }
  const s = urls[0].searchParams;
  assert.deepEqual([s.get('q'), s.get('type'), s.get('videoEmbeddable'), s.get('videoSyndicated'), s.get('safeSearch')], ['sky blue', 'video', 'true', 'true', 'strict']);
  assert.equal(urls[1].searchParams.get('id'), 'Ab3_dEf-9hI', 'invalid and duplicate ids dropped');
  assert.equal(await createYouTubeLookup({ apiKey: 'k', fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }) })({ query: 'zzz' }), null);
  const denied = createYouTubeLookup({ apiKey: 'secret-key', fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) }) });
  await assert.rejects(denied({ query: 'sky' }), (e) => /YouTube HTTP 403 \(quotaExceeded\)/.test(e.message) && !e.message.includes('secret-key'));
  assert.equal(createYouTubeLookup({ apiKey: '' }), null, 'no key -> no lookup');
});

const tag = (p) => `<Video ${Object.entries(p).map(([k, v]) => (typeof v === 'string' ? `${k}="${v}"` : `${k}={${JSON.stringify(v)}}`)).join(' ')}/>`;
const compiled = (p = { query: 'rayleigh scattering', shows: 'why blue light scatters', caption: 'Watch the beam.', questions: [PREDICT, AFTER] }) => compileWonder(`Intro.\n\n${tag(p)}\n\nAfter.`, { salt: 'vid' });
const ridOf = (out) => out.constants[/"__resolutionId":__dilConstants\["(\d+)"\]/.exec(out.code.slice(out.code.indexOf('Video,')))[1]];

test('resolver: pending, then resolved once and cached; no lookup means not found; combined with figures', async () => {
  const out = compiled();
  const rid = ridOf(out);
  let calls = 0;
  const videos = createVideoResolver({ lookup: async (ref) => { calls++; assert.deepEqual(ref, { query: 'rayleigh scattering', shows: 'why blue light scatters' }); return CLIP_STATE; }, cache: new Map(), logger: quiet });
  assert.deepEqual(videos.componentResults(out), { [rid]: { status: 'pending' } });
  assert.equal(videos.label, 'Finding a video…');
  await videos.settle(1000);
  assert.deepEqual(videos.componentResults(out), { [rid]: { status: 'resolved', state: CLIP_STATE } });
  assert.equal(calls, 1);
  assert.deepEqual(createVideoResolver({ lookup: null }).componentResults(out)[rid], { status: 'resolved', state: { found: false } });
  const broken = createVideoResolver({ lookup: async () => { throw new Error('offline'); }, cache: new Map(), logger: quiet });
  broken.componentResults(out);
  await broken.settle(1000);
  assert.deepEqual(broken.componentResults(out)[rid].state, { found: false });

  // one stream resolves figures and videos together, saying what it is waiting for
  const both = compileWonder(`${tag({ query: 'pendulum' })}\n\n<Figure query="Hoover Dam"/>`, { salt: 'mix' });
  let releaseFig;
  const media = combineResolvers([
    createFigureResolver({ lookup: () => new Promise((r) => { releaseFig = () => r({ found: true, src: 'https://upload.wikimedia.org/x.jpg', width: 4, height: 3 }); }), cache: new Map() }),
    createVideoResolver({ lookup: async () => CLIP_STATE, cache: new Map() }),
  ]);
  let updates = 0;
  media.onUpdate(() => updates++);
  assert.equal(Object.values(media.componentResults(both)).filter((r) => r.status === 'pending').length, 2);
  assert.equal(media.label, 'Finding images and videos…');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(media.pending, 1);
  assert.equal(media.label, 'Finding images…');
  releaseFig();
  await media.settle(1000);
  assert.equal(updates, 2);
  assert.ok(Object.values(media.componentResults(both)).every((r) => r.status === 'resolved' && r.state.found));
});

const withResult = (out, result) => ({ ...out, appData: { opGenui: { modelDataBindings: {}, componentResults: result ? { [ridOf(out)]: result } : {} } } });
const player = (env) => env.mirror.findAll((n) => n.type === 'youtube')[0];
const textOf = (env) => env.mirror.text(catalogNodes(env.mirror, 'Video')[0]);
const press = (env, label) => {
  const n = env.mirror.findAll((x) => x.props?.onClick && env.mirror.text(x) === label, catalogNodes(env.mirror, 'Video')[0])[0];
  assert.ok(n, `no "${label}"`);
  const r = env.rt.invokeFunction(n.props.onClick.__fn, []);
  assert.ok(r.ok, r.error);
};

test('sandbox: predict first, then the player; the clip end (host cue) opens the questions', () => {
  const out = compiled();
  const pending = runProgram(withResult(out, { status: 'pending' }));
  assert.deepEqual(pending.errors, []);
  assert.equal(catalogNodes(pending.mirror, 'VideoLoading').length, 1);
  assert.match(textOf(pending), /Finding a video….*Watch the beam\./);

  const env = runProgram(withResult(out, { status: 'resolved', state: CLIP_STATE }));
  assert.deepEqual(env.errors, []);
  assert.equal(player(env), undefined, 'no player until the prediction is made');
  assert.match(textOf(env), /PREDICT FIRST.*Which color scatters more\?.*Red.*Blue.*Skip to the video/);
  press(env, 'Blue');
  const p = player(env);
  assert.deepEqual([p.props.videoId, p.props.start, p.props.end, p.props.title, p.props.cues], ['Ab3_dEf-9hI', 65, 190, 'Why is the sky blue?', [190]]);
  assert.match(textOf(env), /Video: Why is the sky blue\? · Physics Girl · YouTube · Why blue light scatters, 1:05–3:10.*Your prediction: Blue\. Watch to find out, then answer\..*I watched it/);
  press(env, 'YouTube');
  assert.equal(env.actions.at(-1)?.payload?.url ?? env.actions.at(-1)?.url, CLIP_STATE.pageUrl);

  // the host pauses at the clip's end and calls onCue
  assert.ok(env.rt.invokeFunction(p.props.onCue.__fn, [0]).ok);
  assert.deepEqual(player(env).props.cues, [], 'answered once: no more pausing');
  assert.match(textOf(env), /PAUSE AND ANSWER.*YOUR PREDICTION.*Which color scatters more\?.*Right: Blue.*Shorter waves scatter more\..*Why are sunsets red\?/);
  press(env, 'Dust');
  assert.match(textOf(env), /You said Dust\. The answer is A long path through air\..*The blue is scattered out on the way\..*0 of 1 right\./);

  const missing = runProgram(withResult(out, { status: 'resolved', state: { found: false } }));
  assert.equal(catalogNodes(missing.mirror, 'Video').length, 0, 'nothing found -> the video is left out');
  assert.match(missing.mirror.text(), /Intro\.After\./);
});

test('sandbox: skipping the prediction, "I watched it" without the player events, no questions = no cues', () => {
  const out = compiled();
  const env = runProgram(withResult(out, { status: 'resolved', state: CLIP_STATE }));
  press(env, 'Skip to the video');
  assert.ok(player(env));
  press(env, 'I watched it');
  assert.match(textOf(env), /Which color scatters more\?.*The answer: Blue\..*Why are sunsets red\?/);
  const plain = runProgram(withResult(compiled({ query: 'pendulum' }), { status: 'resolved', state: { ...CLIP_STATE, chapter: undefined } }));
  assert.deepEqual(player(plain).props.cues, []);
  assert.equal(catalogNodes(plain.mirror, 'VideoAfter').length, 0);
});

test('sandbox: the prediction, answers and "watched" come back after a reload (saved widget state)', () => {
  const prog = withResult(compiled(), { status: 'resolved', state: CLIP_STATE });
  const mount = (viewState) => {
    const mirror = createMirror();
    const snaps = [];
    const errors = [];
    const rt = createLearningRuntime({ onOps: (ops) => mirror.apply(ops), onError: (e) => errors.push(e), schedule: (fn) => fn(), viewState, viewStateDebounceMs: 0, onViewState: (x) => snaps.push(x) });
    rt.render({ source: prog.code, constants: prog.constants, appData: prog.appData });
    return { rt, mirror, snaps, errors, actions: [] };
  };
  const a = mount();
  press(a, 'Blue');
  press(a, 'I watched it');
  press(a, 'A long path through air');
  const b = mount(JSON.parse(JSON.stringify(a.snaps.at(-1))));
  assert.deepEqual(b.errors, []);
  assert.deepEqual(player(b).props.cues, [], 'watched: the reloaded player does not pause again');
  assert.match(textOf(b), /Right: Blue.*Right: A long path through air.*1 of 1 right\./);
  assert.equal(b.snaps.length, 0, 'restoring does not write the snapshot back');
});

test('the lesson renderer embeds a player only for ids the server resolved for a Video', () => {
  assert.equal(isVideoId('Ab3_dEf-9hI'), true);
  for (const bad of ['short', 'Ab3_dEf-9hI-', 'Ab3 dEf-9hI', 'Ab3_dEf/9hI', null]) assert.equal(isVideoId(bad), false, String(bad));
  const appData = (results) => ({ opGenui: { componentResults: results } });
  assert.deepEqual([...videoIdsOf(appData({ a: { status: 'resolved', state: CLIP_STATE }, b: { status: 'resolved', state: { found: false } }, c: { status: 'pending' }, d: { status: 'resolved', state: { found: true, videoId: 'javascript:' } } }))], ['Ab3_dEf-9hI']);
  const policy = createVideoEmbedPolicy();
  assert.equal(policy('Ab3_dEf-9hI'), false, 'nothing resolved yet');
  policy.update(appData({ v: { status: 'resolved', state: CLIP_STATE } }));
  assert.equal(policy('Ab3_dEf-9hI'), true);
  assert.equal(policy('dQw4w9WgXcQ'), false, 'an id the model wrote into a raw <youtube> stays a placeholder');
});

async function lessonRecords(serverOpts) {
  const server = createWonderServer({ mode: 'demo', demoDelayMs: 0, logger: quiet, memoryFile: null, figureLookup: null, figureSettleMs: 2000, ...serverOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/lesson/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'why is the sky blue?', useWebSearch: false }) });
    const records = parseConversationSource(await res.text());
    const status = await (await fetch(`${base}/api/status`)).json();
    return { records, status };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}
const videoResults = (rec) => [...String(rec?.dil?.code || '').matchAll(/__dil\.jsx\(Video,\{[^{}]*"__resolutionId":__dilConstants\["(\d+)"\]/g)].map((m) => rec.dil.appData?.opGenui?.componentResults?.[rec.dil.constants[m[1]]]);

test('lesson stream: the sky-blue Video resolves through the stream; the final record carries the clip', async () => {
  const lookups = [];
  const { records, status } = await lessonRecords({ videoLookup: (ref) => { lookups.push(ref); return new Promise((r) => setTimeout(() => r(CLIP_STATE), 30)); } });
  assert.deepEqual(lookups, [{ query: 'sunset in a glass milk water flashlight experiment', shows: 'a flashlight beam through milky water turning orange at the far end' }]);
  assert.equal(status.videos, 'youtube');
  assert.ok(records.some((r) => r.type === 'content' && videoResults(r).some((x) => x?.status === 'pending')), 'pending while the lookup runs');
  const final = records.filter((r) => r.type === 'content').at(-1);
  assert.equal(final.status, 'complete');
  assert.deepEqual(videoResults(final), [{ status: 'resolved', state: CLIP_STATE }]);
  const env = runProgram(final.dil);
  assert.deepEqual(env.errors, []);
  assert.equal(catalogNodes(env.mirror, 'VideoPredict').length, 1);
});

test('no key: demo mode plays the demo clip from its fixture; Claude mode and WONDER_VIDEOS=off leave Videos out', async () => {
  const demoRun = await lessonRecords({ env: {} });
  assert.equal(demoRun.status.videos, 'demo');
  const [r] = videoResults(demoRun.records.filter((x) => x.type === 'content').at(-1));
  assert.equal(r.status, 'resolved');
  assert.deepEqual(r.state, DEMO_VIDEOS['sunset in a glass milk water flashlight experiment']);
  assert.equal(r.state.found, true, 'the demo lesson has a fixture clip');
  assert.ok(isVideoId(r.state.videoId));

  const off = await lessonRecords({ env: { WONDER_VIDEOS: 'off' } });
  assert.equal(off.status.videos, 'off');
  const final = off.records.filter((x) => x.type === 'content').at(-1);
  assert.equal(final.status, 'complete');
  assert.deepEqual(videoResults(final).map((x) => x.state), [{ found: false }]);
  assert.equal(catalogNodes(runProgram(final.dil).mirror, 'Video').length, 0);
  assert.equal(await createDemoVideoLookup()({ query: 'anything else' }), null, 'the fixture knows only the demo lessons');
});

test('sky-blue demo: the Video is valid, the lesson lints clean, and a Video is never a page\'s only visual', () => {
  const md = demo('sky-blue.md');
  const v = compileWonder(md, { salt: 'demo' }).components.find((c) => c.name === 'Video');
  assert.equal(v.status, 'valid');
  assert.deepEqual(v.props.questions.map((q) => q.when), ['before', 'after']);
  assert.equal(lintLesson(md).score, 1);
  // the Figure + CompareToggle page with only a Video left on it has no visual
  const onlyVideo = md.replace(/<Figure[^\n]*\/>\n/, '').replace(/<CompareToggle[^\n]*\/>\n/, '<Video query="cloud droplets scattering light"/>\n');
  assert.equal(lintLesson(onlyVideo).checks.find((c) => c.id === 'visual_per_page').ok, false);
  const lesson = (state) => ({ markdown: '<Video query="pendulum"/>', dil: { appData: { opGenui: { componentResults: { v: { status: 'resolved', state } } } } } });
  assert.ok(lessonRecipe(lesson(CLIP_STATE)).components.includes('Video'));
  assert.ok(!lessonRecipe(lesson({ found: false })).components.includes('Video'));
});

test('prompts teach Video: a search phrase and what it shows, never an id or URL', () => {
  assert.match(LESSON_SYSTEM_PROMPT, /<Video query=/);
  assert.match(LESSON_SYSTEM_PROMPT, /never write a video id or URL/);
  assert.match(LESSON_SYSTEM_PROMPT, /seeing it happen \(an experiment, a process in motion\) -> Video/);
  assert.match(LESSON_SYSTEM_PROMPT, /at most one Video per lesson/);
  assert.match(TUTOR_SYSTEM_PROMPT, /<Video/);
});
