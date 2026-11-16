// Forwarder service worker for the OLD address. Browsers that still have the old app's worker
// fetch this file on their next visit; it replaces the old worker, clears its caches, removes
// itself and reloads any open tab, which then lands on the forwarder page and moves to the new address.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(windows => Promise.all(windows.map(client => client.navigate(client.url).catch(() => null))))
  );
});
