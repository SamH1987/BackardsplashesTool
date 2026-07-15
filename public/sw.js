/* Service worker: makes Spa Jobs work offline on a phone or tablet.
   - The app shell (pages, scripts, styles) is cached on install.
   - API reads are network-first with a cached fallback, so jobs and the
     catalogue you've opened before still load with no signal.
   - Photos and images are cached as you view them.
   Writes made offline are queued by the app itself (see app.js) and synced
   when the connection returns. */

const VERSION = 'spajobs-v2';
const SHELL = [
  '/', '/index.html', '/app.js', '/styles.css',
  '/3d.html', '/3d.js',
  '/vendor/three.min.js', '/vendor/GLTFLoader.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION + '-shell').then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // writes are handled by the app's queue
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // don't cache the big stuff - videos and 3D scans
  if (/\.(mp4|mov|glb|gltf|zip)$/i.test(url.pathname)) return;

  if (url.pathname.startsWith('/api/')) {
    // network first, cached copy when offline
    e.respondWith(
      fetch(req).then(res => {
        const clone = res.clone();
        caches.open(VERSION + '-api').then(c => c.put(req, clone));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // static + images: cache first, refresh in the background
  // (ignoreSearch so /3d.html?job=... hits the cached /3d.html)
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const refresh = fetch(req).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(VERSION + '-static').then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
});
