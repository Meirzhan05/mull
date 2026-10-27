// Who opens the home page on the landing page (/welcome): the pre-paint script from
// app/landing-script.js, run in a vm against a fake page (URL, cookies, localStorage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { landingScript } from '../app/landing-script.js';

/** Run the script on a page; returns where it sent the page, or null when it stayed. */
function land(accounts, opts = {}) {
  return visit(accounts, opts).to;
}

/** The same, with the page's <html data-handoff> too ({to, handoff}). */
function visit(accounts, { url = 'http://localhost/', cookie = '', storage = {}, session = {} } = {}) {
  const u = new URL(url);
  let to = null;
  const attrs = {};
  const location = { pathname: u.pathname, hash: u.hash, search: u.search, replace: (x) => { to = x; } };
  const localStorage = { getItem: (k) => (k in storage ? storage[k] : null) };
  const sessionStorage = { getItem: (k) => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = v; } };
  const documentElement = { setAttribute: (k, v) => { attrs[k] = v; } };
  vm.runInNewContext(landingScript({ accounts }), { location, localStorage, sessionStorage, Date, Number, document: { cookie, documentElement } });
  return { to, handoff: attrs['data-handoff'] ?? null };
}

test('landing, accounts on: every signed-out visit to the home page goes to /welcome', () => {
  assert.equal(land(true), '/welcome');
  assert.equal(land(true, { url: 'http://localhost/#/' }), '/welcome');
  assert.equal(land(true, { cookie: 'a=1' }), '/welcome', 'cookies are not read (Neon Auth\'s are HttpOnly)');
  // seen it before, or guest data in this browser: still signed out, still the landing page
  assert.equal(land(true, { storage: { 'wonder.welcomed': '1', 'wonder.v1': '{}' } }), '/welcome');
});

test('landing, accounts on: a browser with an account, the return from Google and the ways into sign-in stay', () => {
  assert.equal(land(true, { storage: { 'wonder.account': '{"userId":"9e3c-user"}' } }), null);
  assert.equal(land(true, { storage: { 'wonder.account': '{}' }, url: 'http://localhost/#/lesson/lesson-1' }), null);
  assert.equal(land(true, { url: 'http://localhost/?neon_auth_session_verifier=6JZQs6Bv' }), null, 'back from Google: account.js finishes the sign-in');
  assert.equal(land(true, { url: 'http://localhost/?x=1&neon_auth_session_verifier=6JZ' }), null);
  assert.equal(land(true, { url: 'http://localhost/?not_neon_auth_session_verifier=1' }), '/welcome');
  // the landing page's Continue with Google, its Sign in link and old topic links lead into sign-in
  assert.equal(land(true, { url: 'http://localhost/#/start' }), null);
  assert.equal(land(true, { url: 'http://localhost/#/start/black%20holes' }), null);
  assert.equal(land(true, { url: 'http://localhost/#/signin' }), null);
  assert.equal(land(true, { url: 'http://localhost/#/learn/black%20holes' }), null);
  assert.equal(land(true, { url: 'http://localhost/#/starter' }), '/welcome', 'only #/start itself');
  assert.equal(land(true, { url: 'http://localhost/welcome' }), null);
});

test('landing, accounts on: the app stays hidden on the way to Google and back (data-handoff)', () => {
  assert.deepEqual(visit(true, { url: 'http://localhost/#/start/black%20holes' }), { to: null, handoff: 'google' });
  assert.equal(visit(true, { url: 'http://localhost/#/signin' }).handoff, 'google');
  assert.equal(visit(true, { url: 'http://localhost/#/learn/tides' }).handoff, 'google');
  assert.deepEqual(visit(true, { url: 'http://localhost/?neon_auth_session_verifier=6JZ' }), { to: null, handoff: 'return' });
  // the reload into a fresh account (public/account.js beginAccount) lands on onboarding unseen
  const account = { 'wonder.account': '{"userId":"9e3c-user"}' };
  assert.equal(visit(true, { storage: account, session: { 'wonder.beginAccount': String(Date.now() - 2000) } }).handoff, 'return');
  assert.equal(visit(true, { storage: account, session: { 'wonder.beginAccount': String(Date.now() - 60_000) } }).handoff, null, 'a later reload shows the app at once');
  assert.equal(visit(true, { storage: account }).handoff, null);
  assert.equal(visit(true).handoff, null, 'the redirect to /welcome is not a hand-off');
  assert.equal(visit(false, { url: 'http://localhost/#/start' }).handoff, null, 'accounts off: nothing to hand off to');
});

test('landing, accounts on: a signed-out deep link goes to /welcome and is kept for after sign-in', () => {
  const session = {};
  assert.equal(land(true, { url: 'http://localhost/#/lesson/lesson-1', session }), '/welcome');
  assert.equal(session['wonder.signInReturn'], '#/lesson/lesson-1');
  const home = {};
  assert.equal(land(true, { url: 'http://localhost/#/', session: home }), '/welcome');
  assert.deepEqual(home, {}, 'the home page is not a link to come back to');
});

test('landing, accounts off: only a first visit goes to /welcome', () => {
  assert.equal(land(false), '/welcome');
  assert.equal(land(false, { storage: { 'wonder.welcomed': '1' } }), null);
  assert.equal(land(false, { storage: { 'wonder.v1': '{}' } }), null);
  assert.equal(land(false, { storage: { 'wonder.account': '{}' } }), null);
  assert.equal(land(false, { url: 'http://localhost/#/review' }), null);
});

test('landing: blocked storage never breaks the page', () => {
  const location = { pathname: '/', hash: '', search: '', replace: () => { throw new Error('redirected'); } };
  const localStorage = { getItem: () => { throw new Error('blocked'); } };
  assert.doesNotThrow(() => vm.runInNewContext(landingScript({ accounts: true }), { location, localStorage, document: { cookie: '' } }));
});
