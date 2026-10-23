const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const activity = require('../functions/summary-activity');
const metadata = require('../functions/video-metadata');

function backend(user = { isPro: true, timezone: 'Asia/Calcutta' }, options = {}) {
  const metadataCalls = [];
  const docs = new Map([
    ['users/test-user', user],
    ['videoCache/abcdefghij1', { shortSummary: 'A valid cached summary longer than twenty characters.', channel: 'Trusted channel' }],
  ]);
  const snapshot = key => ({ id: key.split('/').pop(), exists: docs.has(key), data: () => docs.get(key), ref: { set: async (data, opts) => docs.set(key, opts?.merge ? { ...docs.get(key), ...data } : data) } });
  function collection(prefix) {
    return {
      doc(id) {
        const key = `${prefix}/${id}`;
        return { key, get: async () => snapshot(key), set: async (data, options) => docs.set(key, options?.merge ? { ...docs.get(key), ...data } : data), collection: name => collection(`${key}/${name}`) };
      },
      where(field, op, value) {
        const conditions = [[field, op, value]];
        const query = {
          where(field, op, value) { conditions.push([field, op, value]); return query; },
          async get() {
            return { docs: [...docs.keys()].filter(key => key.startsWith(prefix + '/') && conditions.every(([field, op, value]) => op === '>=' ? docs.get(key)[field] >= value : docs.get(key)[field] <= value)).map(snapshot) };
          },
        };
        return query;
      },
    };
  }
  let transaction = Promise.resolve();
  const db = { collection, getAll: async (...refs) => refs.map(ref => snapshot(ref.key)), runTransaction(fn) {
    const result = transaction.then(() => fn({ get: ref => ref.get(), set: (ref, data, options) => ref.set(data, options) }));
    transaction = result.catch(() => {});
    return result;
  } };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const handlers = {};
  const fakeRequire = name => {
    if (name === './summary-activity') return activity;
    if (name === './video-metadata') return metadata;
    if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (_, fn) => fn, onRequest: (_, fn) => fn };
    if (name === 'firebase-functions/v2/scheduler') return { onSchedule: (_, fn) => fn };
    if (name === 'firebase-functions/params') return { defineSecret: () => ({ value() { throw new Error('No external secrets in tests'); } }) };
    if (name === 'firebase-admin/app') return { initializeApp() {} };
    if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => new Date().toISOString() } };
    if (name === 'firebase-admin/auth') return { getAuth: () => ({}) };
    if (name === 'node-fetch') return async input => {
      const url = new URL(input);
      metadataCalls.push(url.pathname);
      if (options.metadataFailure) throw new Error('Metadata service unavailable');
      const items = url.pathname.endsWith('/videos') ? url.searchParams.get('id').split(',').map(id => ({
        id, snippet: { categoryId: '28' }, contentDetails: { duration: options.duration || 'PT12M34S' },
        topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Knowledge', 'https://en.wikipedia.org/wiki/Technology'] },
      })) : [{ id: '28', snippet: { title: 'Science & Technology' } }];
      return { ok: true, json: async () => ({ items }) };
    };
    if (name === 'nodemailer') return {};
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../functions/index.js'), 'utf8'), { require: fakeRequire, exports: handlers, console: { log() {}, warn() {}, error() {} }, Date, Buffer, setTimeout });
  const request = (data = {}, uid = 'test-user') => ({ auth: uid ? { uid } : null, data });
  return { docs, handlers, request, metadataCalls };
}

test('opening records require authentication, a real video, and a ready cached summary', async () => {
  const b = backend();
  await assert.rejects(b.handlers.recordSummaryOpen(b.request({}, null)), { code: 'unauthenticated' });
  await assert.rejects(b.handlers.recordSummaryOpen(b.request({ videoId: '../bad' })), { code: 'invalid-argument' });
  await assert.rejects(b.handlers.recordSummaryOpen(b.request({ videoId: 'missingvid1' })), { code: 'failed-precondition' });
  assert.equal([...b.docs.keys()].filter(key => key.includes('/summaryOpens/')).length, 0);
});

