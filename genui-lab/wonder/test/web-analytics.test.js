// Vercel Web Analytics paths (app/analytics-path.js): one path per screen, never an id or a topic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPath } from '../app/analytics-path.js';

test('each hash screen reports its own path, without ids, topics or queries', () => {
  const cases = [
    ['', '/'], ['#/', '/'], ['#/lesson/abc-123', '/lesson'], ['#/course/c1', '/course'],
    ['#/review', '/review'], ['#/review/lesson/abc', '/review'], ['#/teacher/t9', '/teacher'],
    ['#/library', '/library'], ['#/you', '/you'], ['#/memory', '/you'], ['#/interests', '/you'],
    ['#/start/why%20the%20sky%20is%20blue', '/start'], ['#/learn/black-holes', '/start'], ['#/signin', '/signin'],
    ['#/nowhere/secret', '/'], ['#/you?x=1', '/you'],
  ];
  for (const [hash, want] of cases) assert.equal(analyticsPath('/', hash), want, hash);
});

test('other pages report their pathname', () => {
  assert.equal(analyticsPath('/privacy', ''), '/privacy');
  assert.equal(analyticsPath('/terms', '#/lesson/x'), '/terms');
});
