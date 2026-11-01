// The landing and pricing pages (public/welcome, public/pricing) are plain HTML. Next serves
// each at its path (app/welcome/route.js, app/pricing/route.js) through this handler, which
// makes the link-preview URLs absolute: crawlers (X, LinkedIn, Facebook) ignore a relative
// og:image. The page is rendered once, at build (force-static), so it is still a static file on
// the CDN. server/app.js serves the same files as they are, for the local Node server.
import fs from 'node:fs';
import path from 'node:path';
import { WONDER_ROOT } from '../server/paths.js';
import { SITE_URL } from './site-url.js';

const ABSOLUTE = /(<meta (?:property|name)="(?:og:image|og:url|twitter:image)" content=")\//g;

/** @param {string} name  the folder under public/ that holds the page's index.html */
export function staticPage(name) {
  return function GET() {
    const html = fs.readFileSync(path.join(WONDER_ROOT, 'public', name, 'index.html'), 'utf8');
    return new Response(html.replace(ABSOLUTE, `$1${SITE_URL}/`), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
}
