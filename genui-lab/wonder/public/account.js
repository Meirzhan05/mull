// Accounts in the browser: which local cache this page uses, sign-in (Neon Auth with Google, through
// globalThis.__wonderAuth from app/wonder-app.js) and the first-sign-in migration, the sync engine, sign-out, and Web
// Push. Everything here is inert unless the server says account sync is on (GET /api/account).
//
//   signed out:  store.js over localStorage ('wonder.v1'), exactly as before accounts existed
//   signed in:   store.js over this account's IndexedDB cache (idb-storage.js), synced with the
//                server (sync-client.js); 'wonder.account' in localStorage names the account so
//                the next page load opens the right cache before the network answers
//
// First sign-in in a browser: if this browser has signed-out data, it is merged into the account
// (asking first when the account already has data); the signed-out copy is removed once the
// server has it. Sign-out syncs, then deletes the account's cache from this browser.

import { openIdbStorage, prefixedLocalStorage } from './idb-storage.js';
import { createSyncEngine, syncBeforeOpening, awaitsFirstSync, BASE_KEY } from './sync-client.js';
import { hasLearnerData, diffRecords, toRecords } from './sync-core.js';
import { emptyState } from './store.js';

export const ACCOUNT_KEY = 'wonder.account';
export const PUSH_KEY = 'wonder.push'; // this browser's push endpoint while push reminders are on
const STATE_KEY = 'wonder.v1'; // store.js KEY
const MIGRATED_KEY = 'wonder.migrate'; // signed-out data waiting to be confirmed on the server

const ls = () => { try { return globalThis.localStorage; } catch { return null; } };
const readJson = (k) => { try { return JSON.parse(ls()?.getItem(k) || 'null'); } catch { return null; } };

let info = null; // /api/account
let engine = null;
let cache = null; // the account's storage
let current = null; // {userId}
let theStore = null;
let switching = false; // beginAccount() is reloading this page into an account
const statusListeners = new Set();
let syncStatus = { state: 'off' };

async function getJson(url, init) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}
const postJson = (url, body, method = 'POST') => getJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const postSync = (body) => postJson('/api/sync', body);
// one sync at a time per account, across this browser's tabs
const syncLock = (userId) => (fn) => (globalThis.navigator?.locks ? navigator.locks.request(`wonder-sync-${userId}`, fn) : fn());

/**
 * Before the store is created: the storage this page should use. Signed in last time -> that
 * account's cache; otherwise undefined (store.js picks localStorage).
 */
export async function openLocalCache() {
  const acct = readJson(ACCOUNT_KEY);
  if (!acct?.userId) return { storage: undefined, account: null };
  try { cache = await openIdbStorage(acct.userId); } catch { cache = prefixedLocalStorage(acct.userId); }
  current = { userId: acct.userId };
  return { storage: cache, account: current };
}

/** Another tab signed in or out: this page's cache is the wrong one now. */
function watchAccountSwitch() {
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === ACCOUNT_KEY && (readJson(ACCOUNT_KEY)?.userId || null) !== (current?.userId || null)) location.reload();
  });
}

function setStatus(s) {
  syncStatus = { ...syncStatus, ...s };
  for (const fn of statusListeners) { try { fn(syncStatus); } catch {} }
}

