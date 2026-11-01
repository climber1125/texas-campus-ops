// Campus Ops service worker: lock-screen alerts only (no offline caching — the app is live data).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Campus Ops', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Campus Ops';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // wake any open Campus Ops page so it fetches the message right now
    for (const c of list) c.postMessage({ type: 'campus-msg' });
    const visible = list.some(c => c.visibilityState === 'visible' && c.focused);
    await self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || 'msg', renotify: true, requireInteraction: !!d.urgent,
    icon: '/icon-192.png', badge: '/icon-192.png', vibrate: d.urgent ? [300, 120, 300, 120, 300] : [150, 80, 150],
      data: { url: d.url || '/' }, silent: visible && !d.urgent,
    });
    // the app is already on screen: don't leave a duplicate banner behind
    if (visible && !d.urgent) { const ns = await self.registration.getNotifications({ tag: d.tag || 'msg' }); setTimeout(() => ns.forEach(n => n.close()), 2500); }
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
