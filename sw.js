const CACHE_NAME = 'tesla-dashcam-stamp-v2';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  './icon.png',
  './public/css/style.css',
  './public/mp4-muxer.min.js',
  './public/protobuf.min.js',
  './public/js/mp4-parser.js',
  './public/js/i18n.js',
  './public/js/telemetry-renderer.js',
  './public/js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching assets...');
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => {
          return cache.add(url).catch(err => console.warn(`Failed to cache ${url}:`, err));
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('Clearing old cache:', name);
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request, { cache: 'no-cache' }).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          
          const responseToCache = networkResponse.clone();
          cache.put(event.request, responseToCache);
          return networkResponse;
        }).catch((err) => {
          console.warn('Background fetch failed:', err);
        });

        return cachedResponse || fetchPromise;
      });
    })
  );
});
