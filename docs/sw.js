/* DataCloak — offline service worker.
 *
 * Caches ONLY the app's own static assets so it works offline. It never sees,
 * caches or transmits document content: documents are read via the File API and
 * processed in memory / in the Web Worker, which produces no network requests.
 *
 * HTML/JS/CSS shell is network-first (so a fixed build lands on the next online
 * load); fonts/icons are cache-first.
 */
const CACHE = 'datacloak-v19';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './worker.js',
  './detectors.js',
  './zip.js',
  './ooxml.js',
  './docx.js',
  './xlsx.js',
  './zipbundle.js',
  './pdfredact.js',
  './imagepdf.js',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './privacy.html',
  // Large vendored pdf.js build (cache-first; fonts fetched on demand + cached).
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only ever handle our own origin. Never touch anything cross-origin.
  if (url.origin !== self.location.origin) return;

  const isDoc = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  // Large vendored libraries (pdf.js, fonts) rarely change and are heavy — serve
  // them cache-first so a refresh doesn't re-download megabytes.
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // Network-first for EVERYTHING else: every refresh behaves like a hard reset and
  // loads the latest files when online. `cache: 'no-cache'` bypasses the browser
  // HTTP cache and revalidates. The cache is only a fallback for offline use.
  e.respondWith(
    fetch(url.href, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isDoc ? './index.html' : req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(isDoc ? './index.html' : req).then((r) => r || caches.match('./')))
  );
});
