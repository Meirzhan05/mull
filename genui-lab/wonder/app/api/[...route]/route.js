// Every /api/* endpoint (lesson / tutor / Teacher NDJSON streams, steering, course plans, widget
// actions, practice cards, learner memory) goes to the Wonder core (server/app.js) through the
// Fetch-API adapter. One core per process: a steer request must reach the lesson stream that
// is still running, and memory / Teacher cards live in it.
import { handleWebRequest, getWonderCore } from '../../../server/web.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = (request) => handleWebRequest(getWonderCore(), request);
export { handler as GET, handler as POST, handler as DELETE };
