// The pre-paint script (app/layout.js) that opens the home page on the landing page
// (public/welcome, served at /welcome) instead. Deep links (#/lesson/…, #/learn/…) never redirect.
// - Account sync on (Clerk and a database: lessons need a signed-in user, server/usage.js): anyone
//   signed out of Clerk (__client_uat missing or 0). Not a browser whose account session merely
//   ended (wonder.account: its cache and "Sign in again" stay in the app), nor a page Clerk is
//   bringing back from a sign-in (__clerk_* in the query).
// - Otherwise: a first-time visitor, once (the landing page marks wonder.welcomed): no Wonder data
//   in this browser (wonder.v1, wonder.account) and not signed in to Clerk.

const SIGNED_OUT = "!/(^|; )__client_uat=[1-9]/.test(document.cookie)";

/** @param {{accounts: boolean}} opts  accounts: account sync is on (server/sync syncConfig) */
export function landingScript({ accounts }) {
  const when = accounts
    ? `${SIGNED_OUT}&&!s.getItem('wonder.account')&&!/[?&]__clerk/.test(location.search)`
    : `${SIGNED_OUT}&&!s.getItem('wonder.welcomed')&&!s.getItem('wonder.v1')&&!s.getItem('wonder.account')`;
  return `try{var s=localStorage,h=location.hash;if(location.pathname==='/'&&(!h||h==='#/')&&${when})location.replace('/welcome')}catch(e){}`;
}
