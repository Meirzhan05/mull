// Phase 4c: mid-page resume (paragraph-boundary trimming, seamless continuation prompt,
// duplicate heading/paragraph guard, demo resume over HTTP) and the cross-tab lesson lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWonderServer } from '../server/app.js';
import {
  trimToLastBlock, createContinuationGuard, steeringUserContent, normalizeContinueFrom, demoContinuation, currentPageTitle,
} from '../server/steering.js';
import { trimToLastPage, pageCount, pageTitles, lessonPhase, STEER_CHIPS } from '../public/steering-core.js';
import { createLessonLocks, leaseKey, LEASE_TTL_MS, LEASE_RENEW_MS } from '../public/lesson-lock.js';
import { compileWonder, scanComponentTags } from '../server/compile.js';
import { protectMath } from '../server/math-spans.js';
import { groundDemoLesson } from '../server/demo-grounding.js';
import { createSourceRegistry } from '../server/grounding.js';
import { ConversationSourceParser, ConversationTurn, validateRecord } from '../../chatgpt-dil/src/stream.js';
import { demo, DEMO_FILES, fakeClient, runProgram } from './helpers.js';

// ---------------------------------------------------------------- trimming: crafted cases

const P = '# Title\n\nHook sentence.\n\n## Page one\n\nFirst paragraph.\n\n';

test('trimToLastBlock: keeps complete paragraphs of the current page, drops the half-written one', () => {
  assert.equal(trimToLastBlock(`${P}Second paragraph is still bei`), P);
  assert.equal(trimToLastBlock(`${P}Second paragraph.\n\nThird`), `${P}Second paragraph.\n\n`);
  assert.equal(trimToLastBlock(`${P}Second paragraph.\n\n`), `${P}Second paragraph.\n\n`, 'a block followed by a blank line is complete');
  assert.equal(trimToLastBlock(`${P}Second paragraph.\n`), P, 'no blank line yet: not known to be complete');
  assert.equal(trimToLastBlock('# Title\n\nHook.\n\n## Page one\n\nHalf'), '# Title\n\nHook.\n\n## Page one\n\n', 'the heading block is kept');
  assert.equal(trimToLastBlock('# Title\n\nHo'), '# Title\n\n');
  assert.equal(trimToLastBlock('# Tit'), '');
  assert.equal(trimToLastBlock(''), '');
  // never less than the page floor
  const two = `${P}## Page two\n\nSecond page h`;
  assert.ok(trimToLastBlock(two).length >= trimToLastPage(two).length);
  assert.equal(trimToLastBlock(two), `${P}## Page two\n\n`);
});

test('trimToLastBlock: never cuts inside a tag or a component\'s JSON props', () => {
  // props still streaming, with a blank line inside the JSON (a cut point by line shape alone)
  const quiz = `${P}<Quiz title="Q" questions={[{"id":"q1","prompt":"Line one\n\nline two","options":[`;
  assert.equal(trimToLastBlock(quiz), P);
  const stepper = `${P}<LessonStepper title="Steps" steps={[\n  {"label":"A","text":"x"},\n\n  {"label":"B"`;
  assert.equal(trimToLastBlock(stepper), P);
  // the same component once complete is kept
  const done = `${P}<LessonStepper title="Steps" steps={[{"label":"A","text":"x"}]}/>\n\nNext par`;
  assert.equal(trimToLastBlock(done), `${P}<LessonStepper title="Steps" steps={[{"label":"A","text":"x"}]}/>\n\n`);
  // a half-written attribute string with a blank line inside
  assert.equal(trimToLastBlock(`${P}<Callout title="A long\n\ntitle`), P);
  // a children component spanning blank lines stays whole
  const callout = `${P}<Callout title="Note" tone="tip">\nFirst line.\n\nSecond line still`;
  assert.equal(trimToLastBlock(callout), P);
  const closed = `${P}<Callout title="Note" tone="tip">\nFirst line.\n\nSecond line.\n</Callout>\n\nAfter`;
  assert.equal(trimToLastBlock(closed), closed.slice(0, closed.indexOf('After')));
  // primitive elements too
  const grid = `${P}<grid columns={2} gap={3}>\n<grid-item>\n<box padding={4}>\n\n<text size="sm">A</text>`;
  assert.equal(trimToLastBlock(grid), P);
  // a Cite pill inside a paragraph is fine
  const cited = `${P}Rayleigh<Cite refs={["turn0search0"]}/> wins.\n\nMore`;
  assert.equal(trimToLastBlock(cited), `${P}Rayleigh<Cite refs={["turn0search0"]}/> wins.\n\n`);
});

