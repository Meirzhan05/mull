// Who opens the home page on the landing page (/welcome): the pre-paint script from
// app/landing-script.js, run in a vm against a fake page (URL, cookies, localStorage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { landingScript } from '../app/landing-script.js';

/** Run the script on a page; returns where it sent the page, or null when it stayed. */
function land(accounts, { url = 'http://localhost/', cookie = '', storage = {} } = {}) {
  const u = new URL(url);
  let to = null;
  const location = { pathname: u.pathname, hash: u.hash, search: u.search, replace: (x) => { to = x; } };
  const localStorage = { getItem: (k) => (k in storage ? storage[k] : null) };
  vm.runInNewContext(landingScript({ accounts }), { location, localStorage, document: { cookie } });
  return to;
}

test('landing, accounts on: every signed-out visit to the home page goes to /welcome', () => {
  assert.equal(land(true), '/welcome');
  assert.equal(land(true, { url: 'http://localhost/#/' }), '/welcome');
  assert.equal(land(true, { cookie: '__client_uat=0; __client_uat_XTs=0' }), '/welcome');
  // seen it before, or guest data in this browser: still signed out, still the landing page
  assert.equal(land(true, { storage: { 'wonder.welcomed': '1', 'wonder.v1': '{}' } }), '/welcome');
});

test('landing, accounts on: signed in, a lapsed account session, a sign-in redirect and deep links stay', () => {
  assert.equal(land(true, { cookie: 'a=1; __client_uat=1792807381' }), null);
  assert.equal(land(true, { storage: { 'wonder.account': '{"userId":"user_1"}' } }), null);
  assert.equal(land(true, { url: 'http://localhost/?__clerk_db_jwt=x' }), null);
  assert.equal(land(true, { url: 'http://localhost/#/learn/black%20holes' }), null);
  assert.equal(land(true, { url: 'http://localhost/#/lesson/lesson-1' }), null);
  assert.equal(land(true, { url: 'http://localhost/welcome' }), null);
  // a cookie that only ends in __client_uat is not Clerk's
  assert.equal(land(true, { cookie: 'x__client_uat=5' }), '/welcome');
});

test('landing, accounts off: only a first visit goes to /welcome', () => {
  assert.equal(land(false), '/welcome');
  assert.equal(land(false, { storage: { 'wonder.welcomed': '1' } }), null);
  assert.equal(land(false, { storage: { 'wonder.v1': '{}' } }), null);
  assert.equal(land(false, { storage: { 'wonder.account': '{}' } }), null);
  assert.equal(land(false, { cookie: '__client_uat=1792807381' }), null);
  assert.equal(land(false, { url: 'http://localhost/#/review' }), null);
});

test('landing: blocked storage never breaks the page', () => {
  const location = { pathname: '/', hash: '', search: '', replace: () => { throw new Error('redirected'); } };
  const localStorage = { getItem: () => { throw new Error('blocked'); } };
  assert.doesNotThrow(() => vm.runInNewContext(landingScript({ accounts: true }), { location, localStorage, document: { cookie: '' } }));
});
