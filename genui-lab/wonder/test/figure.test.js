// <Figure/>: validation, Commons result picking, the lookup, the per-stream resolver, the sandbox
// component and the lesson stream (late images re-send the program; the final record has them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFigure, figureFallback, figureFromPage, pickFigure, plainText, localized, createCommonsLookup, createFigureResolver, withFigures } from '../server/figures.js';
import { validateComponentProps } from '../server/catalog-schema.js';
import { compileWonder } from '../server/compile.js';
import { lintLesson } from '../server/critic.js';
import { lessonRecipe } from '../public/outcomes-core.js';
import { createWonderServer } from '../server/app.js';
import { createFigureImagePolicy } from '../public/dil-surface.js';
import { isFigureImageUrl, figureImageSrcs } from '../public/figure-hosts.js';
import { LESSON_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../server/prompts.js';
import { parseConversationSource } from '../../chatgpt-dil/src/stream.js';
import { demo, runProgram, catalogNodes, fakeClient } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const CLOUDS = { found: true, src: 'https://upload.wikimedia.org/wikipedia/commons/b/b5/Clouds.jpg', width: 960, height: 640, title: 'Clouds', license: 'CC BY-SA 4.0', author: 'Jakec', pageUrl: 'https://commons.wikimedia.org/wiki/File:Clouds.jpg' };
const page = (over = {}, info = {}, meta = {}) => ({
  index: 1, title: 'File:Clouds in the sky.jpg', ...over,
  imageinfo: [{
    mime: 'image/jpeg', width: 4000, height: 3000, thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b5/C.jpg/960px-C.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo', thumbwidth: 960, thumbheight: 720,
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Clouds_in_the_sky.jpg', ...info,
    extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'http://creativecommons.org/licenses/by-sa/4.0' }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jakec">Jake&amp;C</a>' }, ...meta },
  }],
});

test('valid Figure props normalize (aliases, File: prefix, alt default)', () => {
  const r = validateFigure({ search: '  cumulus   clouds ', file: 'Clouds in the sky.jpg', caption: 'Clouds.', question: 'Why white?', answer: 'Mie.' });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.props, { query: 'cumulus clouds', file: 'File:Clouds in the sky.jpg', caption: 'Clouds.', alt: 'Clouds.', question: 'Why white?', answer: 'Mie.' });
  assert.deepEqual(validateFigure({ file: 'Image:A b.PNG' }).props, { file: 'File:A b.PNG', alt: '' });
  assert.ok(validateComponentProps('Figure', { query: 'Hoover Dam' }).ok, 'registered in the learning catalog');
  const titled = validateFigure({ title: 'Cumulus clouds', query: 'cumulus clouds blue sky' });
  assert.ok(titled.ok, 'a heading-style title is ignored, not read as a file name');
  assert.equal(titled.props.file, undefined);
  const bad = (p, re) => { const v = validateFigure(p); assert.equal(v.ok, false, JSON.stringify(p)); assert.match(v.error, re); };
  bad({}, /needs query/);
  bad({ query: 'ab' }, /too short/);
  bad({ query: 'https://evil.example/x.jpg' }, /not a URL/);
  bad({ file: 'File:x.exe' }, /Commons file title/);
  bad({ file: 'File:a<script>.jpg' }, /Commons file title/);
  bad({ query: 'Saturn', question: 'Rings?' }, /question and answer go together/);
  assert.equal(figureFallback({ caption: 'A <b> photo' }), '*A ‹b> photo*');
  assert.equal(figureFallback({ query: 'x' }), '');
});

