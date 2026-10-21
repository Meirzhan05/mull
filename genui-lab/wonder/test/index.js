// `node --test test/index.js`: Node 25 resolves a directory argument to its index module, so
// this entry imports every *.test.js file into the run (same pattern as chatgpt-dil).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
