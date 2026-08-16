// Service worker: cache the app shell so it installs & runs offline.
// Bump CACHE to force clients to pull fresh assets after a deploy.
const CACHE = 'visualizer-v2';
const ASSETS = [
  './', './index.html', './eva.html', './pulse.html', './manifest.json',
  './palette.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function runtimePut(req, res) {
  if (res && res.ok && new URL(req.url).origin === location.origin) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isPage) {
    // network-first: always get the latest page online (so pushes land immediately),
    // fall back to the cached shell only when offline.
    e.respondWith(
      fetch(req).then(res => runtimePut(req, res))
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
  } else {
    // cache-first for static assets (icons, manifest) with runtime caching.
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => runtimePut(req, res)).catch(() => hit))
    );
  }
});