test('trimToLastBlock: never cuts inside a code fence', () => {
  const open = `${P}\`\`\`python\nx = 1\n\ny = 2\n`;
  assert.equal(trimToLastBlock(open), P);
  const tilde = `${P}~~~\na\n\nb`;
  assert.equal(trimToLastBlock(tilde), P);
  const closed = `${P}\`\`\`\na\n\nb\n\`\`\`\n\nAfter the fence.\n\nNex`;
  assert.equal(trimToLastBlock(closed), closed.slice(0, closed.indexOf('Nex')));
  // a fence inside a fence-looking line of a longer fence
  const nested = `${P}\`\`\`\`md\n\`\`\`\n\ninner\n`;
  assert.equal(trimToLastBlock(nested), P);
});

test('trimToLastBlock: never cuts inside a math span', () => {
  assert.equal(trimToLastBlock(`${P}<math>\nA = P(1+r)^t\n\n+ more`), P, '<math> with a blank line, unclosed');
  const closed = `${P}<math>\nA = 1\n\nB = 2\n</math>\n\nThen tex`;
  assert.equal(trimToLastBlock(closed), closed.slice(0, closed.indexOf('Then')));
  assert.equal(trimToLastBlock(`${P}$$x^2 + `), P);
  assert.equal(trimToLastBlock(`${P}$$x^2$$\n\nAnd`), `${P}$$x^2$$\n\n`);
  assert.equal(trimToLastBlock(`${P}\\[\\frac{a}{b}`), P);
  assert.equal(trimToLastBlock(`${P}Inline $x^2$ math.\n\nNext`), `${P}Inline $x^2$ math.\n\n`);
  assert.equal(trimToLastBlock(`${P}Costs $5 and $10.\n\nNext`), `${P}Costs $5 and $10.\n\n`, 'prices are not math');
});

test('trimToLastBlock: never cuts a list, table or blockquote that may still continue', () => {
  assert.equal(trimToLastBlock(`${P}- one\n- two\n\n`), P, 'nothing after the list yet');
  assert.equal(trimToLastBlock(`${P}- one\n\n- two\n\n- thr`), P, 'loose list in progress');
  assert.equal(trimToLastBlock(`${P}1. one\n2. two\n\n3. thr`), P);
  assert.equal(trimToLastBlock(`${P}- one\n\n  continued item\n\nx`), `${P}- one\n\n  continued item\n\n`, 'an indented continuation, then a paragraph');
  const done = `${P}- one\n- two\n\nAfter the list.\n\nNe`;
  assert.equal(trimToLastBlock(done), `${P}- one\n- two\n\nAfter the list.\n\n`);
  const afterList = `${P}- one\n- two\n\nAfter the li`;
  assert.equal(trimToLastBlock(afterList), `${P}- one\n- two\n\n`, 'a different block started: the list is finished');
  assert.equal(trimToLastBlock(`${P}| a | b |\n|---|---|\n| 1 | 2 |\n\n`), P, 'table not yet followed by anything');
  assert.equal(trimToLastBlock(`${P}| a | b |\n|---|---|\n| 1 | 2 |\n\nText`), `${P}| a | b |\n|---|---|\n| 1 | 2 |\n\n`);
  assert.equal(trimToLastBlock(`${P}> quoted\n\n> more`), P);
});

