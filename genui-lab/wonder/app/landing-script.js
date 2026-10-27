// The pre-paint script (app/layout.js) that opens the app on the landing page (public/welcome,
// served at /welcome) instead.
// - Account sync on (Neon Auth and a database: everything in Wonder needs a signed-in user): any
//   browser without an account (wonder.account, set at the first sign-in, keeps its cache and
//   "Sign in again" in the app), whatever the hash. Neon Auth's cookies are HttpOnly, so this
//   script cannot read them; the account marker is what a pre-paint script can see. A deep link
//   (#/lesson/…, #/library) is kept in wonder.signInReturn, the key public/account.js signIn()
//   restores, so the visitor lands back on it after signing in. Never redirected: a page coming
//   back from Google with a session verifier (?neon_auth_session_verifier=…: public/account.js
//   finishes that sign-in), and the hashes that lead into sign-in (#/start…, #/signin,
//   #/learn/…: public/app.js sends them to Google).
// - Otherwise: a first-time visitor to the home page, once (the landing page marks
//   wonder.welcomed): no Wonder data in this browser (wonder.v1, wonder.account). Deep links never
//   redirect.

const BACK_FROM_SIGN_IN = "/[?&]neon_auth_session_verifier=/.test(location.search)";
const INTO_SIGN_IN = "/^#\\/(start(\\/|$)|signin$|learn\\/)/.test(h)";

/** @param {{accounts: boolean}} opts  accounts: account sync is on (server/sync syncConfig) */
export function landingScript({ accounts }) {
  if (accounts) {
    return 'try{var s=localStorage,h=location.hash;'
      + `if(location.pathname==='/'&&!s.getItem('wonder.account')&&!${BACK_FROM_SIGN_IN}&&!${INTO_SIGN_IN}){`
      + "if(h&&h!=='#/')try{sessionStorage.setItem('wonder.signInReturn',h)}catch(e){}"
      + "location.replace('/welcome')}}catch(e){}";
  }
  const when = `!s.getItem('wonder.welcomed')&&!s.getItem('wonder.v1')&&!s.getItem('wonder.account')`;
  return `try{var s=localStorage,h=location.hash;if(location.pathname==='/'&&(!h||h==='#/')&&${when})location.replace('/welcome')}catch(e){}`;
}
