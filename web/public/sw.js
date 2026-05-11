// Service-worker kill-switch.
//
// v1 of Minerva (the static SPA) shipped a sw.js that aggressively
// cached pages. v2 replaced that app at the same origin, but the SW
// stays installed in the user's browser until something at /sw.js
// tells it otherwise. This file is that something: it unregisters
// itself, wipes every cache it created, and force-reloads every
// client so they pick up the live v2 build.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_e) { /* ignore */ }
    try {
      await self.registration.unregister();
    } catch (_e) { /* ignore */ }
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) {
      try { c.navigate(c.url); } catch (_e) { /* ignore */ }
    }
  })());
});
// Pass every request straight through — no caching, no rewriting.
self.addEventListener('fetch', () => {});
