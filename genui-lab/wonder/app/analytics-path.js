// The path a Vercel Web Analytics page view reports. The app routes with the URL hash
// (#/lesson/<id>, #/start/<topic>), which the stock <Analytics/> never sees, so each screen is
// reported as its own path: /lesson, /review, /you… Ids, topics and query strings stay out, so a
// view never says which lesson or what someone asked to learn.

const SCREENS = { lesson: '/lesson', course: '/course', review: '/review', teacher: '/teacher', library: '/library',
  you: '/you', memory: '/you', mastery: '/you', interests: '/you', start: '/start', learn: '/start', signin: '/signin' };

/** '/lesson' for ('/', '#/lesson/abc'); other pages (/privacy) report their own pathname. */
export function analyticsPath(pathname, hash) {
  if (pathname !== '/') return pathname;
  const screen = String(hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
  return SCREENS[screen] || '/';
}
