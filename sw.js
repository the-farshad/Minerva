/* Minerva — service worker.
 *
 * Cache-first for the static shell so the app loads and runs without
 * network. API calls (accounts.google.com, sheets.googleapis.com,
 * www.googleapis.com, api.telegram.org, fonts.*, jsdelivr) pass through
 * untouched — Minerva's local IndexedDB is the offline data source.
 *
 * Bump CACHE_VERSION on any shipped change to force re-cache.
 */

'use strict';

var CACHE_VERSION = 'minerva-v7';
var SHELL = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './assets/styles.css',
  './assets/qr.js',
  './assets/share.js',
  './assets/auth.js',
  './assets/sheets.js',
  './assets/db.js',
  './assets/bootstrap.js',
  './assets/sync.js',
  './assets/render.js',
  './assets/editors.js',
  './assets/telegram.js',
  './assets/ical.js',
  './assets/presets.js',
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
  // auth/Cors implications we don't want to second-guess.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      var fetcher = fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          var cloned = resp.clone();
          caches.open(CACHE_VERSION).then(function (c) {
            try { c.put(req, cloned); } catch (e) { /* ignore */ }
          });
        }
        return resp;
      }).catch(function () { return cached; });

      // stale-while-revalidate: hand back the cache if we have it; let
      // the fetch update the cache in the background for next load.
      return cached || fetcher;
    })
  );
});