// ---------------------------------------------------------------- trimming: every prefix of the demo lessons

function groundedSky() {
  return groundDemoLesson('sky-blue', demo('sky-blue.md'), createSourceRegistry({ turnIndex: 0 }));
}

test('every prefix of every demo lesson (and the grounded one): kept text compiles cleanly, no half-written tag, resume reproduces the lesson', () => {
  const lessons = [...DEMO_FILES.map((f) => [f, demo(f)]), ['sky-blue (grounded)', groundedSky()]];
  for (const [name, md] of lessons) {
    const distinct = new Map();
    for (let i = 0; i <= md.length; i++) {
      const prefix = md.slice(0, i);
      const kept = trimToLastBlock(prefix);
      assert.ok(prefix.startsWith(kept), `${name}@${i}: kept is a prefix`);
      assert.ok(kept.length >= trimToLastPage(prefix).length, `${name}@${i}: never less than the page floor`);
      assert.ok(kept === '' || kept.endsWith('\n'), `${name}@${i}: ends at a line boundary`);
      if (!distinct.has(kept)) distinct.set(kept, i);
    }
    assert.ok(distinct.size > pageCount(md) + 2, `${name}: resumes from many paragraph boundaries, not just pages (${distinct.size})`);
    for (const [kept, at] of distinct) {
      const where = `${name}@${at} (${JSON.stringify(kept.slice(-40))})`;
      const r = compileWonder(kept, { partial: true });
      assert.deepEqual(r.components.filter((c) => c.status !== 'valid').map((c) => `${c.name}:${c.status}`), [], `${where}: every component valid`);
      assert.ok(!scanComponentTags(kept).some((t) => t.kind === 'incomplete'), `${where}: no half-written tag`);
      assert.equal(protectMath(kept, { partial: true }).source, protectMath(kept).source, `${where}: no open math span`);
      assert.ok(!/<[A-Za-z][^>]*$/.test(kept.replace(/```[\s\S]*?```/g, '')), `${where}: no dangling "<Tag"`);
      // demo resume from this exact boundary reproduces the lesson
      if (!name.includes('grounded')) assert.equal(kept + demoContinuation(md, kept, ''), md, `${where}: demo resume is seamless`);
    }
  }
});

// ---------------------------------------------------------------- continuation prompt

test('resume prompt: original request + lesson so far + seamless instruction; no prefill wording', () => {
  const kept = trimToLastBlock(`${P}Second paragraph.\n\nThird is half`);
  assert.equal(currentPageTitle(kept), 'Page one');
  const [req, ctx] = steeringUserContent('Write a lesson about: tides', kept, '', { mode: 'resume' });
  assert.equal(req.text, 'Write a lesson about: tides');
  assert.ok(ctx.text.includes(`<lesson_so_far>\n${kept.trim()}\n</lesson_so_far>`));
  assert.match(ctx.text, /continue from the very next sentence; do not repeat or rewrite anything above; keep the same page structure/i);
  assert.match(ctx.text, /partway through the page "## Page one"/);
  assert.match(ctx.text, /without writing its "## " heading again/);
  assert.doesNotMatch(ctx.text, /Start directly with the next "## " page heading/, 'resume is not page-level any more');
  // with a change: still mid-page, and the request applies from here on
  const steer = steeringUserContent('req', kept, 'Simpler', { mode: 'resume' })[1].text;
  assert.match(steer, /"Simpler"[\s\S]*Apply that request to everything you write from here on[\s\S]*very next sentence/);
  // live steer and revise stay page-level
  assert.match(steeringUserContent('req', trimToLastPage(`${P}x`), 'Simpler')[1].text, /Start directly with the next "## " page heading/);
  assert.match(steeringUserContent('req', '# T\n\n', 'Simpler', { mode: 'revise', fromPage: 1 })[1].text, /Start directly with the next "## " page heading/);
  // normalizeContinueFrom: resume keeps blocks (with or without an instruction), revise keeps pages
  const md = `${P}## Page two\n\nA.\n\nB half`;
  assert.equal(normalizeContinueFrom({ markdown: md }).kept, `${P}## Page two\n\nA.\n\n`);
  assert.equal(normalizeContinueFrom({ markdown: md, instruction: 'Simpler' }).kept, `${P}## Page two\n\nA.\n\n`);
  assert.equal(normalizeContinueFrom({ markdown: md, fromPage: 2 }).kept, P);
});

