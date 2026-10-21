// Regression: a lesson actually written by claude-opus-5-5 through /api/lesson/stream
// must keep compiling with every component valid, at every streamed prefix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileWonder } from '../server/compile.js';
import { runProgram, catalogNodes } from './helpers.js';

const md = fs.readFileSync(new URL('./fixtures/claude-lesson-vaccines.md', import.meta.url), 'utf8');

test('real Claude lesson: every component validates and the program runs', () => {
  const out = compileWonder(md);
  const invalid = out.components.filter((c) => c.status !== 'valid');
  assert.deepEqual(invalid, []);
  const env = runProgram(out);
  assert.deepEqual(env.errors, []);
  for (const name of ['Quiz', 'LessonStepper', 'ConceptMap', 'BarChart', 'Reveal']) {
    assert.ok(catalogNodes(env.mirror, name).length >= 1, `${name} rendered`);
  }
});

test('real Claude lesson: every streamed prefix compiles and runs', () => {
  const step = Math.max(1, Math.floor(md.length / 80));
  for (let i = 0; i <= md.length; i += step) {
    const env = runProgram(compileWonder(md.slice(0, i), { partial: true }));
    assert.deepEqual(env.errors, [], `prefix ${i}`);
  }
});
