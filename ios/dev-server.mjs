// The Wonder API for the iOS app without a Next.js build: genui-lab/wonder's core behind its
// standalone node:http server (the one the test suite drives). `npm run dev` in genui-lab/wonder
// serves the same API on port 8750 together with the web app; use either.
//
//   node ios/dev-server.mjs [port]        (default 8750; WONDER_MODE=demo for pre-written lessons)
//
// Claude credentials come from the environment or ~/.config/wonder/.env, as for the web app.
import { loadUserEnv } from '../genui-lab/wonder/server/web.js';
import { createWonderServer } from '../genui-lab/wonder/server/app.js';

loadUserEnv();
const port = Number(process.argv[2] || process.env.PORT || 8750);
const server = createWonderServer();
server.listen(port, () => {
  console.log(`Wonder API for iOS on http://localhost:${port} (${server.wonder.mode === 'claude' ? 'Claude mode' : 'demo mode'})`);
});
