// The DOM host's pure pieces: SVG attributes (incl. the Wonder extensions used by <Diagram/>)
// and the remote-image check behind allowRemoteImages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSvgPresentation, isRemoteSrc } from '../src/host.js';

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