// ---------------------------------------------------------------- duplicate guard

function feed(guard, text, size = 1) {
  let out = '';
  for (let i = 0; i < text.length; i += size) out += guard.push(text.slice(i, i + size));
  return out + guard.flush();
}

test('continuation guard: drops a leading repeated heading and paragraphs, keeps new text', () => {
  const kept = `${P}## Page two\n\nAlready shown paragraph.\n\n`;
  const fresh = 'A brand new paragraph.\n\n## Page three\n\nMore.\n';
  for (const size of [1, 3, 17, 1000]) {
    let g = createContinuationGuard(kept);
    assert.equal(feed(g, `## Page two\n\n${fresh}`, size), fresh, `heading repeat (chunk ${size})`);
    assert.equal(g.dropped, 1);
    g = createContinuationGuard(kept);
    assert.equal(feed(g, `## Page two\n\nAlready shown paragraph.\n\n${fresh}`, size), fresh, 'heading + paragraph repeat');
    assert.equal(g.dropped, 2);
    g = createContinuationGuard(kept);
    assert.equal(feed(g, `\n\n##   Page two \n\n  Already   shown\nparagraph.\n\n${fresh}`, size), fresh, 'whitespace-normalised repeat');
    g = createContinuationGuard(kept);
    assert.equal(feed(g, fresh, size), fresh, 'nothing to drop');
    assert.equal(g.dropped, 0);
  }
  // a repeat with a (new) Cite pill still matches; a paragraph that merely starts the same way does not
  const cited = createContinuationGuard(`${P}Fact<Cite refs={["turn0search0"]}/> here.\n\n`);
  assert.equal(feed(cited, 'Fact<Cite refs={["turn0search3"]}/> here.\n\nNew.\n'), 'New.\n');
  const similar = createContinuationGuard(kept);
  assert.equal(feed(similar, 'Already shown paragraph, and then some.\n\nX'), 'Already shown paragraph, and then some.\n\nX');
  // the stream ends on a lone repeat: dropped
  assert.equal(feed(createContinuationGuard(kept), 'Already shown paragraph.'), '');
  // new text is released as soon as it cannot be a repeat (no long buffering)
  const early = createContinuationGuard(kept);
  assert.equal(early.push('Zebra'), 'Zebra');
  assert.equal(early.push(' crossing'), ' crossing');
  // empty kept text: pass-through
  assert.equal(feed(createContinuationGuard(''), '# T\n\nx'), '# T\n\nx');
});

// ---------------------------------------------------------------- over HTTP

