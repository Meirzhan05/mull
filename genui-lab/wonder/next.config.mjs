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

/** @type {import('next').NextConfig} */
const nextConfig = {
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
