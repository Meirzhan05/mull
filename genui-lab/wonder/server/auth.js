// Who is signing this request (account sync)? Neon Auth (managed Better Auth), when
// NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET are set. Users and sessions live in the Neon
// database's auth schema; the browser signs in through /api/auth/* (app/api/auth/[...path]),
// which proxies to Neon Auth and sets the session cookies on this origin. Without the variables
// there are no accounts and every request is anonymous, as before.

let instance; // undefined: not made yet; null: accounts off

/** The `createNeonAuth` instance, or null when Neon Auth is not configured. */
export async function neonAuth(env = process.env) {
  if (instance !== undefined) return instance;
  if (!env.NEON_AUTH_BASE_URL || !env.NEON_AUTH_COOKIE_SECRET) return (instance = null);
  const { createNeonAuth } = await import('@neondatabase/auth/next/server');
  instance = createNeonAuth({ baseUrl: env.NEON_AUTH_BASE_URL, cookies: { secret: env.NEON_AUTH_COOKIE_SECRET } });
  return instance;
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
