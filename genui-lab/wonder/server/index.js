// Entry point: `npm start` (node --env-file-if-exists=.env server/index.js).
// Credentials are resolved by the Anthropic SDK; nothing here reads or logs key values.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fallback env file outside the repo, so the key never sits next to committed code:
// ~/.config/wonder/.env (or $WONDER_ENV_FILE). A project-local .env still takes priority.
const userEnvFile = process.env.WONDER_ENV_FILE || path.join(os.homedir(), '.config', 'wonder', '.env');
if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(userEnvFile)) {
  try {
    process.loadEnvFile(userEnvFile);
    if (process.env.ANTHROPIC_API_KEY === 'YOUR_KEY') delete process.env.ANTHROPIC_API_KEY; // unedited placeholder
  } catch (e) {
    console.warn(`Could not load ${userEnvFile}: ${e.message}`);
  }
}

const { createWonderServer } = await import('./app.js');

const port = Number(process.env.PORT) || 8750;
const server = createWonderServer();
server.listen(port, () => {
  const { mode } = server.wonder;
  console.log(`Wonder running at http://localhost:${port} (${mode === 'claude' ? 'Claude mode' : 'demo mode: set ANTHROPIC_API_KEY in .env to use Claude'})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); server.closeAllConnections?.(); process.exit(0); });
