// Wonder's service worker: only Web Push reminders (no fetch handler, no offline cache). The
// server's reminder cron (server/push.js) sends {title, body, tag, url}; a click focuses an open
// Wonder tab or opens one. The tag matches the in-tab reminder's, so one replaces the other.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Mull', {
    body: d.body || 'Time for today’s learning.',
    tag: d.tag || 'wonder-daily',
    data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/#/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#/', self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) { await tab.focus(); return tab.navigate?.(url).catch(() => {}); }
    return self.clients.openWindow(url);
  })());
});
