// Wonder on Next.js. The app imports two sibling folders of the lab (../chatgpt-dil and
// ../wondering-genui: the DIL compiler/runtime and Wondering's validators + FSRS), so the
// bundler and output tracing are rooted one level up, at genui-lab/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const labRoot = path.resolve(here, '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: { root: labRoot },
  outputFileTracingRoot: labRoot,
  // the Anthropic SDK, pg and web-push stay plain Node dependencies of the route handlers
  serverExternalPackages: ['@anthropic-ai/sdk', 'pg', 'web-push'],
  poweredByHeader: false,
  devIndicators: false, // the badge sits on the mobile tab bar; build errors still show the overlay
};

export default nextConfig;
