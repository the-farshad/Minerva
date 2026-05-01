/* Minerva — service worker.
 *
 * Strategy: **network-first for the app shell** (HTML / JS / CSS), with
 * the cache as an offline fallback. We used to do stale-while-revalidate
 * here, but that meant every deploy needed *two* page reloads before the
 * user actually saw the new code: the first reload served the cached old
 * version while the SW silently fetched the new one, and only the second
 * reload picked it up. That's a footgun — the wrong default for a
 * frequently-updated app — so we prefer fresh code when online and only
 * fall back to cache when the network is unreachable.
 *
 * API calls (accounts.google.com, sheets.googleapis.com, www.googleapis.com,
 * api.telegram.org, fonts.*, jsdelivr) pass straight through — the SW
 * never touches cross-origin requests.
 *
 * Bump CACHE_VERSION on any shipped change to invalidate stale caches
 * left over from previous SW generations.
 */

'use strict';

var CACHE_VERSION = 'minerva-v42';
var SHELL = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './rss.html',
  './opensearch.xml',
  './assets/styles.css',
  './assets/qr.js',
  './assets/share.js',
  './assets/auth.js',
  './assets/sheets.js',
  './assets/db.js',
  './assets/bootstrap.js',
  './assets/sync.js',
  './assets/vendor/lucide.min.js',
  './assets/vendor/d3-force.min.js',
  './assets/draw.js',
  './assets/graph.js',
  './assets/render.js',
  './assets/charts.js',
  './assets/preview.js',
  './assets/editors.js',
  './assets/telegram.js',
  './assets/ical.js',
  './assets/presets.js',
  './assets/ai.js',
  './assets/import.js',
  './assets/schedule.js',
  './assets/meet.js',
  './assets/pomodoro.js',
  './assets/app.js',
  './docs/assets/minerva-logo.png',
  './manifest.webmanifest'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // addAll fails the whole install if any URL 404s; do them one-by-one
      // so a missing optional asset doesn't kill the whole shell.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* skip */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // Only same-origin requests are served from cache. Everything else
  // (Google auth, Sheets/Drive APIs, Telegram, fonts, CDN libs) goes
  // straight to the network — those responses change too often or have
  // auth/CORS implications we don't want to second-guess.
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.ok) {
        var cloned = resp.clone();
        caches.open(CACHE_VERSION).then(function (c) {
          try { c.put(req, cloned); } catch (e) { /* ignore */ }
        });
      }
      return resp;
    }).catch(function () {
      // Offline (or server unreachable). Fall back to whatever we cached
      // last time the asset was reachable.
      return caches.match(req);
    })
  );
});
