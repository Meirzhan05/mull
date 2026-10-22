// Read-only module mount: KaTeX (math typesetting), served from outside public/ so the browser can import it by URL.
import { staticResponse } from '../../../../server/web.js';

export const runtime = 'nodejs';

export function GET(request) {
  return staticResponse(new URL(request.url).pathname);
}

export function HEAD(request) {
  return staticResponse(new URL(request.url).pathname, { head: true });
}
