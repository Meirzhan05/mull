// The pre-paint script (app/layout.js) that opens the home page on the landing page
// (public/welcome, served at /welcome) instead. Deep links (#/lesson/…, #/learn/…) never redirect.
// - Account sync on (Neon Auth and a database: lessons need a signed-in user, server/usage.js):
//   any browser without an account (wonder.account, set at the first sign-in, keeps its cache and
//   "Sign in again" in the app). Neon Auth's cookies are HttpOnly, so this script cannot read
//   them; the account marker is what a pre-paint script can see. Never a page coming back from
//   Google with a session verifier (?neon_auth_session_verifier=…): public/account.js finishes
//   that sign-in.
// - Otherwise: a first-time visitor, once (the landing page marks wonder.welcomed): no Wonder data
//   in this browser (wonder.v1, wonder.account).

const BACK_FROM_SIGN_IN = "/[?&]neon_auth_session_verifier=/.test(location.search)";

/** @param {{accounts: boolean}} opts  accounts: account sync is on (server/sync syncConfig) */
export function landingScript({ accounts }) {
  const when = accounts
    ? `!s.getItem('wonder.account')&&!${BACK_FROM_SIGN_IN}`
    : `!s.getItem('wonder.welcomed')&&!s.getItem('wonder.v1')&&!s.getItem('wonder.account')`;
  return `try{var s=localStorage,h=location.hash;if(location.pathname==='/'&&(!h||h==='#/')&&${when})location.replace('/welcome')}catch(e){}`;
}
