const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const project = path.resolve(__dirname, '..');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function page(mode = 'free', extra = {}, file = 'youtube.html') {
  const html = fs.readFileSync(path.join(project, file), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' + file, virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = query => ({ matches: false, addEventListener() {} });
  w.__fixtureOptions = { mode, ...extra };
  w.Chart = function () { this.destroy = () => {}; };
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.eval(fs.readFileSync(path.join(__dirname, 'fixtures.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(project, 'digest-analytics.js'), 'utf8'));
  for (const script of w.document.querySelectorAll('script:not([src])')) if (script.textContent.trim()) vm.runInContext(script.textContent, dom.getInternalVMContext());
  await w.__fixture.signIn();
  return { dom, w, d: w.document, fixture: w.__fixture, errors, close: () => w.close() };
}

test('all inline application scripts compile', () => {
  for (const file of ['index.html', 'youtube.html']) {
    const html = fs.readFileSync(path.join(project, file), 'utf8');
    for (const [index, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].entries()) {
      if (match[1].trim()) new vm.Script(match[1], { filename: `${file}:script${index}` });
    }
  }
});

test('signed out screen hides the app and matches Classic sign-in content', async () => {
  const p = await page('signedout');
  try {
    assert.equal(p.w.getComputedStyle(p.d.getElementById('screen-app')).display, 'none');
    assert.equal(p.w.getComputedStyle(p.d.getElementById('screen-auth')).display, 'flex');
    assert.equal(p.d.querySelectorAll('.auth-feature').length, 3);
    assert.match(p.d.querySelector('.auth-fine-print').textContent, /sync across devices/);
    assert.equal(p.fixture.calls.filter(c => c.name === 'summarizeVideo').length, 0);
  } finally { p.close(); }
});

for (const mode of ['free', 'guest', 'expired']) test(`${mode} users keep on-demand summaries and premium gates`, async () => {
  const p = await page(mode);
  try {
    assert.equal(p.d.querySelectorAll('.card').length, 4);
    assert.equal(p.fixture.calls.filter(c => c.name === 'summarizeVideo').length, 0);
    assert.equal(p.d.querySelector('.thumb-time-badge').textContent, '12:34');
    p.w.switchNavTab('analytics');
    assert.match(p.d.getElementById('main-feed-container').textContent, /Pro/);
    assert.equal(p.fixture.calls.filter(c => c.name === 'getSummaryAnalytics').length, 0);
    p.w.switchNavTab('feed');
    await p.w.toggleExpand(p.d.querySelector('.expand-btn'));
    assert.equal(p.d.querySelector('.card').dataset.summaryState, 'done');
    assert.equal(p.fixture.calls.filter(c => c.name === 'recordSummaryOpen').length, 1);
  } finally { p.close(); }
});

test('Pro cache is reused and background work is bounded and never counted as an open', async () => {
  const p = await page('pro', { summaryDelay: 15 });
  try {
    await delay(80);
    assert.equal(p.fixture.calls.filter(c => c.name === 'summarizeVideo').length, 3);
    assert.ok(p.fixture.maximumActive <= 2);
    assert.equal(p.fixture.calls.filter(c => c.name === 'recordSummaryOpen').length, 0);
    assert.equal(p.d.querySelectorAll('.pro-instant-badge').length, 4);
    const button = p.d.querySelector('.expand-btn');
    await p.w.toggleExpand(button);
    await delay(1);
    await p.w.toggleExpand(button);
    await p.w.toggleExpand(button);
    assert.equal(p.fixture.opened.size, 1);
    p.w.switchNavTab('analytics');
    await delay(5);
    assert.equal(p.d.querySelector('.da-total').textContent, '1');
    assert.equal(p.d.querySelector('select[aria-label="Analytics period"]').value, 'month');
  } finally { p.close(); }
});

test('channel chips and sidebar selection stay synchronized and reset on removal', async () => {
  const p = await page();
  try {
    p.d.querySelector('#sub-channel-list [data-channel-id="channel-1"]').click();
    assert.equal(p.d.querySelector('#chips-bar .active').dataset.channelId, 'channel-1');
    assert.equal(p.d.querySelectorAll('.card').length, 2);
    p.d.querySelector('#sub-channel-list [data-channel-id="channel-1"]').click();
    assert.equal(p.d.querySelector('#chips-bar .active').dataset.channelId, 'all');
    p.w.filterByChannel('channel-1');
    await p.w.removeChannel('channel-1');
    assert.equal(p.d.querySelector('#chips-bar .active').dataset.channelId, 'all');
    assert.equal(p.d.querySelectorAll('.card').length, 2);
  } finally { p.close(); }
});

test('clicking during background generation shares a request; failures can retry', async () => {
  const p = await page('trial', { summaryDelay: 20, failSummary: 'functions/internal' });
  try {
    const card = p.d.querySelector('[data-video-id="abcdefghij2"]');
    const request = p.w.toggleExpand(card.querySelector('.expand-btn'));
    await delay(60);
    await request;
    assert.equal(card.dataset.summaryState, 'error');
    assert.equal(p.fixture.calls.filter(c => c.name === 'summarizeVideo' && c.data.videoId === 'abcdefghij2').length, 1);
    p.fixture.options.failSummary = null;
    await p.w.fetchSummaryOnDemand(card);
    assert.equal(card.dataset.summaryState, 'done');
    assert.match(card.querySelector('.summary-content').textContent, /Detailed evidence/);
  } finally { p.close(); }
});

test('daily quota stops background queue without upgrade popups for Pro', async () => {
  const p = await page('pro', { failSummary: 'functions/resource-exhausted', summaryDelay: 5 });
  try {
    await delay(30);
    assert.ok(p.fixture.calls.filter(c => c.name === 'summarizeVideo').length <= 2);
    assert.equal(p.d.getElementById('pro-upgrade-overlay').classList.contains('open'), false);
    assert.match(p.d.getElementById('main-feed-container').textContent, /Daily summary limit/);
  } finally { p.close(); }
});

test('a cached summary can still be opened after a free account exhausts generation quota', async () => {
  const p = await page('free', { failSummary: 'functions/resource-exhausted' });
  try {
    const uncached = p.d.querySelector('[data-video-id="abcdefghij2"]');
    await p.w.toggleExpand(uncached.querySelector('.expand-btn'));
    assert.equal(uncached.dataset.summaryState, 'quota');
    const cached = p.d.querySelector('[data-video-id="abcdefghij1"]');
    await p.w.toggleExpand(cached.querySelector('.expand-btn'));
    assert.equal(cached.dataset.summaryState, 'done');
    assert.equal(p.fixture.calls.filter(c => c.name === 'summarizeVideo').length, 1);
    assert.equal(p.fixture.opened.size, 1);
  } finally { p.close(); }
});

test('search videos keep summary and bookmark metadata across navigation; Ask AI uses backend answer', async () => {
  const p = await page('pro');
  try {
    p.d.getElementById('yt-search-input').value = 'science';
    await p.w.executeSearch();
    await delay(5);
    const card = p.d.querySelector('.card');
    await p.w.toggleExpand(card.querySelector('.expand-btn'));
    p.d.getElementById('ask-input-searchvid01').value = 'What happened?';
    await p.w.sendAsk('searchvid01');
    assert.match(p.d.getElementById('ask-history-searchvid01').textContent, /An answer from the video/);
    await p.w.toggleBookmark({ stopPropagation() {} }, card.querySelector('.action-btn'), 'searchvid01');
    assert.match(p.fixture.userData.saved[0].title, /creator's/);
    assert.equal(p.fixture.userData.saved[0].sections.length, 1);
    p.w.switchNavTab('saved'); await delay(5);
    assert.match(p.d.querySelector('.card-title').textContent, /creator's/);
    assert.equal(p.d.querySelector('.card').dataset.summaryState, 'done');
  } finally { p.close(); }
});

test('channel suggestions search while typing and clear stale results', async () => {
  const p = await page();
  try {
    const input = p.d.getElementById('channel-search-input');
    input.value = 'Sci'; input.dispatchEvent(new p.w.Event('input'));
    await delay(460);
    assert.match(p.d.getElementById('channel-search-results').textContent, /Sci Channel/);
    input.value = ''; input.dispatchEvent(new p.w.Event('input'));
    assert.equal(p.d.getElementById('channel-search-results').style.display, 'none');
  } finally { p.close(); }
});

test('Classic still boots and ready summary openings use the shared analytics', async () => {
  const p = await page('signedout', {}, 'index.html');
  try {
    p.w.eval('currentUser = window.__fixture.user; isProUser = true;');
    const v = { videoId: 'abcdefghij1', title: 'A cached video', channel: 'Science', date: '2026-10-23', videoUrl: 'https://www.youtube.com/watch?v=abcdefghij1', shortSummary: 'A cached summary.' };
    p.w.__video = v;
    const card = p.w.eval('buildCard(window.__video, 0)');
    p.d.body.appendChild(card);
    p.w.toggleExpand(card.querySelector('.expand-btn'));
    await delay(5);
    assert.equal(p.fixture.opened.size, 1);
    await p.w.renderAnalytics();
    assert.equal(p.d.querySelector('.da-total').textContent, '1');
  } finally { p.close(); }
});

test('Classic generated feed, search and related summaries remain usable and record opens', async () => {
  const p = await page('signedout', {}, 'index.html');
  try {
    p.w.eval('currentUser = window.__fixture.user; isProUser = true;');
    const schedule = p.w.setTimeout.bind(p.w);
    p.w.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 1800 || ms === 1200 ? 0 : ms, ...args);
    p.w.__video = { videoId: 'abcdefghij2', title: 'Generated feed video', channel: 'Science', date: '2026-10-23', videoUrl: 'https://www.youtube.com/watch?v=abcdefghij2' };
    const feedCard = p.w.eval('buildCard(window.__video, 0)');
    p.d.body.appendChild(feedCard); feedCard.classList.add('expanded');
    await p.w.fetchSummaryOnDemand(feedCard);
    assert.equal(feedCard.dataset.summaryState, 'done');
    assert.match(feedCard.textContent, /Detailed evidence/);
    p.w.__video = { videoId: 'searchvid01', title: 'Generated search video', channel: 'Science', published: '2026-10-23', videoUrl: 'https://www.youtube.com/watch?v=searchvid01' };
    const searchCard = p.w.eval('buildSearchResultCard(window.__video, 0)');
    p.d.body.appendChild(searchCard); searchCard.classList.add('expanded');
    await p.w.fetchSearchResultSummary(searchCard);
    assert.equal(searchCard.dataset.summaryState, 'done');
    const related = p.d.createElement('div');
    related.id = 'rcard-relatedvid1';
    Object.assign(related.dataset, { url: 'https://www.youtube.com/watch?v=relatedvid1', title: 'Related video', channel: 'Science' });
    p.d.body.appendChild(related);
    await p.w.toggleRelatedCard('relatedvid1');
    assert.match(p.d.getElementById('rmodal-body-relatedvid1').textContent, /New insight/);
    assert.equal(p.fixture.opened.size, 3);
  } finally { p.close(); }
});

test('navigation does not multiply the background queue across views', async () => {
  const p = await page('pro', { summaryDelay: 25 });
  try {
    p.d.getElementById('yt-search-input').value = 'another video';
    await p.w.executeSearch();
    await delay(100);
    assert.ok(p.fixture.maximumActive <= 2);
    assert.equal(p.d.querySelectorAll('.card').length, 1);
    assert.equal(p.d.querySelector('.card').dataset.videoId, 'searchvid01');
    assert.equal(p.fixture.opened.size, 0);
  } finally { p.close(); }
});

test('duration parsing handles long videos and missing duration', async () => {
  const p = await page('signedout');
  try {
    assert.equal(p.w.formatDuration('PT1H2M3S').label, '1:02:03');
    assert.equal(p.w.formatDuration('P1DT2H').label, '26:00:00');
    assert.equal(p.w.formatDuration('').label, '');
    assert.equal(p.w.formatDuration('PT0S').label, '');
  } finally { p.close(); }
});
