// Who is signing this request (account sync)? Clerk, when CLERK_SECRET_KEY is set: proxy.js runs
// clerkMiddleware on every /api request and auth() reads its session. Without Clerk there are no
// accounts and every request is anonymous, as before.

/** The signed-in user's id, or null. Never throws: an auth failure is a signed-out request. */
export async function requestUserId(env = process.env) {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    return userId || null;
  } catch (e) {
    console.warn(`[wonder] could not read the session: ${e.message}`);
    return null;
  }
}
