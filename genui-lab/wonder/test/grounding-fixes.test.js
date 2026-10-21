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
