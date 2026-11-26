const CACHE_NAME = 'fae-asset-pwa-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('script.google.com') || event.request.url.includes('googleusercontent.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