const quiet = { warn() {}, error() {}, log() {}, info() {} };
async function withServer(opts, fn) {
  const server = createWonderServer({ demoDelayMs: 0, logger: quiet, memoryFile: null, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, server); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function readStream(res) {
  const recs = [];
  const turn = new ConversationTurn();
  const parser = new ConversationSourceParser((r) => { turn.apply(r); recs.push(r); });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) { const { value, done } = await reader.read(); if (done) break; parser.push(dec.decode(value, { stream: true })); }
  parser.finish();
  for (const r of recs) validateRecord(r);
  return { recs, turn };
}

test('Claude path: a resume that repeats the page heading and last paragraph is de-duplicated', async () => {
  const LESSON = '# Tides\n\nHook.\n\n## Why tides happen\n\nThe moon pulls the ocean.\n\nThe sun helps a little';
  const kept = '# Tides\n\nHook.\n\n## Why tides happen\n\nThe moon pulls the ocean.\n\n';
  const client = fakeClient({ text: '## Why tides happen\n\nThe moon pulls the ocean.\n\nThe sun helps a little too.\n\n## Check your understanding\n\nQuiz.\n', chunks: undefined });
  await withServer({ mode: 'claude', client }, async (base) => {
    const { recs, turn } = await readStream(await post(base, '/api/lesson/stream', { topic: 'tides', useWebSearch: false, continueFrom: { markdown: LESSON } }));
    const replace = recs.find((r) => r.type === 'content' && r.mode === 'replace' && r.revision > 1);
    assert.equal(replace.markdown, kept, 'kept up to the last complete paragraph');
    assert.equal(turn.primary.markdown, `${kept}The sun helps a little too.\n\n## Check your understanding\n\nQuiz.\n`);
    assert.equal(pageTitles(turn.primary.markdown).filter((t) => t === 'Why tides happen').length, 1, 'the heading is not repeated');
    const { params } = client.calls.stream[0];
    assert.equal(params.messages.length, 1, 'no assistant prefill');
    assert.match(params.messages[0].content[1].text, /very next sentence/);
  });
});

test('demo resume over HTTP from a mid-page paragraph boundary: seamless, no repeated heading, deterministic', async () => {
  await withServer({ mode: 'demo' }, async (base) => {
    const full = (await readStream(await post(base, '/api/lesson/stream', { topic: 'compound interest' }))).turn.primary;
    const md = full.markdown;
    // cut inside the paragraph after the LessonStepper on "Watching it snowball"
    const at = md.indexOf('All of that collapses') + 20;
    const partial = md.slice(0, at);
    const kept = trimToLastBlock(partial);
    assert.ok(kept.endsWith('}]}/>\n\n'), 'kept ends right after the stepper, mid-page');
    assert.ok(kept.length > trimToLastPage(partial).length);
    const { recs, turn } = await readStream(await post(base, '/api/lesson/stream', { topic: 'compound interest', continueFrom: { markdown: partial } }));
    const replace = recs.find((r) => r.type === 'content' && r.mode === 'replace' && r.revision > 1);
    assert.equal(replace.markdown, kept);
    assert.equal(turn.primary.status, 'complete');
    assert.equal(turn.primary.markdown, md, 'resuming mid-page reproduces the sample exactly');
    assert.deepEqual(pageTitles(turn.primary.markdown), pageTitles(md));
    assert.deepEqual(runProgram(turn.primary.dil).errors, []);
    // with a change: the current page's complete paragraphs are kept too, the rest steered
    const steered = await readStream(await post(base, '/api/lesson/stream', { topic: 'compound interest', continueFrom: { markdown: partial, instruction: STEER_CHIPS[0].instruction } }));
    const out = steered.turn.primary.markdown;
    assert.ok(out.startsWith(kept));
    assert.equal(pageTitles(out).length, pageTitles(md).length, 'no page heading repeated');
    assert.match(out, /Steered: Simpler/);
    assert.ok(steered.recs.some((r) => r.detail?.kind === 'steering-message'));
  });
});

// ---------------------------------------------------------------- cross-tab lock

function fakeEnv(start = 1_000_000) {
  let t = start;
  let nextId = 1;
  const intervals = new Map();
  const map = new Map();
  return {
    now: () => t,
    storage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) },
    map,
    timers: {
      setInterval: (f, ms) => { const id = nextId++; intervals.set(id, { f, ms, next: t + ms }); return id; },
      clearInterval: (id) => intervals.delete(id),
    },
    intervals,
    /** Advance the clock, firing due intervals in order. */
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...intervals.entries()].filter(([, v]) => v.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
        if (!due) break;
        t = due[1].next;
        due[1].next += due[1].ms;
        due[1].f();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}

