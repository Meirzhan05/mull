// Streamed formulas fade in with the words around them; restored lessons render statically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { typesetMath } from '../public/math.js';

/** Just enough DOM for typesetMath. */
function el(tag, { classes = [], attrs = {}, text = '', streamingSurface = false } = {}) {
  const node = {
    tagName: tag, children: [], childNodes: [], attrs: { ...attrs }, _text: text,
    classList: { set: new Set(classes), contains(c) { return this.set.has(c); } },
    get className() { return [...this.classList.set].join(' '); },
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = v; this.children = []; this.childNodes = []; },
    hasAttribute(k) { return k in this.attrs; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); c.parentElement = this; return c; },
    closest(sel) { return sel === '.dil-root' ? surface : null; },
    ownerDocument: { createElement: (t) => el(t) },
    nodeType: 1,
  };
  const surface = { querySelector: (sel) => (sel === '[data-d-streaming-word]' && streamingSurface ? {} : null) };
  if (text) { node._text = ''; node.childNodes.push({ nodeType: 3, textContent: text }); } // host LaTeX lives in a text node
  return node;
}
const katex = { render(latex, out) { out.textContent = `K(${latex})`; } };

test('a formula that appears while its surface streams gets the fade-in attribute', () => {
  const node = el('div', { attrs: { 'data-d-component': 'math', 'data-display': '' }, text: '\\frac{1}{2}', streamingSurface: true });
  typesetMath(node, katex);
  const out = node.children.find((c) => c.classList.contains('wonder-math-out'));
  assert.ok(out.hasAttribute('data-wonder-math-enter'));
  assert.equal(node.attrs['data-wonder-math'], 'katex');
});

test('a formula in a restored (non-streaming) lesson renders without animation', () => {
  const node = el('div', { attrs: { 'data-d-component': 'math' }, text: 'x^2', streamingSurface: false });
  typesetMath(node, katex);
  const out = node.children.find((c) => c.classList.contains('wonder-math-out'));
  assert.ok(!out.hasAttribute('data-wonder-math-enter'));
});

test('re-typesetting an existing formula (KaTeX loading late) does not re-trigger the fade', () => {
  const node = el('div', { attrs: { 'data-d-component': 'math' }, text: 'y', streamingSurface: false });
  typesetMath(node, null); // Unicode fallback first
  const out = node.children.find((c) => c.classList.contains('wonder-math-out'));
  assert.ok(!out.hasAttribute('data-wonder-math-enter'));
});
