// Wonder on Next.js. The app imports two sibling folders of the lab (../chatgpt-dil and
// ../wondering-genui: the DIL compiler/runtime and Wondering's validators + FSRS), so the
// bundler and output tracing are rooted one level up, at genui-lab/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const labRoot = path.resolve(here, '..');

// ~/.config/wonder/.env (or $WONDER_ENV_FILE) is loaded here, at startup, not only on the first
// API request (server/web.js loadUserEnv): the Neon Auth settings must be in process.env before
// app/api/auth/[...path] decides whether accounts are on, and NEXT_PUBLIC_* values are inlined
// into the browser bundle when it compiles. Variables already set (shell, .env, .env.local) win.
const userEnv = process.env.WONDER_ENV_FILE || path.join(os.homedir(), '.config', 'wonder', '.env');
if (fs.existsSync(userEnv)) {
  try { process.loadEnvFile(userEnv); } catch (e) { console.warn(`Could not load ${userEnv}: ${e.message}`); }
}

// Security headers on every response. The Content-Security-Policy lists where the app loads from:
// - scripts: this origin. 'unsafe-inline' for Next's hydration scripts and the two in app/layout.js;
//   'unsafe-eval' because the DIL runtime compiles each lesson program with Function() in its Web
//   Worker, and a worker may run under this page's policy (dev's hot reload also needs it).
// - images: Figures come only from Wikimedia (public/figure-hosts.js); videos are youtube-nocookie
//   frames (chatgpt-dil/src/host.js); /welcome uses Google Fonts.
// - connect: this origin only, so nothing a lesson renders can send data elsewhere.
const dev = process.env.NODE_ENV !== 'production';
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://upload.wikimedia.org https://thumb.wikimedia.org",
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
  'frame-src https://www.youtube-nocookie.com',
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(dev ? [] : ['upgrade-insecure-requests']),
].join('; ');
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, // the YouTube player needs a referrer
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  ...(dev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000' }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  reactStrictMode: true,
  turbopack: { root: labRoot },
  outputFileTracingRoot: labRoot,
  // The module mounts read files at request time (server/app.js STATIC_ROOTS), which tracing can't
  // see, so a deployment (Vercel) would ship none of them and the client fails to start. Name them.
  // server/paths.js comes along everywhere because it finds the app root by itself.
  outputFileTracingIncludes: {
    // keys are globs: "[...path]" would be a character class, so match the catch-all with "*"
    '/chatgpt-dil/src/*': ['../chatgpt-dil/src/**/*', './server/paths.js'],
    '/wondering-genui/src/*': ['../wondering-genui/src/**/*', './server/paths.js'],
    '/vendor/katex/*': ['./node_modules/katex/dist/**/*', './server/paths.js'],
    '/api/*': ['./server/paths.js'],
  },
  // the Anthropic SDK, pg, web-push and unpdf (a PDF's text layer, server/materials.js) stay plain
  // Node dependencies of the route handlers
  serverExternalPackages: ['@anthropic-ai/sdk', 'pg', 'web-push', 'unpdf'],
  poweredByHeader: false,
  devIndicators: false, // the badge sits on the mobile tab bar; build errors still show the overlay
  // the landing page (public/welcome) at /welcome; first-time visitors land there (app/layout.js)
  async rewrites() {
    return [{ source: '/welcome', destination: '/welcome/index.html' }];
  },
};

export default nextConfig;
