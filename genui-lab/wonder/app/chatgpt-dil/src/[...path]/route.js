// Read-only module mount: DIL runtime (host, worker runtime, stream parser, CSS), served from outside public/ so the browser can import it by URL.
import { staticResponse } from '../../../../server/web.js';

export const runtime = 'nodejs';

export function GET(request) {
  return staticResponse(new URL(request.url).pathname);
}

export function HEAD(request) {
  return staticResponse(new URL(request.url).pathname, { head: true });
}
