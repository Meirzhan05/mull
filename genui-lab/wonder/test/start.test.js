// The landing page's "Continue with Google" route (#/start[/<topic>]): sign in first, then
// onboarding with the topic offered, then the lesson.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAction, startTopic } from '../public/start-core.js';

test('start: signed out with accounts on, sign-in comes first and keeps the topic', () => {
  assert.deepEqual(startAction({ accounts: true, signedIn: false, needsOnboarding: true, topic: 'Black holes' }), { action: 'signin', topic: 'Black holes' });
  assert.deepEqual(startAction({ accounts: true, signedIn: false, needsOnboarding: false }), { action: 'signin', topic: '' });
});

test('start: a new account goes through onboarding, with or without a topic', () => {
  assert.deepEqual(startAction({ accounts: true, signedIn: true, needsOnboarding: true, topic: 'Black holes' }), { action: 'onboard', topic: 'Black holes' });
  assert.deepEqual(startAction({ accounts: true, signedIn: true, needsOnboarding: true }), { action: 'onboard', topic: '' });
});

test('start: someone already onboarded starts the lesson, or goes home without a topic', () => {
  assert.deepEqual(startAction({ accounts: true, signedIn: true, needsOnboarding: false, topic: ' Compound interest ' }), { action: 'lesson', topic: 'Compound interest' });
  assert.deepEqual(startAction({ accounts: true, signedIn: true, needsOnboarding: false }), { action: 'home', topic: '' });
});

test('start: accounts off needs no sign-in', () => {
  assert.deepEqual(startAction({ accounts: false, signedIn: false, needsOnboarding: false, topic: 'Tides' }), { action: 'lesson', topic: 'Tides' });
  assert.deepEqual(startAction({ accounts: false, signedIn: false, needsOnboarding: true, topic: 'Tides' }), { action: 'onboard', topic: 'Tides' });
});

test('start: the topic in the hash', () => {
  assert.equal(startTopic('#/start/Why%20some%20chords%20sound%20sad'), 'Why some chords sound sad');
  assert.equal(startTopic('#/start'), '');
  assert.equal(startTopic('#/start/'), '');
  assert.equal(startTopic('#/start/%E0%A4%A'), '', 'undecodable');
  assert.equal(startTopic('#/starter'), '');
  assert.equal(startTopic('#/start/' + 'x'.repeat(300)).length, 200);
});
