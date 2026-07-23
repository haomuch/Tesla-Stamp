const CACHE_NAME = 'tesla-dashcam-stamp-v1';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  './icon.png',
  './public/mp4-muxer.min.js',
  './public/protobuf.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching assets...');
      // 使用 map + Promise.allSettled 确保单个资源失败不影响整体安装
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
  // 采用 "stale-while-revalidate" 策略：
  // 1. 立即从缓存返回资源（保证极速加载/离线可用）
  // 2. 同时在后台发起网络请求，更新缓存供下次使用
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          
          // 更新缓存
          const responseToCache = networkResponse.clone();
          cache.put(event.request, responseToCache);
          return networkResponse;
        }).catch((err) => {
          console.warn('Background fetch failed:', err);
        });

        // 如果有缓存，立即返回缓存，但后台 fetchPromise 仍在运行
        return cachedResponse || fetchPromise;
      });
    })
  );
});
