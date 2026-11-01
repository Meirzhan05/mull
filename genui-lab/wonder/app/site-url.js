// The site's public origin, for the few URLs that must be absolute: link previews (og:image,
// og:url). On Vercel it is the production domain (VERCEL_PROJECT_PRODUCTION_URL: the shortest
// custom domain, else the vercel.app one), on every deployment, so a shared preview link still
// shows the production card. Elsewhere it is the local server.
export const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'http://localhost:8750';
