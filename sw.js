const CACHE_NAME = 'tesla-dashcam-stamp-v1';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  './icon.png',
  './public/mp4-muxer.min.js',
  './public/protobuf.min.js',
  './public/dashcam-mp4.js',
  './public/dashcam.proto'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching mandatory assets');
      return cache.addAll(ASSETS_TO_CACHE);
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
  // 采用“缓存优先”策略，确保离线也能运行
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      
      // 如果缓存中没有，则尝试从网络获取并静默更新缓存
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        
        return response;
      }).catch(() => {
        // 如果网络也挂了且缓存没命中（这种情况对我们要命中的本地资源不会发生，只要 install 成功）
        console.error('Network failed and asset not in cache');
      });
    })
  );
});
