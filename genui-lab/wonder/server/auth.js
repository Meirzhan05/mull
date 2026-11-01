// Who is signing this request (account sync)? Neon Auth (managed Better Auth), when
// NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET are set. Users and sessions live in the Neon
// database's auth schema; the browser signs in through /api/auth/* (app/api/auth/[...path]),
// which proxies to Neon Auth and sets the session cookies on this origin. Without the variables
// there are no accounts and every request is anonymous, as before.
//
// Neon Auth checks the Origin of every signed-in write (sign-out, delete-user) and refuses this
// app's own domains there with 403 "Invalid origin", although the same domains are trusted and
// pass its callbackURL check; it accepts only localhost and its own origin (seen October 2026,
// @neondatabase/auth 0.7.0-beta). That check stops other sites from using a visitor's session, so
// this server does it instead: a signed-in write from this origin goes to Neon Auth with Neon
// Auth's own origin (originForNeon), and one from anywhere else keeps its Origin and is refused.

let instance; // undefined: not made yet; null: accounts off

/** The origin a Referer names, or ''. */
function refererOrigin(referer) {
  try { return referer ? new URL(referer).origin : ''; } catch { return ''; }
}

/**
 * The Origin to send Neon Auth for a request with these headers (`get(name)`): Neon Auth's own
 * origin when the request comes from this server's host, else its Origin (or Referer's origin), or
 * '' when it has neither.
 */
export function originForNeon(get, baseUrl) {
  const origin = get('origin') || refererOrigin(get('referer'));
  const host = (get('x-forwarded-host') || get('host') || '').split(',')[0].trim();
  try {
    if (origin && host && new URL(origin).host === host) return new URL(baseUrl).origin;
  } catch {}
  return origin;
}

/**
 * `request` as the /api/auth proxy should pass it on: a signed-in write (one with a Neon Auth
 * session cookie) carries originForNeon. Reads, and requests without a session, go as they are.
 */
export async function requestForNeon(request, baseUrl) {
  if (request.method === 'GET' || request.method === 'HEAD') return request;
  if (!/(^|;\s*)__Secure-neon-auth/.test(request.headers.get('cookie') || '')) return request;
  const origin = originForNeon((n) => request.headers.get(n), baseUrl);
  if (!origin || origin === request.headers.get('origin')) return request;
  const headers = new Headers(request.headers);
  headers.set('origin', origin);
  return new Request(request.url, { method: request.method, headers, body: await request.text() });
}

/** The request context createNeonAuth uses (next/headers), with originForNeon as its origin. */
async function nextContext(baseUrl) {
  const [{ cookies, headers }, { extractNeonAuthCookies }] = await Promise.all([import('next/headers'), import('@neondatabase/auth/server')]);
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return {
    getCookies: () => extractNeonAuthCookies(headerStore),
    setCookie: (name, value, options) => cookieStore.set(name, value, options),
    getHeader: (name) => headerStore.get(name) ?? null,
    getOrigin: () => originForNeon((n) => headerStore.get(n), baseUrl),
    getFramework: () => 'nextjs',
  };
}

/**
 * The Neon Auth server (getSession, deleteUser…, plus handler() for /api/auth), or null when Neon
 * Auth is not configured. It is createNeonAuth's, with this file's origin in place of the browser's.
 */
export async function neonAuth(env = process.env) {
  if (instance !== undefined) return instance;
  const { NEON_AUTH_BASE_URL: baseUrl, NEON_AUTH_COOKIE_SECRET: secret } = env;
  if (!baseUrl || !secret) return (instance = null);
  const [{ createNeonAuth }, { createAuthServer }] = await Promise.all([import('@neondatabase/auth/next/server'), import('@neondatabase/auth/server')]);
  const handlers = createNeonAuth({ baseUrl, cookies: { secret } }).handler();
  const proxied = Object.fromEntries(Object.entries(handlers).map(([method, h]) => [method, async (request, ctx) => h(await requestForNeon(request, baseUrl), ctx)]));
  instance = createAuthServer({ baseUrl, cookieSecret: secret, context: () => nextContext(baseUrl) });
  instance.handler = () => proxied;
  return instance;
}

/**
 * Delete the signed-in Neon Auth user (and with it every session). False when there is none or
 * Neon Auth refuses: delete-user turned off, or a session older than its fresh age.
 */
export async function deleteRequestUser(env = process.env) {
  try {
    const auth = await neonAuth(env);
    if (!auth) return false;
    const { error } = await auth.deleteUser({});
    if (error) console.warn(`[wonder] Neon Auth did not delete the user: ${error.message || error.status}`);
    return !error;
  } catch (e) {
    console.warn(`[wonder] could not delete the user: ${e.message}`);
    return false;
  }
}

/** The signed-in user's id, or null. Never throws: an auth failure is a signed-out request. */
export async function requestUserId(env = process.env) {
  try {
    const auth = await neonAuth(env);
    if (!auth) return null;
    const { data } = await auth.getSession();
    return data?.user?.id || null;
  } catch (e) {
    console.warn(`[wonder] could not read the session: ${e.message}`);
    return null;
  }
}
