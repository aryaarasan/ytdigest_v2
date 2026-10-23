// Loopback-only preview with synthetic responses; never uses production accounts.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const allowed = new Set(['index.html', 'youtube.html', 'digest-analytics.js', 'summary-access.js', 'tests/fixtures.js', 'manifest.json']);
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = decodeURIComponent(url.pathname.slice(1)) || 'youtube.html';
  if (!allowed.has(file) && !/^icons\/[\w-]+\.png$/.test(file)) { res.writeHead(404); res.end(); return; }
  let content = fs.readFileSync(path.join(root, file));
  if (file.endsWith('.html')) {
    const mode = ['signedout', 'free', 'guest', 'pro', 'trial', 'expired'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'pro';
    content = content.toString().replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^\"]+"><\/script>/g, '');
    content = content.replace('</head>', `<script>window.__fixtureOptions = ${JSON.stringify({ mode, summaryDelay: 1000 })};</script><script src="/tests/fixtures.js"></script></head>`);
    content = content.replace('</body>', '<script>window.__fixture.signIn();</script></body>');
    content = content.replace('<title>', '<title>Local UAT preview · ');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.png') ? 'image/png' : 'application/json');
  res.end(content);
}).listen(4173, '127.0.0.1', () => console.log('Local UAT preview: http://127.0.0.1:4173/youtube.html?mode=pro'));
