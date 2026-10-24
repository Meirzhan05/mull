// Neon Auth's endpoints on this origin (sign-in with Google, the OAuth session exchange,
// get-session, sign-out). auth.handler() proxies them to NEON_AUTH_BASE_URL and sets the session
// cookies here. More specific than app/api/[...route], so Next routes /api/auth/* to this file.
import { neonAuth } from '../../../../server/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const auth = await neonAuth();
const handlers = auth ? auth.handler() : null;
const off = () => Response.json({ ok: false, error: 'Accounts are not configured on this server' }, { status: 404 });

export const GET = handlers?.GET ?? off;
export const POST = handlers?.POST ?? off;
export const PUT = handlers?.PUT ?? off;
export const DELETE = handlers?.DELETE ?? off;
export const PATCH = handlers?.PATCH ?? off;
