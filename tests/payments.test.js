const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { hasProAccess } = require('../functions/summary-activity');

// Run the actual exported handlers with fake secrets, HTTP and Firestore.
// These checks never contact Lemon Squeezy or change a Firebase account.
function payments(options = {}) {
  const users = new Map();
  const calls = [];
  const handlers = {};
  const secret = 'local-webhook-test-secret';
  const db = { collection(name) {
    assert.equal(name, 'users');
    return { doc(uid) { return { async set(patch, opts) {
      assert.equal(opts.merge, true);
      users.set(uid, { ...users.get(uid), ...patch });
    } }; } };
  } };
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const fakeRequire = name => {
    if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (_, fn) => fn, onRequest: (_, fn) => fn };
    if (name === 'firebase-functions/v2/scheduler') return { onSchedule: (_, fn) => fn };
    if (name === 'firebase-functions/params') return { defineSecret: name => ({ value: () => name.endsWith('WEBHOOK_SECRET') ? secret : 'fake-api-key' }) };
    if (name === 'firebase-admin/app') return { initializeApp() {} };
    if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: {} };
    if (name === 'firebase-admin/auth') return { getAuth: () => ({}) };
    if (name === 'node-fetch') return async (url, init) => {
      calls.push({ url, ...init });
      return { ok: !options.apiFailure, text: async () => 'Simulated provider error',
        json: async () => ({ data: { attributes: { url: 'https://example.lemonsqueezy.com/checkout/test' } } }) };
    };
    if (name === 'nodemailer') return {};
    if (name.startsWith('./')) return require('../functions/' + name.slice(2));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../functions/index.js'), 'utf8'), {
    require: fakeRequire, exports: handlers, console: { log() {}, warn() {}, error() {} }, Date, Buffer, setTimeout,
  });
  async function webhook(eventName, attributes = {}, options = {}) {
    const body = { meta: { event_name: eventName, custom_data: { uid: 'buyer-a' } },
      data: { type: 'subscriptions', id: 'test-subscription', attributes: { customer_id: 123, ...attributes } } };
    if (options.noUid) delete body.meta.custom_data;
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    let status = 200;
    let response;
    const res = { status(code) { status = code; return this; }, send(value) { response = value; return this; }, json(value) { response = value; return this; } };
    await handlers.lemonSqueezyWebhook({ body, rawBody,
      get: () => options.signature === undefined ? signature : options.signature }, res);
    return { status, response };
  }
  return { users, calls, handlers, webhook };
}

const future = '2099-01-01T00:00:00.000Z';
const past = '2000-01-01T00:00:00.000Z';

test('checkout requires sign-in and uses the authenticated uid rather than client input', async () => {
  const b = payments();
  await assert.rejects(b.handlers.createLemonSqueezyCheckout({ auth: null }), { code: 'unauthenticated' });
  assert.equal(b.calls.length, 0);
  const result = await b.handlers.createLemonSqueezyCheckout({ auth: { uid: 'buyer-a' }, data: { uid: 'buyer-b', variant: 'untrusted' } });
  assert.equal(result.url, 'https://example.lemonsqueezy.com/checkout/test');
  const payload = JSON.parse(b.calls[0].body);
  assert.equal(payload.data.attributes.product_options.redirect_url, 'https://aryaarasan.github.io/ytdigest_v2/youtube.html');
  assert.equal(payload.data.attributes.checkout_data.custom.uid, 'buyer-a');
  assert.equal(payload.data.relationships.store.data.id, '410502');
  assert.equal(payload.data.relationships.variant.data.id, '1820322');
});

test('provider checkout errors return a controlled error without granting access', async () => {
  const b = payments({ apiFailure: true });
  await assert.rejects(b.handlers.createLemonSqueezyCheckout({ auth: { uid: 'buyer-a' } }), { code: 'internal' });
  assert.equal(b.users.size, 0);
});

test('missing, wrong-length and incorrect same-length signatures cannot change an account', async () => {
  for (const signature of ['', 'wrong', '0'.repeat(64)]) {
    const b = payments();
    assert.equal((await b.webhook('subscription_created', { status: 'active', renews_at: future }, { signature })).status, 400);
    assert.equal(b.users.size, 0);
  }
});

test('signed purchase upgrades only the checkout owner and preserves unrelated fields', async () => {
  const b = payments();
  b.users.set('buyer-a', { channels: ['my-channel'] });
  b.users.set('buyer-b', { isPro: false });
  assert.equal((await b.webhook('subscription_created', { status: 'active', renews_at: future })).status, 200);
  assert.equal(hasProAccess(b.users.get('buyer-a')), true);
  assert.equal(b.users.get('buyer-a').proUntil, future);
  assert.deepEqual(b.users.get('buyer-a').channels, ['my-channel']);
  assert.equal(b.users.get('buyer-b').isPro, false);
});

test('Lemon Squeezy on_trial grants access only until its trial end', async () => {
  const b = payments();
  await b.webhook('subscription_created', { status: 'on_trial', trial_ends_at: future, renews_at: future });
  assert.equal(hasProAccess(b.users.get('buyer-a')), true);
  await b.webhook('subscription_updated', { status: 'on_trial', trial_ends_at: past, renews_at: future });
  assert.equal(hasProAccess(b.users.get('buyer-a')), false);
});

test('cancellation keeps access until ends_at; expired cancellation does not', async () => {
  const b = payments();
  await b.webhook('subscription_cancelled', { status: 'cancelled', ends_at: future });
  assert.equal(hasProAccess(b.users.get('buyer-a')), true);
  assert.equal(b.users.get('buyer-a').proUntil, future);
  await b.webhook('subscription_updated', { status: 'cancelled', ends_at: past });
  assert.equal(hasProAccess(b.users.get('buyer-a')), false);
});

test('renewal advances access and an identical delivery has no additional effect', async () => {
  const b = payments();
  await b.webhook('subscription_created', { status: 'active', renews_at: '2098-01-01T00:00:00.000Z' });
  await b.webhook('subscription_updated', { status: 'active', renews_at: future });
  const expected = { ...b.users.get('buyer-a') };
  await b.webhook('subscription_updated', { status: 'active', renews_at: future });
  assert.deepEqual(b.users.get('buyer-a'), expected);
  assert.equal(expected.proUntil, future);
});

test('expiry and failed renewal remove paid access; a recovered active update restores it', async () => {
  for (const eventName of ['subscription_expired', 'subscription_payment_failed']) {
    const b = payments();
    await b.webhook('subscription_created', { status: 'active', renews_at: future });
    await b.webhook(eventName);
    assert.equal(hasProAccess(b.users.get('buyer-a')), false);
    await b.webhook('subscription_updated', { status: 'active', renews_at: future });
    assert.equal(hasProAccess(b.users.get('buyer-a')), true);
  }
});

test('past_due and unpaid do not grant paid access', async () => {
  for (const status of ['past_due', 'unpaid']) {
    const b = payments();
    await b.webhook('subscription_updated', { status, renews_at: future });
    assert.equal(hasProAccess(b.users.get('buyer-a')), false);
  }
});

test('unrelated events and events without a checkout uid do not upgrade anyone', async () => {
  const b = payments();
  await b.webhook('order_created', { status: 'active' });
  await b.webhook('subscription_created', { status: 'active', renews_at: future }, { noUid: true });
  assert.equal(b.users.size, 0);
});
