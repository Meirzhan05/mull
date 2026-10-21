// Entry point: `npm start` (node --env-file-if-exists=.env server/index.js).
// Credentials are resolved by the Anthropic SDK; nothing here reads or logs key values.

import { createWonderServer } from './app.js';

const port = Number(process.env.PORT) || 8750;
const server = createWonderServer();
server.listen(port, () => {
  const { mode } = server.wonder;
  console.log(`Wonder running at http://localhost:${port} (${mode === 'claude' ? 'Claude mode' : 'demo mode: set ANTHROPIC_API_KEY in .env to use Claude'})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); server.closeAllConnections?.(); process.exit(0); });