const leaseTab = (env, owner, extra = {}) => createLessonLocks({ locks: null, storage: env.storage, now: env.now, timers: env.timers, channel: null, target: null, owner, settleMs: 1, ...extra });

test('lease fallback: acquisition, exclusivity, renewal, expiry and release', async () => {
  const env = fakeEnv();
  const a = leaseTab(env, 'tab-a');
  const b = leaseTab(env, 'tab-b');
  assert.equal(a.mode, 'lease');
  const h = await a.acquire('L1');
  assert.ok(h);
  assert.equal(h.kind, 'lease');
  assert.deepEqual(JSON.parse(env.map.get(leaseKey('L1'))), { owner: 'tab-a', expires: env.now() + LEASE_TTL_MS });
  assert.equal(await b.isHeld('L1'), true);
  assert.equal(await a.isHeld('L1'), false, 'not "elsewhere" for its own holder');
  assert.equal(await b.acquire('L1'), null, 'a second tab cannot take it');
  assert.equal(await a.acquire('L1'), null, 'nor the same page twice');
  assert.ok(await b.acquire('L2'), 'other lessons are independent');
  // renewal keeps it alive well past the TTL
  await env.tick(LEASE_TTL_MS * 3);
  assert.equal(await b.isHeld('L1'), true);
  assert.ok(JSON.parse(env.map.get(leaseKey('L1'))).expires > env.now() + LEASE_TTL_MS - LEASE_RENEW_MS - 1);
  // release frees it at once
  await h.release();
  await h.release(); // idempotent
  assert.equal(env.map.has(leaseKey('L1')), false);
  assert.equal(await b.isHeld('L1'), false);
  const hb = await b.acquire('L1');
  assert.ok(hb);
  // a crashed holder (no renewals) expires after the TTL
  env.intervals.clear(); // simulate tab-b freezing / crashing
  assert.equal(await a.isHeld('L1'), true);
  await env.tick(LEASE_TTL_MS + 1);
  assert.equal(await a.isHeld('L1'), false, 'expired lease is free');
  assert.ok(await a.acquire('L1'), 'and can be taken over');
  // a stale holder does not steal it back on its renewal tick, nor clear it on release
  await hb.release();
  assert.equal(JSON.parse(env.map.get(leaseKey('L1'))).owner, 'tab-a');
  a.close(); b.close();
});

test('lease fallback: watch() fires when the other tab releases (storage event or poll), releaseOnHide on pagehide', async () => {
  const env = fakeEnv();
  const target = new EventTarget();
  const a = leaseTab(env, 'tab-a', { target });
  const b = leaseTab(env, 'tab-b', { target: new EventTarget() });
  await a.acquire('L1');
  let freed = 0;
  b.watch('L1', () => { freed++; });
  await env.tick(LEASE_RENEW_MS * 2);
  assert.equal(freed, 0, 'still held: no callback');
  target.dispatchEvent(new Event('pagehide')); // tab a unloads: releaseOnHide (default) frees it
  assert.equal(env.map.has(leaseKey('L1')), false);
  await env.tick(LEASE_RENEW_MS);
  assert.equal(freed, 1, 'poll noticed the release');
  await env.tick(LEASE_RENEW_MS * 3);
  assert.equal(freed, 1, 'once');
  // storage event path (another tab removed the lease key)
  const c = leaseTab(env, 'tab-c', { target: null, releaseOnHide: false });
  const hc = await c.acquire('L2');
  const bTarget = new EventTarget();
  const d = leaseTab(env, 'tab-d', { target: bTarget });
  let freedD = false;
  d.watch('L2', () => { freedD = true; }, { intervalMs: 60_000 });
  await hc.release();
  const ev = new Event('storage');
  Object.assign(ev, { key: leaseKey('L2'), newValue: null });
  bTarget.dispatchEvent(ev);
  await new Promise((r) => setImmediate(r));
  assert.equal(freedD, true);
  a.close(); b.close(); c.close(); d.close();
});

