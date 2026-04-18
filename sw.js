// =============================================================================
// SERVICE WORKER — sw.js
// VERSION: ytdigest-v2
// =============================================================================
// Bump the version string any time you deploy changes.
// The activate handler nukes all caches from older versions automatically.
//
// CACHING STRATEGY (deliberately simple):
//
//   index.html        → NEVER cached by SW.
//                       Let the browser handle it normally (HTTP cache headers
//                       from GitHub Pages). This ensures you always get the
//                       latest app code on every visit with no SW interference.
//
//   Google Fonts      → Cache-first. Font files never change at the same URL.
//
//   Google Sheets     → Network-first. Always try to get fresh data.
//                       Fall back to cached version when offline.
//
//   Everything else   → Network-first with cache fallback.
//
// WHY NOT CACHE index.html:
//   Caching the app shell sounds good in theory but causes a painful problem
//   in practice: every time you deploy an update, users keep getting the old
//   cached version until the SW update cycle completes (can take 24hrs+).
//   For a personal tool on GitHub Pages, the HTML file is tiny and loads fast
//   from the network. The complexity of stale-while-revalidate or manual
//   cache-busting is not worth it.
// =============================================================================

const VERSION    = 'ytdigest-v2';
const DATA_CACHE = VERSION + '-data';
const FONT_CACHE = VERSION + '-fonts';

// ─── INSTALL ─────────────────────────────────────────────────────────────────
// Nothing to pre-cache. Skip waiting so this SW activates immediately
// without waiting for existing tabs to close.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
// Delete ALL caches that don't belong to this version.
// This nukes the old ytdigest-v1-shell cache that was serving stale HTML.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== DATA_CACHE && key !== FONT_CACHE)
          .map(key => {
            console.log('[SW v2] Deleting stale cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim()) // take control of all open tabs now
  );
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept index.html — let the browser fetch it fresh every time.
  // This is the key fix: SW no longer serves stale app code.
  if (url.endsWith('/') || url.includes('index.html')) {
    return; // fall through to browser default behaviour
  }

  // Never intercept manifest.json or sw.js itself
  if (url.includes('manifest.json') || url.includes('sw.js')) {
    return;
  }

  // Google Sheets data → network-first, cache fallback for offline
  if (url.includes('docs.google.com/spreadsheets')) {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
    return;
  }

  // Google Fonts → cache-first (font files are immutable at their URLs)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, FONT_CACHE));
    return;
  }

  // YouTube thumbnails and everything else → network-first
  event.respondWith(networkFirst(event.request, DATA_CACHE));
});


// ─── STRATEGY: Network-first ─────────────────────────────────────────────────
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      console.log('[SW v2] Offline — serving from cache:', request.url);
      return cached;
    }
    return new Response('Offline and no cached version available.', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

// ─── STRATEGY: Cache-first ───────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    return new Response('Resource not available offline.', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}
