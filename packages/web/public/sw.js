// swarm-os service worker — Phase 6.
//
// Scope: caches the static app shell (HTML, JS, CSS, icons, manifest) so the
// PWA opens fast and works offline if the server is unreachable. NEVER caches
// authenticated data or live streams. Update the cache name to invalidate.
//
// What is cached (cache-first, fall back to network):
//   - /, /index.html
//   - precache anything fetched as 'navigate' destination
//   - /assets/* (Vite-hashed JS/CSS — content-addressed, safe to cache forever)
//   - /icon-*.png, /apple-touch-icon.png, /manifest.webmanifest
//
// What is NEVER cached (network-only, no SW response if offline):
//   - /api/*  (none today, reserved)
//   - /orchestrators*, /sessions*, /health, /info, /ws-ticket, /hooks/*
//   - /ws/* (WebSocket upgrades — SW can't proxy these anyway)
//   - /ide* (VS Code web — reverse-proxied to serve-web. It owns its OWN
//     resource + service-worker logic, so this SW must NEVER intercept its
//     requests or the embedded workbench loads grey. Covers /ide/* and
//     /ide-info.)
//   - any request with Authorization or X-Auth-Token header

const CACHE = 'swarm-os-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const NEVER_CACHE = [/^\/orchestrators/, /^\/sessions/, /^\/health/, /^\/info/, /^\/ws-ticket/, /^\/hooks\//, /^\/ws(\/|$)/, /^\/api(\/|$)/, /^\/ide(\/|-|$)/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((rx) => rx.test(url.pathname))) return; // network-only — let the browser handle it

  // Cache-first for shell + hashed assets; SWR for the navigation HTML so
  // updates land on next reload without breaking the offline path.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined); return res; }).catch(() => caches.match(req).then((m) => m || caches.match('/'))));
    return;
  }
  e.respondWith(caches.match(req).then((m) => m || fetch(req).then((res) => { if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icon-') || url.pathname === '/apple-touch-icon.png' || url.pathname === '/manifest.webmanifest')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined); } return res; })));
});