test('Commons results: usable pages become a clean state; the best one is picked', () => {
  const s = figureFromPage(page());
  assert.deepEqual(s, {
    found: true, src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b5/C.jpg/960px-C.jpg', width: 960, height: 720, title: 'Clouds in the sky',
    license: 'CC BY-SA 4.0', author: 'Jake&C', pageUrl: 'https://commons.wikimedia.org/wiki/File:Clouds_in_the_sky.jpg', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  });
  assert.equal(figureFromPage(page({}, {}, { LicenseShortName: undefined })), null, 'no license -> unusable');
  assert.equal(figureFromPage(page({}, {}, { NonFree: { value: 'true' } })), null);
  assert.equal(figureFromPage(page({}, { mime: 'application/pdf' })), null);
  assert.equal(figureFromPage(page({}, { width: 200, height: 150 })), null, 'too small');
  assert.equal(figureFromPage(page({}, { thumburl: 'https://evil.example/a.jpg' })), null, 'only Wikimedia image hosts');
  assert.equal(figureFromPage(page({}, { thumbwidth: 960, thumbheight: 100 })), null, 'extreme panorama');
  assert.equal(figureFromPage(page({}, {}, { Artist: undefined, Credit: undefined })).author, 'Unknown author');
  const ru = page({ index: 1, title: 'File:Scattering-ru.svg' }, { mime: 'image/svg+xml', width: 300, height: 200 });
  const en = page({ index: 2, title: 'File:Scattering.svg' }, { mime: 'image/svg+xml', width: 300, height: 200 });
  assert.equal(pickFigure([en, ru]).title, 'Scattering', 'language-neutral labels win over a better rank');
  assert.equal(pickFigure([ru]).title, 'Scattering-ru', 'a localized copy is still better than nothing');
  assert.equal(pickFigure([page({}, {}, { LicenseShortName: undefined })]), null);
  assert.equal(plainText('<b>A</b>&#39;s &#x41; &nbsp;x'), "A 's A x");
  assert.equal(plainText('Jo &#99999999; &#xFFFFFFF; &#0;'), 'Jo &#99999999; &#xFFFFFFF; &#0;', 'out-of-range entities stay as written');
  assert.equal(figureFromPage(page({}, {}, { Artist: { value: 'Bad &#99999999; entity' } })).author, 'Bad &#99999999; entity');
  for (const t of ['File:World-map.svg', 'File:Cell-art.svg', 'File:Heart-diagram.svg', 'File:Scattering-en.svg']) assert.equal(localized(t), false, t);
  for (const t of ['File:Scattering-ru.svg', 'File:Heart-de.svg', 'File:Map-zh-hans.svg', 'File:Map-pt-br.svg']) assert.equal(localized(t), true, t);
});

test('lookup: a file title first, then search; identifies itself and adds the filetype filter', async () => {
  const urls = [];
  const fetch = async (u, init) => {
    urls.push(u);
    assert.match(init.headers['User-Agent'], /^WonderLessons\//);
    const titles = u.searchParams.get('titles');
    return { ok: true, json: async () => ({ query: { pages: titles ? [{ title: titles, missing: true }] : [page()] } }) };
  };
  const look = createCommonsLookup({ fetch });
  const s = await look({ file: 'File:Gone.jpg', query: 'cumulus clouds' });
  assert.equal(s.title, 'Clouds in the sky');
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('titles'), 'File:Gone.jpg');
  assert.equal(urls[1].searchParams.get('gsrsearch'), 'cumulus clouds filetype:bitmap|drawing');
  assert.equal(urls[1].searchParams.get('gsrnamespace'), '6');
  assert.equal(urls[1].hostname, 'commons.wikimedia.org');
  await assert.rejects(createCommonsLookup({ fetch: async () => ({ ok: false, status: 503 }) })({ query: 'x y z' }), /HTTP 503/);
});

