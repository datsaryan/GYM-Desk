// Gym Desk service worker.
// Keeps the app shell (HTML, CSS, JS, icons) available so the app opens instantly and
// can be installed. Data requests (/api) are never cached, so member data is always live.
const CACHE = 'gymdesk-shell-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so a new deploy shows up right away. If the network is slow (for example the
// free Render plan waking up) or offline, the cached copy is used after 2.5 seconds.
function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
    const timer = setTimeout(() => { caches.match(req).then(finish); }, 2500);
    fetch(req).then((res) => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      finish(res);
    }).catch(() => {
      clearTimeout(timer);
      caches.match(req).then((r) => finish(r || Response.error()));
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname.startsWith('/.well-known/')) return;
  e.respondWith(networkFirst(req));
});
