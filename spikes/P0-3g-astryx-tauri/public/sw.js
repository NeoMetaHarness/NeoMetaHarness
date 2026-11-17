// App-shell service worker (web/PWA only; never registered inside the Tauri desktop app).
// Rules learned in spike g:
//   - Navigations (index.html) are NETWORK-FIRST, falling back to cache offline. A cache-first shell
//     pins users to an old bundle after an update (observed: stale index-*.js served after rebuild).
//   - Content-hashed /assets/* are immutable, so CACHE-FIRST is safe.
const CACHE = 'neo-shell-v2'
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))) })
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return
  const put = res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(put).catch(() => caches.match('/')))
  } else if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(put)))
  }
})