/** Neon Auth's browser client (made by app/wonder-app.js before this module loads), or null. */
async function authClient(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (globalThis.__wonderAuth) return globalThis.__wonderAuth;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

let sessionUser = null; // the signed-in Neon Auth user ({id, email, name, ...}), when known
const VERIFIER = 'neon_auth_session_verifier';
const RETURN_HASH = 'wonder.signInReturn';

/**
 * The signed-in user per Neon Auth, or null. Back from Google, the URL carries a one-time session
 * verifier: the client's getSession() sends it to /api/auth/get-session, which exchanges it for
 * the session cookie (then strips it from the URL).
 */
async function loadSessionUser() {
  const a = await authClient();
  if (!a) return null;
  try {
    const { data } = await a.getSession();
    sessionUser = data?.user || null;
  } catch { sessionUser = null; }
  return sessionUser;
}

/**
 * After the store exists: ask the server about accounts, start syncing a signed-in cache, and
 * finish a sign-in that came back from a redirect (OAuth).
 * @param {{store: object, toast?: Function, onChange?: Function}} ctx
 */
export async function startAccount({ store, toast = () => {}, onChange = () => {} }) {
  theStore = store;
  watchAccountSwitch();
  // back from Google: finish the sign-in (sets the session cookie) before asking the server
  const returning = new URLSearchParams(location.search).has(VERIFIER);
  if (returning) await loadSessionUser();
  try {
    const back = sessionStorage.getItem(RETURN_HASH);
    if (back != null) { sessionStorage.removeItem(RETURN_HASH); if (!location.hash && back) history.replaceState(history.state, '', back); }
  } catch {}
  try { info = await getJson('/api/account'); } catch { info = { sync: false }; }
  if (!info.sync) { if (current) setStatus({ state: 'unavailable' }); return info; }
  if (info.signedIn && !returning) await loadSessionUser(); // for the account label
  if (!current) {
    // signed in but this browser has no account cache yet: a fresh sign-in
    // (not twice in a row: if the switch did not stick, e.g. storage is full, stay signed out)
    let recent = false;
    try { recent = Date.now() - Number(sessionStorage.getItem('wonder.beginAccount') || 0) < 15000; } catch {}
    if (sessionUser && info.signedIn && info.userId === sessionUser.id && !recent) await beginAccount(sessionUser.id, { store });
    setStatus({ state: 'signedOut' });
    return info;
  }
  if (!info.signedIn) { setStatus({ state: 'signedOut' }); return info; }
  if (info.userId !== current.userId) { setStatus({ state: 'mismatch', signedInAs: info.userId }); return info; }
  const migrating = ls()?.getItem(MIGRATED_KEY) === current.userId;
  engine = createSyncEngine({
    store,
    storage: cache,
    userId: current.userId,
    post: postSync,
    lock: syncLock(current.userId),
    onStatus: (s) => { setStatus(s); onChange(); },
    onFirstSync: (mode) => {
      if (mode === 'merge' && migrating) {
        try { ls()?.removeItem(STATE_KEY); ls()?.removeItem(MIGRATED_KEY); } catch {}
        toast('This browser’s lessons and progress are now in your account');
      }
    },
  });
  // another tab of this account wrote: store.js merges it like a localStorage event
  cache.onChange?.((key, value) => { if (key === STATE_KEY && value != null) store._onStorage?.({ key, newValue: value }); });
  await engine.syncNow();
  // reminders were turned on (maybe on another device) and this browser already allows
  // notifications: let them arrive here with Wonder closed too
  try {
    if (store.data.settings?.reminder?.enabled && globalThis.Notification?.permission === 'granted' && pushAvailable() && !pushActive()) await enablePush();
  } catch { /* the in-tab reminder still works */ }
  setInterval(() => { if (document.visibilityState === 'visible') engine.syncNow(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') engine.schedule(500); else engine.syncNow(); });
  globalThis.addEventListener?.('online', () => engine.schedule(500));
  return info;
}

/**
 * Switch this browser to `userId`'s account (first sign-in): decide what happens to signed-out
 * data, seed the account cache, and reload into it.
 */
export async function beginAccount(userId, { store } = {}) {
  store?.flush?.();
  const anonRaw = ls()?.getItem(STATE_KEY) || null;
  let anon = null;
  try { anon = anonRaw ? JSON.parse(anonRaw) : null; } catch { anon = null; }
  let mode = 'pull';
  if (anon && hasLearnerData(anon)) {
    const acct = await getJson('/api/account').catch(() => ({}));
    const merge = acct.records > 0
      ? confirm('Your account already has lessons and progress. Add this browser’s lessons, cards and progress to it too?\n\nOK merges them. Cancel uses only your account here (this browser’s data stays put and comes back if you sign out).')
      : true;
    if (merge) mode = 'merge';
  }
  // only the first-run welcome's choices (interests, level, goal, name): they come along too, no
  // question asked. A merge keeps the account's own settings and fills in only what it lacks.
  const settingsOnly = mode === 'pull' && !!anon?.settings?.onboarded;
  if (settingsOnly) mode = 'merge';
  let target;
  try { target = await openIdbStorage(userId); } catch { target = prefixedLocalStorage(userId); }
  target.setItem(STATE_KEY, mode === 'merge' ? anonRaw : JSON.stringify(emptyState()));
  target.setItem(BASE_KEY, JSON.stringify({ userId, since: 0, base: [], first: mode }));
  // a returning account: its first sync now, behind the hand-off note, so the reloaded page opens
  // on its lessons and settings (not an empty start that looks like a new learner)
  if (mode === 'pull') await syncBeforeOpening({ storage: target, userId, post: postSync, lock: syncLock(userId) });
  await target.flushNow();
  try {
    sessionStorage.setItem('wonder.beginAccount', String(Date.now()));
    if (mode === 'merge' && !settingsOnly) ls()?.setItem(MIGRATED_KEY, userId); // (no "lessons are in your account" toast for settings)
    ls()?.setItem(ACCOUNT_KEY, JSON.stringify({ userId }));
  } catch {}
  if (readJson(ACCOUNT_KEY)?.userId !== userId) throw new Error('This browser’s storage is full or blocked, so it cannot switch to your account. Free some space (or export and erase your data) and try again.');
  switching = true;
  location.reload();
}

/**
 * Sign in with Google (Neon Auth). The browser goes to Google and comes back to this page with a
 * session verifier; startAccount() then finishes the sign-in and switches to the account (a new
 * one, the same one whose session had ended, or the mismatch prompt for another one).
 */
export async function signIn() {
  const a = await authClient();
  if (!a) throw new Error('Sign-in is not available right now. Reload and try again.');
  const user = sessionUser || (await loadSessionUser());
  if (user) return current && user.id === current.userId ? location.reload() : current ? switchToSignedIn() : beginAccount(user.id);
  // the callback is this page without its #route (the verifier goes in the query); the route comes back after.
  // From the home page, a link the landing script saved (a signed-out deep link) is kept instead.
  try {
    const here = location.hash && location.hash !== '#/' ? location.hash : '';
    if (here || !sessionStorage.getItem(RETURN_HASH)) sessionStorage.setItem(RETURN_HASH, here);
  } catch {}
  const { error } = await a.signIn.social({ provider: 'google', callbackURL: `${location.origin}${location.pathname}` });
  if (error) throw new Error(error.message || 'Could not start sign-in with Google');
}

/** Changes in this browser's account cache that the server does not have yet. */
function unsynced() {
  if (engine) return engine.pending();
  if (!cache || !theStore) return 0;
  try {
    const p = JSON.parse(cache.getItem(BASE_KEY) || 'null');
    return diffRecords(new Map(p?.base || []), toRecords(theStore.data)).length;
  } catch { return 0; }
}

/** Ask before deleting a cache that holds changes the account does not have. */
function confirmLoss(what) {
  const left = unsynced();
  return !left || confirm(`${left} change${left === 1 ? ' has' : 's have'} not reached your account yet. ${what} anyway and lose ${left === 1 ? 'it' : 'them'}? (Cancel, then “Export my data” below keeps a copy.)`);
}

/** Sync what is left, stop push here, sign out of Neon Auth, then delete this account's cache. */
export async function signOut() {
  if (engine) await engine.syncNow();
  if (!confirmLoss('Sign out')) return false;
  engine?.stop();
  await disablePush().catch(() => {});
  // signed out first: if that fails, keep everything (otherwise the next load signs back in)
  const a = await authClient(5000);
  if (a && (sessionUser || (await loadSessionUser()))) {
    const { error } = await a.signOut();
    if (error) throw new Error(error.message || 'Could not sign out');
  }
  sessionUser = null;
  try { ls()?.removeItem(ACCOUNT_KEY); ls()?.removeItem(MIGRATED_KEY); } catch {}
  await cache?.destroy?.();
  location.reload();
  return true;
}

/** The browser holds another account's cache than the one signed in: drop it, take the new one. */
export async function switchToSignedIn() {
  if (!confirmLoss('Switch accounts')) return;
  try { ls()?.removeItem(ACCOUNT_KEY); } catch {}
  await cache?.destroy?.();
  const u = await loadSessionUser();
  if (u) return beginAccount(u.id);
  location.reload();
}

/** The signed-in person's email (or name), when the session has loaded. */
/** The signed-in user's first name from their Google account (for onboarding), or ''. */
export async function accountFirstName() {
  const user = sessionUser || (await loadSessionUser());
  return String(user?.name || '').trim().split(/\s+/)[0] || '';
}

export function accountLabel() {
  return sessionUser?.email || sessionUser?.name || null;
}

/**
 * This page's account cache was just seeded (beginAccount) and its first sync has not finished
 * (it timed out or failed before the reload), so it does not hold the account's lessons or
 * settings yet: the store looks like a new learner's until startAccount() syncs.
 */
export function accountAwaitsFirstSync() {
  return !!current && !!cache && awaitsFirstSync(cache, current.userId);
}

export const accountInfo = () => info;
export const signedInAccount = () => current;
export const accountSwitching = () => switching;
export const syncEngine = () => engine;
export const currentSyncStatus = () => syncStatus;
export function onSyncStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }

// ---------------------------------------------------------------- Web Push

/** Can this browser get reminders with Wonder closed? (signed in, server has VAPID keys, browser support) */
export function pushAvailable() {
  return !!(info?.push?.publicKey && current && engine && 'serviceWorker' in navigator && 'PushManager' in globalThis);
}

export const pushActive = () => !!ls()?.getItem(PUSH_KEY);

function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Subscribe this browser (after the learner allowed notifications). */
export async function enablePush() {
  if (!pushAvailable()) return false;
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.push.publicKey) });
  await postJson('/api/push/subscribe', { subscription: sub.toJSON(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  ls()?.setItem(PUSH_KEY, sub.endpoint);
  return true;
}

export async function disablePush() {
  const endpoint = ls()?.getItem(PUSH_KEY);
  ls()?.removeItem(PUSH_KEY);
  const reg = await navigator.serviceWorker?.getRegistration?.('/sw.js');
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) await sub.unsubscribe().catch(() => {});
  if (endpoint && current) await postJson('/api/push/subscribe', { endpoint }, 'DELETE').catch(() => {});
}
