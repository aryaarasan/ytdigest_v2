const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const activity = require('../functions/summary-activity');

function backend(user = { isPro: true, timezone: 'Asia/Calcutta' }) {
  const docs = new Map([
    ['users/test-user', user],
    ['videoCache/abcdefghij1', { shortSummary: 'A valid cached summary longer than twenty characters.', channel: 'Trusted channel' }],
  ]);
  const snapshot = key => ({ id: key.split('/').pop(), exists: docs.has(key), data: () => docs.get(key) });
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
  const db = { collection, runTransaction(fn) {
    const result = transaction.then(() => fn({ get: ref => ref.get(), set: (ref, data, options) => ref.set(data, options) }));
    transaction = result.catch(() => {});
    return result;
  } };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const handlers = {};
  const fakeRequire = name => {
    if (name === './summary-activity') return activity;
    if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (_, fn) => fn, onRequest: (_, fn) => fn };
    if (name === 'firebase-functions/v2/scheduler') return { onSchedule: (_, fn) => fn };
    if (name === 'firebase-functions/params') return { defineSecret: () => ({ value() { throw new Error('No external secrets in tests'); } }) };
    if (name === 'firebase-admin/app') return { initializeApp() {} };
    if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => new Date().toISOString() } };
    if (name === 'firebase-admin/auth') return { getAuth: () => ({}) };
    if (name === 'node-fetch') return () => { throw new Error('Unexpected external request'); };
    if (name === 'nodemailer') return {};
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../functions/index.js'), 'utf8'), { require: fakeRequire, exports: handlers, console: { log() {}, warn() {}, error() {} }, Date, Buffer, setTimeout });
  const request = (data = {}, uid = 'test-user') => ({ auth: uid ? { uid } : null, data });
  return { docs, handlers, request };
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
