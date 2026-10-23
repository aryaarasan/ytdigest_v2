const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('service worker bypasses app updates, authenticated services, and non-GET requests', () => {
  const listeners = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'), 'utf8'), {
    self: { addEventListener: (name, handler) => { listeners[name] = handler; } }, URL,
  });
  for (const request of [
    { method: 'POST', url: 'https://example.test/api', mode: 'cors' },
    { method: 'GET', url: 'https://example.test/youtube.html', mode: 'navigate' },
    { method: 'GET', url: 'https://example.test/index.html', mode: 'cors' },
    { method: 'GET', url: 'https://example.test/digest-analytics.js', mode: 'cors' },
    { method: 'GET', url: 'https://example.test/summary-access.js', mode: 'cors' },
    { method: 'GET', url: 'https://asia-south1-example.cloudfunctions.net/getSummaryAnalytics', mode: 'cors' },
    { method: 'GET', url: 'https://firestore.googleapis.com/v1/users', mode: 'cors' },
  ]) {
    let intercepted = false;
    listeners.fetch({ request, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, request.url);
  }
});