test('Web Locks: two tabs share navigator.locks; held for the stream, free after release; channel notifies watchers', async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no navigator.locks in this runtime');
  const channel = new EventTarget();
  channel.postMessage = (data) => queueMicrotask(() => channel.dispatchEvent(Object.assign(new Event('message'), { data })));
  const env = fakeEnv();
  const id = `L-${Date.now()}`;
  const a = createLessonLocks({ locks: navigator.locks, storage: null, channel, target: null, owner: 'tab-a', timers: env.timers });
  const b = createLessonLocks({ locks: navigator.locks, storage: null, channel, target: null, owner: 'tab-b', timers: env.timers });
  assert.equal(a.mode, 'web-locks');
  const h = await a.acquire(id);
  assert.ok(h);
  assert.equal(h.kind, 'web-locks');
  assert.equal(await b.isHeld(id), true);
  assert.equal(await a.isHeld(id), false);
  assert.equal(await b.acquire(id), null, 'ifAvailable: the second tab does not queue, it gets null');
  let taken = 0;
  const stopTaken = a.onTaken(id, () => { taken++; });
  let freed = false;
  b.watch(id, () => { freed = true; }, { intervalMs: 60_000 });
  await h.release(); // resolves once the lock is really free
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(freed, true, 'the broadcast "released" woke the watcher');
  assert.equal(await b.isHeld(id), false);
  const hb = await b.acquire(id);
  assert.ok(hb, 'right after release, the other tab can take it');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(taken, 1, 'the first tab is told another tab took the lesson (not for its own acquire)');
  stopTaken();
  await hb.release();
  // the probe path (no locks.query)
  const probeLocks = { request: navigator.locks.request.bind(navigator.locks) };
  const c = createLessonLocks({ locks: probeLocks, storage: null, channel: null, target: null, owner: 'tab-c', timers: env.timers });
  const hc = await a.acquire(id);
  assert.equal(await c.isHeld(id), true);
  await hc.release();
  assert.equal(await c.isHeld(id), false);
  a.close(); b.close(); c.close();
});

test('interrupted detection respects a live lock held by another tab', async () => {
  const env = fakeEnv();
  const writer = leaseTab(env, 'page-a');
  const reader = leaseTab(env, 'page-b');
  const lesson = { status: 'streaming', streamOwner: 'page-a', markdown: '# T\n\n## A\n\nx' };
  await writer.acquire('L1');
  const elsewhere = await reader.isHeld('L1');
  assert.equal(lessonPhase(lesson, { pageId: 'page-b', lockedElsewhere: elsewhere }), 'elsewhere', 'not interrupted while the other tab writes');
  assert.equal(lessonPhase({ status: 'interrupted', markdown: 'x' }, { pageId: 'page-b', lockedElsewhere: true }), 'elsewhere', 'a resume elsewhere that has not saved yet');
  assert.equal(lessonPhase({ status: 'streaming', streamOwner: 'page-a', markdown: '' }, { pageId: 'page-b', lockedElsewhere: true }), 'elsewhere', 'a brand-new lesson elsewhere: do not start a second stream');
  assert.equal(lessonPhase({ status: 'complete', dil: {}, markdown: 'x' }, { pageId: 'page-b', lockedElsewhere: true }), 'elsewhere', 'a revise elsewhere');
  // the writer tab crashed: lease expires, so the lesson counts as interrupted again
  env.intervals.clear();
  await env.tick(LEASE_TTL_MS + 1);
  assert.equal(lessonPhase(lesson, { pageId: 'page-b', lockedElsewhere: await reader.isHeld('L1') }), 'interrupted');
  writer.close(); reader.close();
});
