'use client';
// Vercel Web Analytics (cookieless page views; turn it on under the project's Analytics tab).
// The script comes from this origin (/_vercel/insights), so the CSP's connect-src 'self' holds.
// One view per screen: on load and on every hash change, with the path from analyticsPath.
import { useEffect } from 'react';
import { inject, pageview } from '@vercel/analytics';
import { analyticsPath } from './analytics-path';

let last = null; // the page last counted, kept across remounts (dev's strict mode runs effects twice)

export function Analytics() {
  useEffect(() => {
    // the view's URL would still carry the hash (#/lesson/<id>) and any query: send the path alone
    inject({ framework: 'next', disableAutoTrack: true, beforeSend: (e) => ({ ...e, url: e.url.split(/[?#]/)[0] }) });
    const send = () => {
      const at = location.pathname + location.hash;
      if (at === last) return;
      last = at;
      const path = analyticsPath(location.pathname, location.hash);
      pageview({ route: path, path });
    };
    send();
    window.addEventListener('hashchange', send);
    return () => window.removeEventListener('hashchange', send);
  }, []);
  return null;
}
