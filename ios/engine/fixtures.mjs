// Fixtures for the iOS unit tests (ios/WonderTests), made from the web app's own recorded
// Claude output so both platforms are tested on the same programs:
//   vaccines.dil.json        a real Claude lesson compiled by server/compile.js
//   teacher-statistics.ndjson a recorded Claude Teacher turn (tool cards)
//
//   node ios/engine/fixtures.mjs           write them
//   node ios/engine/fixtures.mjs --check   exit 1 when out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const W = path.join(repo, 'genui-lab/wonder');
const out = path.join(repo, 'ios/WonderTests/Fixtures');

export async function fixtures() {
  const { compileWonder, toWonderDil } = await import(path.join(W, 'server/compile.js'));
  const dil = toWonderDil(compileWonder(fs.readFileSync(path.join(W, 'test/fixtures/claude-lesson-vaccines.md'), 'utf8')));
  return {
    'vaccines.dil.json': JSON.stringify({ code: dil.code, constants: dil.constants, appData: dil.appData }) + '\n',
    'teacher-statistics.ndjson': fs.readFileSync(path.join(W, 'test/fixtures/claude-teacher-statistics.ndjson'), 'utf8'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(await fixtures())) {
    const file = path.join(out, name);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old === text) continue;
    if (check) { console.error(`${name} is out of date: run node ios/engine/fixtures.mjs`); stale++; }
    else { fs.writeFileSync(file, text); console.log(`wrote ${path.relative(repo, file)}`); }
  }
  process.exit(stale ? 1 : 0);
}
