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
// API request (server/web.js loadUserEnv): the Clerk keys must be in process.env before proxy.js
// and app/layout.js decide whether accounts are on, and NEXT_PUBLIC_* values are inlined into
// the browser bundle when it compiles. Variables already set (shell, .env, .env.local) win.
const userEnv = process.env.WONDER_ENV_FILE || path.join(os.homedir(), '.config', 'wonder', '.env');
if (fs.existsSync(userEnv)) {
  try { process.loadEnvFile(userEnv); } catch (e) { console.warn(`Could not load ${userEnv}: ${e.message}`); }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: { root: labRoot },
  outputFileTracingRoot: labRoot,
  // the Anthropic SDK, pg and web-push stay plain Node dependencies of the route handlers
  serverExternalPackages: ['@anthropic-ai/sdk', 'pg', 'web-push'],
  poweredByHeader: false,
  devIndicators: false, // the badge sits on the mobile tab bar; build errors still show the overlay
  // the landing page (public/welcome) at /welcome; first-time visitors land there (app/layout.js)
  async rewrites() {
    return [{ source: '/welcome', destination: '/welcome/index.html' }];
  },
};

export default nextConfig;
