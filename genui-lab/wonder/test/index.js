// `node --test test/index.js`: Node 25 resolves a directory argument to its index module, so
// this entry imports every *.test.js file into the run (same pattern as chatgpt-dil).
// <Figure/> and <Video/> lookups never touch the network in tests (tests that need one inject
// figureLookup / videoLookup),
process.env.WONDER_FIGURES ??= 'off';
process.env.WONDER_VIDEOS ??= 'off';
// ...and the figure vision check is off (tests that need it pass figureCheck)
process.env.WONDER_FIGURE_CHECK ??= 'off';
// ...and no per-request token usage lines in the test output
process.env.WONDER_LOG_USAGE ??= 'off';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