test('simultaneous repeated opens create one user-owned daily record', async () => {
  const b = backend();
  const calls = await Promise.all(Array.from({ length: 6 }, () => b.handlers.recordSummaryOpen(b.request({ videoId: 'abcdefghij1', timezone: 'Invalid', channel: 'Spoofed channel', durationSeconds: 1200 }))));
  assert.equal(calls.filter(result => result.recorded).length, 1);
  const entries = [...b.docs.entries()].filter(([key]) => key.includes('/summaryOpens/'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].channel, 'Trusted channel');
  assert.equal(entries[0][1].timezone, 'Asia/Calcutta');
  assert.ok(entries[0][1].estimatedSavedSeconds > 0);
  const result = await b.handlers.getSummaryAnalytics(b.request({}));
  assert.equal(result.periods.today.total, 1);
  assert.equal(result.periods.month.total, 1);
});

test('one account cannot see another account activity', async () => {
  const b = backend();
  await b.handlers.recordSummaryOpen(b.request({ videoId: 'abcdefghij1' }));
  b.docs.set('users/other-user', { isPro: true });
  const result = await b.handlers.getSummaryAnalytics(b.request({}, 'other-user'));
  assert.equal(result.periods.month.total, 0);
});

test('free and expired accounts cannot fetch Pro analytics', async () => {
  for (const user of [{}, { isPro: true, proUntil: '2000-01-01' }]) {
    const b = backend(user);
    await assert.rejects(b.handlers.getSummaryAnalytics(b.request()), { code: 'permission-denied' });
  }
});

test('serving a cached summary uses no daily generation quota and records no opening', async () => {
  const b = backend({});
  const result = await b.handlers.summarizeVideo(b.request({ videoId: 'abcdefghij1', title: 'Cached video', channelName: 'Trusted channel' }));
  assert.equal(result.fromCache, true);
  assert.equal(b.docs.has('quotas/test-user'), false);
  assert.equal([...b.docs.keys()].filter(key => key.includes('/summaryOpens/')).length, 0);
});

test('old activity receives duration and topic metadata without adding an opening', async () => {
  const b = backend();
  const day = activity.dayInTimezone(new Date(), 'Asia/Calcutta');
  const key = `users/test-user/summaryOpens/${day}_abcdefghij1`;
  b.docs.set(key, { videoId: 'abcdefghij1', day, channel: 'Trusted channel', openedAt: 'original timestamp', estimatedSavedSeconds: 0 });
  const result = await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(result.periods.today.total, 1);
  assert.ok(result.periods.today.estimatedSavedSeconds > 0);
  assert.equal(result.periods.today.topics[0].name, 'Technology');
  assert.equal(b.docs.get(key).openedAt, 'original timestamp');
  assert.equal(b.docs.get(key).metricsVersion, 2);
  const requests = b.metadataCalls.length;
  await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(b.metadataCalls.length, requests);
});

test('a short video can honestly save zero time without counting duplicate summary formats', async () => {
  const b = backend(undefined, { duration: 'PT58S' });
  b.docs.get('videoCache/abcdefghij1').sections = [{ heading: 'Breakdown', content: 'word '.repeat(400) }];
  await b.handlers.recordSummaryOpen(b.request({ videoId: 'abcdefghij1', durationSeconds: 9999 }));
  const result = await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(result.periods.today.estimatedSavedSeconds, 0);
  assert.equal([...b.docs.values()].find(value => value.metricsVersion === 2)?.videoSeconds, 58);
});

test('metadata outages do not prevent recording or loading summary activity', async () => {
  const b = backend(undefined, { metadataFailure: true });
  await b.handlers.recordSummaryOpen(b.request({ videoId: 'abcdefghij1', durationSeconds: 58 }));
  const result = await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(result.periods.today.total, 1);
  assert.ok(result.periods.today.estimatedSavedSeconds > 0);
});

test('large legacy histories repair in bounded batches and continue on the next refresh', async () => {
  const b = backend();
  const day = activity.dayInTimezone(new Date(), 'Asia/Calcutta');
  for (let i = 0; i < 150; i++) {
    const videoId = String(i).padStart(11, '0');
    b.docs.set(`videoCache/${videoId}`, { shortSummary: 'A ready summary.', channel: 'Science' });
    b.docs.set(`users/test-user/summaryOpens/${day}_${videoId}`, { videoId, day, channel: 'Science' });
  }
  const first = await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(first.periods.today.total, 150);
  assert.equal(first.periods.today.classifiedVideos, 100);
  const second = await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(second.periods.today.total, 150);
  assert.equal(second.periods.today.classifiedVideos, 150);
  const requests = b.metadataCalls.length;
  await b.handlers.getSummaryAnalytics(b.request());
  assert.equal(b.metadataCalls.length, requests);
});
