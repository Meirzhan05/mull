// Where Wonder lives on disk. Under `node server/...` this is the parent of this file; inside a
// Next.js bundle `import.meta.url` points at a build chunk, so fall back to WONDER_ROOT or the
// working directory (`next dev` / `next start` run from the app folder). A candidate counts only
// if it really is the app (it has server/paths.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot() {
  const candidates = [];
  if (process.env.WONDER_ROOT) candidates.push(path.resolve(process.env.WONDER_ROOT));
  try { candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')); } catch { /* not a file: URL */ }
  // a deployment traced from genui-lab/ (outputFileTracingRoot) runs from the bundle root, with the
  // app under wonder/
  candidates.push(process.cwd(), path.join(process.cwd(), 'wonder'), path.join(process.cwd(), 'genui-lab', 'wonder'));
  return candidates.find((d) => fs.existsSync(path.join(d, 'server', 'paths.js'))) || process.cwd();
}

export const WONDER_ROOT = findRoot();
export const LAB_ROOT = path.resolve(WONDER_ROOT, '..');
