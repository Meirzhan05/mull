import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => fs.readFileSync(path.join(here, '..', 'fixtures', name), 'utf8');
export const finalDil = () => JSON.parse(fixture('final-dil.json'));
export const finalMarkdown = () => fixture('final-markdown.md');
export const streamText = () => fixture('stream.redacted.ndjson');