const tag = (p) => `<Figure ${Object.entries(p).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
const compiled = (p = { query: 'cumulus clouds', caption: 'Clouds in a blue sky.', question: 'Why are they white?', answer: 'Droplets scatter **all** colors.' }) => compileWonder(`Intro.\n\n${tag(p)}\n\nAfter.`, { salt: 'fig' });
const ridOf = (out) => out.constants[/"__resolutionId":__dilConstants\["(\d+)"\]/.exec(out.code.slice(out.code.indexOf('Figure,')))[1]];

test('resolver: pending, then resolved after the lookup lands (once, cached); errors and no-network mean not found', async () => {
  const out = compiled();
  const rid = ridOf(out);
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const figures = createFigureResolver({ lookup: async (ref) => { calls++; assert.deepEqual(ref, { file: undefined, query: 'cumulus clouds' }); await gate; return CLOUDS; }, cache: new Map(), logger: quiet });
  let updates = 0;
  figures.onUpdate(() => updates++);
  assert.deepEqual(figures.componentResults(out), { [rid]: { status: 'pending' } });
  figures.componentResults(out);
  assert.equal(figures.pending, 1);
  release();
  await figures.settle(1000);
  assert.equal(updates, 1);
  assert.deepEqual(figures.componentResults(out), { [rid]: { status: 'resolved', state: CLOUDS } });
  assert.equal(calls, 1, 'one lookup per figure');
  // merged into another appData factory (citations) without dropping its results
  const ad = withFigures(() => ({ opGenui: { componentResults: { cite1: { status: 'resolved', state: {} } } } }), figures)(out);
  assert.deepEqual(Object.keys(ad.opGenui.componentResults).sort(), ['cite1', rid].sort());

  const off = createFigureResolver({ lookup: null, cache: new Map() });
  assert.deepEqual(off.componentResults(out)[rid], { status: 'resolved', state: { found: false } });
  const broken = createFigureResolver({ lookup: async () => { throw new Error('offline'); }, cache: new Map(), logger: quiet });
  broken.componentResults(out);
  await broken.settle(1000);
  assert.deepEqual(broken.componentResults(out)[rid].state, { found: false });
  // a shared cache keeps results across streams, but not failures: the next stream retries
  const shared = new Map();
  let tries = 0;
  const flaky = async () => { if (tries++ === 0) throw new Error('blip'); return CLOUDS; };
  const s1 = createFigureResolver({ lookup: flaky, cache: shared, logger: quiet });
  s1.componentResults(out);
  await s1.settle(1000);
  assert.deepEqual(s1.componentResults(out)[rid].state, { found: false });
  const s2 = createFigureResolver({ lookup: flaky, cache: shared, logger: quiet });
  s2.componentResults(out);
  await s2.settle(1000);
  assert.deepEqual(s2.componentResults(out)[rid].state, CLOUDS);
  const s3 = createFigureResolver({ lookup: () => assert.fail('cached'), cache: shared });
  assert.deepEqual(s3.componentResults(out)[rid].state, CLOUDS);
  const slow = createFigureResolver({ lookup: () => new Promise(() => {}), cache: new Map() });
  slow.componentResults(out);
  await slow.settle(20);
  slow.finalize();
  assert.deepEqual(slow.componentResults(out)[rid], { status: 'resolved', state: { found: false } }, 'still pending at the end -> not found');
  assert.deepEqual(createFigureResolver({ lookup: null }).componentResults(compileWonder('No figures here.')), {});

  // "nothing found" expires (a transient empty search is retried later); found images do not
  let clock = 0;
  const now = () => clock;
  const misses = new Map();
  let found = false;
  let lookups = 0;
  const look = async () => { lookups++; return found ? CLOUDS : null; };
  const m1 = createFigureResolver({ lookup: look, cache: misses, now, missTtlMs: 1000 });
  m1.componentResults(out);
  await m1.settle(1000);
  assert.deepEqual(m1.componentResults(out)[rid].state, { found: false });
  clock = 500;
  createFigureResolver({ lookup: look, cache: misses, now, missTtlMs: 1000 }).componentResults(out);
  assert.equal(lookups, 1, 'a fresh miss is still cached');
  clock = 2000;
  found = true;
  const m2 = createFigureResolver({ lookup: look, cache: misses, now, missTtlMs: 1000 });
  m2.componentResults(out);
  await m2.settle(1000);
  assert.equal(lookups, 2);
  assert.deepEqual(m2.componentResults(out)[rid].state, CLOUDS);

  // the stream's signal reaches the lookup; an aborted lookup is neither cached nor logged
  const ac = new AbortController();
  const warned = [];
  const seen = [];
  const aborting = createFigureResolver({ lookup: (_ref, { signal }) => { seen.push(signal); return new Promise((_, rej) => { if (signal.aborted) rej(new Error('aborted')); else signal.addEventListener('abort', () => rej(new Error('aborted'))); }); }, signal: ac.signal, cache: new Map(), logger: { warn: (m) => warned.push(m) } });
  aborting.componentResults(out);
  ac.abort();
  await aborting.settle(1000);
  assert.equal(seen[0], ac.signal);
  assert.deepEqual(warned, []);
  assert.deepEqual(aborting.componentResults(out)[rid].state, { found: false });
});

const withResult = (out, result) => ({ ...out, appData: { opGenui: { modelDataBindings: {}, componentResults: result ? { [ridOf(out)]: result } : {} } } });

test('sandbox: a loading frame, then the credited image; tap to enlarge; Look closer reveals the answer', () => {
  const out = compiled();
  const pending = runProgram(withResult(out, { status: 'pending' }));
  assert.deepEqual(pending.errors, []);
  assert.equal(catalogNodes(pending.mirror, 'FigureLoading').length, 1);
  assert.match(pending.mirror.text(catalogNodes(pending.mirror, 'Figure')[0]), /Finding an image….*Clouds in a blue sky\./);

  const env = runProgram(withResult(out, { status: 'resolved', state: CLOUDS }));
  assert.deepEqual(env.errors, []);
  const fig = catalogNodes(env.mirror, 'Figure')[0];
  const img = env.mirror.findAll((n) => n.type === 'image', fig)[0];
  assert.equal(img.props.src, CLOUDS.src);
  assert.equal(img.props.alt, 'Clouds in a blue sky.');
  assert.equal(img.props.aspectRatio, '1.5');
  assert.match(env.mirror.text(fig), /Clouds in a blue sky\..*LOOK CLOSER.*Why are they white\?.*Show answer.*Image: Jakec · CC BY-SA 4\.0 · Wikimedia Commons.*Source/);
  const click = (pred) => { const n = env.mirror.findAll((x) => x.props?.onClick && pred(x), fig)[0]; assert.ok(n); const r = env.rt.invokeFunction(n.props.onClick.__fn, []); assert.ok(r.ok, r.error); };
  click((n) => env.mirror.text(n) === 'Show answer');
  assert.match(env.mirror.text(catalogNodes(env.mirror, 'FigureQuestion')[0]), /Droplets scatter all colors\./);
  click((n) => env.mirror.text(n) === 'Source');
  assert.deepEqual(env.actions.at(-1)?.payload?.url ?? env.actions.at(-1)?.url, CLOUDS.pageUrl);

  // a tall image is letterboxed until it is tapped
  const tall = runProgram(withResult(out, { status: 'resolved', state: { ...CLOUDS, width: 600, height: 900 } }));
  const ratio = () => tall.mirror.findAll((n) => n.type === 'image')[0].props.aspectRatio;
  assert.equal(ratio(), '1.25');
  const enlarge = tall.mirror.findAll((n) => n.props?.ariaLabel === 'Enlarge the image')[0];
  tall.rt.invokeFunction(enlarge.props.onClick.__fn, []);
  assert.equal(ratio(), '0.6667');

  const missing = runProgram(withResult(out, { status: 'resolved', state: { found: false } }));
  assert.equal(catalogNodes(missing.mirror, 'Figure').length, 0, 'nothing found -> the figure is left out');
  assert.match(missing.mirror.text(), /Intro\.After\./);
});

test('the lesson renderer loads only images the server resolved for a Figure', () => {
  assert.equal(isFigureImageUrl('https://upload.wikimedia.org/wikipedia/commons/b/b5/C.jpg'), true);
  assert.equal(isFigureImageUrl('https://thumb.wikimedia.org/x.png'), true);
  assert.equal(isFigureImageUrl('http://upload.wikimedia.org/x.png'), false);
  assert.equal(isFigureImageUrl('//upload.wikimedia.org/x.png'), false);
  assert.equal(isFigureImageUrl('https://upload.wikimedia.org.evil.example/x.png'), false);
  assert.equal(isFigureImageUrl('not a url'), false);
  const appData = (results) => ({ opGenui: { componentResults: results } });
  assert.deepEqual([...figureImageSrcs(appData({ a: { status: 'resolved', state: CLOUDS }, b: { status: 'resolved', state: { found: false } }, c: { status: 'pending' }, d: { status: 'resolved', state: { found: true, src: 'https://tracker.example/p.gif' } } }))], [CLOUDS.src]);
  const policy = createFigureImagePolicy();
  assert.equal(policy(CLOUDS.src), false, 'nothing resolved yet');
  policy.update(appData({ fig: { status: 'resolved', state: CLOUDS } }));
  assert.equal(policy(CLOUDS.src), true);
  assert.equal(policy('https://upload.wikimedia.org/wikipedia/commons/x/xy/Other.jpg'), false, 'a Wikimedia URL the model wrote into a raw <image> stays a placeholder');
  policy.update(appData({}));
  assert.equal(policy(CLOUDS.src), true, 'an image stays allowed once shown on this surface');
});

async function lessonRecords(figureLookup, topic = 'why is the sky blue?', extra = {}) {
  const server = createWonderServer({ mode: 'demo', demoDelayMs: 0, logger: quiet, memoryFile: null, figureLookup, figureSettleMs: 2000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, useWebSearch: false, ...extra }) });
    return parseConversationSource(await res.text());
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}
// the Figures' entries only (the sky-blue demo also has a Video, see video.test.js)
const figureRids = (dil) => [...String(dil?.code || '').matchAll(/__dil\.jsx\(Figure,\{[^{}]*"__resolutionId":__dilConstants\["(\d+)"\]/g)].map((m) => dil.constants[m[1]]);
const figureResults = (rec) => figureRids(rec?.dil).map((rid) => rec.dil.appData?.opGenui?.componentResults?.[rid]).filter(Boolean);

test('lesson stream: the sky-blue Figure resolves through the stream and the final record carries the image', async () => {
  let resolveLookup;
  const lookups = [];
  const records = await lessonRecords((ref) => { lookups.push(ref); return new Promise((r) => { resolveLookup = () => r(CLOUDS); setTimeout(resolveLookup, 30); }); });
  assert.deepEqual(lookups, [{ file: undefined, query: 'cumulus clouds blue sky' }]);
  const content = records.filter((r) => r.type === 'content' && r.dil);
  assert.ok(content.some((r) => figureResults(r).some((x) => x.status === 'pending')), 'pending while the lookup runs');
  const final = records.filter((r) => r.type === 'content').at(-1);
  assert.equal(final.status, 'complete');
  assert.deepEqual(figureResults(final), [{ status: 'resolved', state: CLOUDS }]);
  const env = runProgram(final.dil);
  assert.deepEqual(env.errors, []);
  assert.equal(env.mirror.findAll((n) => n.type === 'image')[0].props.src, CLOUDS.src);
});

test('lesson stream: no network -> the Figure is quietly left out; the lesson still completes', async () => {
  const records = await lessonRecords(null);
  const final = records.filter((r) => r.type === 'content').at(-1);
  assert.equal(final.status, 'complete');
  assert.deepEqual(figureResults(final).map((r) => r.state), [{ found: false }]);
  assert.equal(catalogNodes(runProgram(final.dil).mirror, 'Figure').length, 0);
});

test('Teacher stream: a Figure in a Teacher reply resolves too (every DIL stream has a resolver)', async () => {
  const client = fakeClient({ text: 'Here is the dam.\n\n<Figure query="Hoover Dam" caption="The dam holds back Lake Mead."/>\n' });
  const server = createWonderServer({ mode: 'claude', client, demoDelayMs: 0, logger: quiet, memoryFile: null, figureLookup: async () => CLOUDS, figureSettleMs: 2000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/teacher/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'show me the Hoover Dam' }) });
    const final = parseConversationSource(await res.text()).filter((r) => r.type === 'content').at(-1);
    assert.equal(final.status, 'complete');
    assert.deepEqual(figureResults(final), [{ status: 'resolved', state: CLOUDS }]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('recoverable streams: a lesson with a streamKey and a Teacher turn with a turnId still resolve Figures', async () => {
  const lesson = (await lessonRecords(async () => CLOUDS, 'why is the sky blue?', { streamKey: 'k-retry-1' })).filter((r) => r.type === 'content').at(-1);
  assert.equal(lesson.status, 'complete');
  assert.deepEqual(figureResults(lesson), [{ status: 'resolved', state: CLOUDS }]);
  const client = fakeClient({ text: 'Here is the dam.\n\n<Figure query="Hoover Dam" caption="The dam holds back Lake Mead."/>\n' });
  const server = createWonderServer({ mode: 'claude', client, demoDelayMs: 0, logger: quiet, memoryFile: null, figureLookup: async () => CLOUDS, figureSettleMs: 2000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/teacher/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'show me the Hoover Dam', turnId: 'turn-retry-1' }) });
    const final = parseConversationSource(await res.text()).filter((r) => r.type === 'content').at(-1);
    assert.equal(final.status, 'complete');
    assert.deepEqual(figureResults(final), [{ status: 'resolved', state: CLOUDS }]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('sky-blue demo: the Figure is valid and the lesson lints clean', () => {
  const md = demo('sky-blue.md');
  const fg = compileWonder(md, { salt: 'demo' }).components.find((c) => c.name === 'Figure');
  assert.equal(fg.status, 'valid');
  assert.equal(fg.props.query, 'cumulus clouds blue sky');
  assert.equal(lintLesson(md).score, 1);
});

test('a Figure is never a page\'s only visual, and counts in outcomes only when an image was shown', () => {
  const md = demo('sky-blue.md').replace(/<CompareToggle[^\n]*\/>\n/, '');
  assert.ok(/<Figure /.test(md));
  const visual = lintLesson(md).checks.find((c) => c.id === 'visual_per_page');
  assert.equal(visual.ok, false, visual.detail);
  const lesson = (state) => ({ markdown: '<Figure query="Hoover Dam"/>', dil: { appData: { opGenui: { componentResults: { f: { status: 'resolved', state } } } } } });
  assert.ok(lessonRecipe(lesson(CLOUDS)).components.includes('Figure'));
  assert.ok(!lessonRecipe(lesson({ found: false })).components.includes('Figure'));
  assert.ok(!lessonRecipe({ markdown: '<Figure query="Hoover Dam"/>' }).components.includes('Figure'));
});

test('prompts teach Figure: a search phrase, never a URL', () => {
  assert.match(LESSON_SYSTEM_PROMPT, /<Figure query=/);
  assert.match(LESSON_SYSTEM_PROMPT, /never write a URL/);
  assert.match(LESSON_SYSTEM_PROMPT, /what a real thing looks like -> Figure/);
  assert.match(LESSON_SYSTEM_PROMPT, /a lesson about a physical thing usually has both, the Diagram for the mechanism and one Figure of the real thing/);
  assert.match(LESSON_SYSTEM_PROMPT, /A Figure is always in addition to the page's own visual, never the only one/);
  assert.match(TUTOR_SYSTEM_PROMPT, /<Figure/);
});
