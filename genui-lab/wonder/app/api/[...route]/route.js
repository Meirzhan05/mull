// Every /api/* endpoint (lesson / tutor / Teacher NDJSON streams, steering, course plans, widget
// actions, practice cards, learner memory, account sync) goes to the Wonder core (server/app.js)
// through the Fetch-API adapter. One core per process: a steer request must reach the lesson
// stream that is still running, and memory / Teacher cards live in it. With accounts configured,
// the signed-in user's id travels with the request (server/auth.js).
import { handleWebRequest, getWonderCore } from '../../../server/web.js';
import { requestUserId, deleteRequestUser } from '../../../server/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = async (request) => handleWebRequest(getWonderCore(), request, { userId: await requestUserId(), deleteAuthUser: deleteRequestUser });
export { handler as GET, handler as POST, handler as DELETE };
