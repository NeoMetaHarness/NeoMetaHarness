// App navigations refresh from the network. Immutable, hashed Vite assets cache safely.
const CACHE = 'neo-app-v1';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));
});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const snapshot = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, snapshot));
      }
      return response;
    }).catch(() => caches.match('/')));
  } else if (/^\/assets\/[^/]+-[a-zA-Z0-9_-]{8,}\.[^/]+$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const snapshot = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, snapshot));
      }
      return response;
    })));
  }
});
