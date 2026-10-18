/**
 * The PWA's service worker: keeps the page offline. Translations and
 * commentaries live in IndexedDB, not here — this caches only the shell.
 *
 * The cache is named by version and page hash, so every deploy changes this
 * file's bytes and the browser installs the new worker. It waits until the
 * page says "activate" (update.ts), and serves only from its own cache — never
 * caches.match, which would also see a waiting version's cache.
 */
const CACHE = 'html-bible-__CACHE__';
const VERSION = '__VERSION__';
const SHELL = ['./', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('html-bible-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'activate') self.skipWaiting();
  else if (event.data === 'version') event.ports[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Data and the API are not the shell: always the network.
  if (url.pathname.includes('/data/') || url.pathname.includes('/v1/') || url.pathname.includes('/oauth2/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match('./').then((hit) => hit ?? fetch(request))));
    return;
  }
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request).then((hit) => hit ?? fetch(request))));
});
