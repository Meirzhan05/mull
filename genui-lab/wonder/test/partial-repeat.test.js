// A continuation (after a search, or a resume) sometimes restates the last sentence it wrote
// and then goes on. Leading repeated sentences are trimmed; new sentences are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimRepeatedLead, splitSentences, createRepeatFilter } from '../server/grounding.js';
import { createContinuationGuard } from '../server/steering.js';

const KEPT = '## Tides\n\nThe Moon pulls on the oceans. Water bulges toward it on the near side of Earth and away from it on the far side.\n\n';

test('splitSentences keeps punctuation and spacing', () => {
  assert.deepEqual(splitSentences('One. Two? Three!'), ['One. ', 'Two? ', 'Three!']);
});

test('trimRepeatedLead: a restated (or lightly reworded) sentence at the start is dropped', () => {
  assert.equal(
    trimRepeatedLead('Water bulges toward it on the near side of Earth and away from it on the far side. That makes two high tides a day.', KEPT),
    'That makes two high tides a day.');
  assert.equal(
    trimRepeatedLead('Water bulges toward the Moon on the near side of Earth, and away from it on the far side. Two high tides follow.', KEPT),
    'Two high tides follow.');
});

test('trimRepeatedLead: new sentences, headings and markup are never trimmed', () => {
  const fresh = 'The Sun adds its own, smaller pull. When Sun and Moon line up, tides are higher.';
  assert.equal(trimRepeatedLead(fresh, KEPT), fresh);
  assert.equal(trimRepeatedLead('## Tides', KEPT), '## Tides');
  assert.equal(trimRepeatedLead('<Quiz questions={[]}/>', KEPT), '<Quiz questions={[]}/>');
  assert.equal(trimRepeatedLead('The Moon pulls on the oceans.', KEPT), 'The Moon pulls on the oceans.', 'a lone sentence is left for the paragraph-level check');
});

test('resume guard: a continuation that restates the last sentence is trimmed', () => {
  const g = createContinuationGuard(KEPT);
  let out = '';
  for (const ch of 'Water bulges toward it on the near side of Earth and away from it on the far side. So most coasts get two high tides a day.\n\n## Next page\n\nMore.') out += g.push(ch);
  out += g.flush();
  assert.equal(out, 'So most coasts get two high tides a day.\n\n## Next page\n\nMore.');
});

test('post-search filter: a paragraph opening with an already-written sentence is trimmed', () => {
  const out = { text: '' };
  const asm = { blockStart() {}, text(t) { out.text += t; }, citation() {}, blockStop() {}, flush() {} };
  const f = createRepeatFilter(asm);
  f.text('# Tides\n\nThe Moon pulls on the oceans, raising two bulges of water around Earth every day.\n\n');
  f.afterSearch();
  f.text('The Moon pulls on the oceans, raising two bulges of water around Earth every day. Recent measurements put the bulge at about 54 cm in open ocean.\n\nNext.');
  f.blockStop(); f.flush();
  assert.equal((out.text.match(/raising two bulges/g) || []).length, 1);
  assert.match(out.text, /\n\nRecent measurements put the bulge at about 54 cm in open ocean\.\n\nNext\.$/);
});
