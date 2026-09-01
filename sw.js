// Minimal offline cache — lets the app shell open even with a weak/no signal.
// (Camera scanning itself never needed the network; this just covers the app's own files.)
//
// IMPORTANT: bump the number in CACHE every time app.js/index.html/styles.css
// change. A service worker only re-installs (and refreshes its cached files)
// when this SCRIPT FILE changes byte-for-byte — if CACHE never changes, a
// phone can keep serving the very first cached build indefinitely, no matter
// how many times the other files are re-uploaded. Confirmed 2026-08-27 as the
// real cause behind several "still looks old after uploading" reports.
var CACHE = 'label-scanner-v3-cache-4';
// The OCR engine files under ocr/ (~5.8MB) are deliberately NOT in this precache
// list — they're fetched lazily the first time OCR mode is actually used, via
// the normal fetch handler below, which caches them for offline reuse after
// that. Precaching them here would slow down every single app open.
var ASSETS = ['./', './index.html', './styles.css', './app.js', './jsQR.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        return resp;
      }).catch(function () { return cached; });
    })
  );
});
