// Two live-found grounding bugs: a re-written title/hook after a web search, and citation pills
// inserted inside an unfinished $…$ math span.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepeatFilter, isSafeInsertionPoint } from '../server/grounding.js';

function sink() {
  const out = { text: '', cites: [], log: [] };
  return {
    out,
    asm: {
      blockStart() { out.log.push('start'); },
      text(t) { out.text += t; },
      citation(c) { out.cites.push(c); out.log.push(`cite@${out.text.length}`); },
      blockStop() { out.log.push('stop'); },
      flush() {},
    },
  };
}

test('repeat filter: a title + hook re-written after a search is dropped', () => {
  const { out, asm } = sink();
  const f = createRepeatFilter(asm);
  f.blockStart(); f.text('# Webb\n\nWebb sees the early universe.\n\n'); f.blockStop();
  f.afterSearch();
  f.blockStart();
  for (const ch of '# Webb\n\nWebb sees  the early universe.\n\n## Page one\n\nNew facts.') f.text(ch); // streamed char by char, extra space
  f.blockStop(); f.flush();
  assert.equal(out.text, '# Webb\n\nWebb sees the early universe.\n\n## Page one\n\nNew facts.');
});

test('repeat filter: new text after a search passes straight through, citations kept', () => {
  const { out, asm } = sink();
  const f = createRepeatFilter(asm);
  f.text('# Title\n\nHook.\n\n');
  f.afterSearch();
  f.citation({ url: 'https://a.example' });
  f.text('## First page\n\nFact one.');
  f.blockStop(); f.flush();
  assert.equal(out.text, '# Title\n\nHook.\n\n## First page\n\nFact one.');
  assert.equal(out.cites.length, 1);
});

test('repeat filter: nothing is buffered before the first search', () => {
  const { out, asm } = sink();
  const f = createRepeatFilter(asm);
  f.afterSearch(); // search before any text: nothing to compare against
  f.text('# Title');
  assert.equal(out.text, '# Title');
});

test('cites are never inserted inside an unfinished math span', () => {
  assert.equal(isSafeInsertionPoint('Energy is $E = mc'), false);
  assert.equal(isSafeInsertionPoint('Display: $$\\frac{1}{2'), false);
  assert.equal(isSafeInsertionPoint('Block \\[ a^2'), false);
  assert.equal(isSafeInsertionPoint('Energy is $E = mc^2$ here'), true);
  assert.equal(isSafeInsertionPoint('It costs $40 and $5 more'), true); // prices are not math
});

import { isRepeat } from '../server/grounding.js';

test('isRepeat: reworded hooks and headings count as repeats', () => {
  const hook = 'The James Webb Space Telescope has spent the last few years rewriting what we know about the early universe, distant planets and how galaxies form.';
  assert.ok(isRepeat('Over the last few years, the James Webb Space Telescope has been rewriting what we know about the early universe, distant planets, and how galaxies form.', hook));
  assert.ok(isRepeat('# What Webb Has Discovered So Far', '# What Webb has discovered so far'));
  assert.ok(isRepeat('Picture this: one sick person infects two others, and each of them infects two more.', 'Picture this: one sick person infects two others. Each of them then infects two more.'));
});

test('isRepeat: new paragraphs on the same topic are kept (no false positives)', () => {
  const hook = 'The James Webb Space Telescope has spent the last few years rewriting what we know about the early universe, distant planets and how galaxies form.';
  assert.ok(!isRepeat('## Page 1: Seeing the first galaxies', '# What Webb has discovered so far'));
  assert.ok(!isRepeat('Webb found galaxies that existed just 290 million years after the Big Bang, far brighter and more mature than models predicted.', hook));
  assert.ok(!isRepeat('In 2023 Webb detected carbon dioxide in the atmosphere of the exoplanet WASP-39b, the first clear detection of its kind.', hook));
  assert.ok(!isRepeat('Exponential growth means each step multiplies the total.', 'Linear growth means each step adds the same amount to the total.'));
});

test('repeat filter: a reworded hook after a search is dropped, new content kept', () => {
  const { out, asm } = sink();
  const f = createRepeatFilter(asm);
  f.text('# Webb so far\n\nThe James Webb Space Telescope has spent the last few years rewriting what we know about the early universe, distant planets and how galaxies form.\n\n');
  f.afterSearch();
  f.text('Over the last few years, the James Webb Space Telescope has been rewriting what we know about the early universe, distant planets, and how galaxies form.\n\n## Page 1: The first galaxies\n\nWebb found galaxies just 290 million years after the Big Bang.');
  f.blockStop(); f.flush();
  assert.equal((out.text.match(/rewriting what we know/g) || []).length, 1);
  assert.match(out.text, /## Page 1: The first galaxies\n\nWebb found galaxies/);
});
