// The DOM host's pure pieces: SVG attributes (incl. the Wonder extensions used by <Diagram/>),
// the remote-image check behind allowRemoteImages, and the youtube player (embed URL, player
// messages, cues) used by Wonder's <Video/>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSvgPresentation, isRemoteSrc, youtubeEmbedUrl, isYouTubeId, parsePlayerMessage, advanceCues, YOUTUBE_EMBED_ORIGIN, YOUTUBE_SANDBOX } from '../src/host.js';

test('svg children keep their size, svg-text gets its text and font attributes', () => {
  const rect = computeSvgPresentation('rect', { x: 40, y: 40, width: 140, height: 80, rx: 14, fill: '#f00', stroke: 'secondary', strokeWidth: 2 });
  assert.deepEqual(rect.attrs, { x: '40', y: '40', width: '140', height: '80', rx: '14', 'stroke-width': '2' });
  assert.deepEqual(rect.style, { fill: '#f00', stroke: 'var(--d-text-secondary)' });
  assert.equal(computeSvgPresentation('image', { width: 20, height: 10 }).attrs.width, '20', 'any sized child, not only rect');
  const root = computeSvgPresentation('svg', { viewBox: '0 0 400 250', width: '100%', role: 'img', ariaLabel: 'Heart' });
  assert.equal(root.attrs.width, undefined, 'the root svg is sized by CSS, not attributes');
  assert.equal(root.style.width, '100%');
  assert.deepEqual([root.attrs.viewBox, root.attrs.role, root.attrs['aria-label']], ['0 0 400 250', 'img', 'Heart']);
  const label = computeSvgPresentation('svg-text', { x: 10, y: 20, text: 'Left ventricle', fontSize: 15, fontWeight: 650, textAnchor: 'middle', dominantBaseline: 'middle', paintOrder: 'stroke', pointerEvents: 'none', __component: 'DiagramShape' });
  assert.equal(label.text, 'Left ventricle');
  assert.deepEqual(label.attrs, { x: '10', y: '20', 'font-size': '15', 'font-weight': '650', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'paint-order': 'stroke', 'pointer-events': 'none', 'data-dil-catalog': 'DiagramShape' });
  assert.equal(computeSvgPresentation('path', { d: 'M0 0' }).text, undefined);
});

test('a clickable shape is a keyboard button unless aria-hidden (a pointer-only hit area)', () => {
  const btn = computeSvgPresentation('circle', { cx: 1, cy: 1, r: 1, onClick: { __fn: 7 }, ariaLabel: 'Sun', ariaPressed: true });
  assert.equal(btn.onClick, 7);
  assert.deepEqual([btn.attrs.tabindex, btn.attrs.role, btn.attrs['aria-label'], btn.attrs['aria-pressed']], ['0', 'button', 'Sun', 'true']);
  assert.equal(btn.style.cursor, 'pointer');
  const hit = computeSvgPresentation('path', { d: 'M0 0', onClick: { __fn: 8 }, ariaHidden: true, ariaLabel: 'x' });
  assert.equal(hit.onClick, 8);
  assert.equal(hit.attrs['aria-hidden'], 'true');
  assert.equal(hit.attrs.tabindex, undefined);
  assert.equal(hit.attrs.role, undefined);
  assert.equal(hit.style.cursor, 'pointer');
  assert.equal(computeSvgPresentation('rect', { x: 0 }).onClick, null);
  assert.equal(computeSvgPresentation('svg', { onClick: { __fn: 9 } }).onClick, null, 'the root svg is never a button');
});

test('remote image sources: protocol-relative and look-alike origins are remote', () => {
  const page = 'http://localhost:8751/#/lesson/x';
  assert.equal(isRemoteSrc('https://upload.wikimedia.org/a.jpg', page), true);
  assert.equal(isRemoteSrc('//tracker.example/p.gif', page), true);
  assert.equal(isRemoteSrc('http://localhost:8751.evil.example/p.gif', page), true);
  assert.equal(isRemoteSrc('http://localhost:8751/img/a.png', page), false);
  assert.equal(isRemoteSrc('/img/a.png', page), false);
  assert.equal(isRemoteSrc('data:image/png;base64,AAAA', page), false);
  assert.equal(isRemoteSrc('blob:http://localhost:8751/123', page), false);
  assert.equal(isRemoteSrc('https://upload.wikimedia.org/a.jpg', undefined), true, 'no page origin: everything absolute is remote');
});

test('youtube: the host builds the embed URL itself, on youtube-nocookie.com only', () => {
  const u = new URL(youtubeEmbedUrl({ videoId: 'Ab3_dEf-9hI', start: 65.7, end: 190 }, 'http://localhost:8751'));
  assert.equal(u.origin, YOUTUBE_EMBED_ORIGIN);
  assert.equal(u.pathname, '/embed/Ab3_dEf-9hI');
  assert.deepEqual(Object.fromEntries(u.searchParams), { start: '65', end: '190', rel: '0', playsinline: '1', iv_load_policy: '3', enablejsapi: '1', origin: 'http://localhost:8751' });
  const bare = new URL(youtubeEmbedUrl({ videoId: 'Ab3_dEf-9hI', start: 0, end: -5 }, 'null'));
  assert.equal(bare.searchParams.get('start'), null);
  assert.equal(bare.searchParams.get('end'), null);
  assert.equal(bare.searchParams.get('origin'), null, 'an opaque origin is not sent');
  assert.equal(youtubeEmbedUrl({ videoId: 'Ab3_dEf-9hI', start: 30, end: 10 }).includes('end='), false, 'end before start is dropped');
  for (const id of ['../evil', 'Ab3_dEf-9hI?x=1', 'https://evil.example/embed', 'Ab3_dEf-9h', '', null]) {
    assert.equal(youtubeEmbedUrl({ videoId: id }), null, String(id));
    assert.equal(isYouTubeId(id), false, String(id));
  }
  assert.doesNotMatch(YOUTUBE_SANDBOX, /allow-top-navigation|allow-forms|allow-modals/);
});

test('youtube: player messages give the time and state; cues fire once, pause, and re-arm on rewind', () => {
  assert.deepEqual(parsePlayerMessage(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12.5, playerState: 1 } })), { time: 12.5, state: 1 });
  assert.deepEqual(parsePlayerMessage({ event: 'onStateChange', info: 0 }), { state: 0 });
  assert.deepEqual(parsePlayerMessage('{"event":"onReady"}'), { ready: true });
  for (const junk of ['not json', '{"event":"other"}', 42, null, JSON.stringify({ event: 'infoDelivery', info: { currentTime: 'x' } })]) {
    const r = parsePlayerMessage(junk);
    assert.ok(r === null || (r.time === undefined && r.state === undefined), String(junk));
  }
  const fired = new Set();
  assert.deepEqual(advanceCues(fired, [190], { time: 100, state: 1 }), { fire: [], pause: false });
  assert.deepEqual(advanceCues(fired, [190], { time: 189.8, state: 1 }), { fire: [0], pause: true }, 'just before the end: fire and pause before the end screen');
  assert.deepEqual(advanceCues(fired, [190], { time: 190, state: 1 }), { fire: [], pause: false }, 'once');
  advanceCues(fired, [190], { time: 20, state: 1 });
  assert.deepEqual(advanceCues(fired, [190], { time: 190, state: 1 }).fire, [0], 'rewinding re-arms the cue');
  assert.deepEqual(advanceCues(new Set(), [190, 'x', NaN], { state: 0 }), { fire: [0], pause: false }, 'ended without a time update: fire, nothing to pause');
});
