const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummaryAccess } = require('../functions/summary-access');
const ready = { shortSummary: 'A complete useful summary ready to read.', detailedSummary: 'The full explanation.', sections: [] };
const id = i => String(i).padStart(11, '0');

function setup(options = {}) {
  let clock = new Date(options.time || '2026-10-23T12:00:00Z'), calls = 0, serial = Promise.resolve();
  const docs = new Map([['users/u', { isPro: !!options.pro }]]);
  const clone = value => value === undefined ? undefined : structuredClone(value);
  function snapshot(key) { return { exists: docs.has(key), data: () => clone(docs.get(key)) }; }
  function collection(prefix) {
    return { doc(value) {
      const key = `${prefix}/${value}`;
      return { key, get: async () => snapshot(key), set: async (data, opts) => docs.set(key, opts?.merge ? { ...clone(docs.get(key)), ...clone(data) } : clone(data)), collection: name => collection(`${key}/${name}`) };
    }, where(field, op, values) { return { get: async () => ({ docs: [...docs].filter(([key, value]) => key.startsWith(prefix + '/') && values.includes(value[field])).map(([key]) => snapshot(key)) }) }; } };
  }
  const db = { collection, getAll: async (...refs) => refs.map(ref => snapshot(ref.key)), runTransaction(fn) {
    const task = serial.then(async () => {
      const writes = [];
      const result = await fn({ get: ref => ref.get(), set: (ref, data, opts) => writes.push(() => ref.set(data, opts)) });
      for (const write of writes) await write();
      return result;
    });
    serial = task.catch(() => {}); return task;
  } };
  const config = { db, now: () => clock, isDeveloper: request => !!request.auth?.developer,
    error: (code, message) => Object.assign(new Error(message), { code }), policy: options.policy || {}, wait: async () => {},
    generate: async video => { calls++; if (options.generate) return options.generate(video); if (options.fail) throw new Error('Provider failed'); return { ...ready, usage: { prompt_tokens: 100, completion_tokens: 50 } }; } };
  const service = createSummaryAccess(config);
  return { service, docs, second: () => createSummaryAccess(config), request: (data, uid = 'u') => ({ auth: uid ? { uid, developer: !!options.developer } : null, data }),
    video: i => ({ videoId: id(i), title: `Video ${i}` }), cache: i => docs.set(`videoCache/${id(i)}`, { ...ready }),
    setTime: value => clock = new Date(value), get calls() { return calls; } };
}

test('cached and fresh unlocks consume one shared allowance; previews remain hidden before unlock', async () => {
  const b = setup(); b.cache(1);
  const locked = await b.service.state(b.request({ videoIds: [id(1)] }));
  assert.equal(locked.videos[0].ready, true);
  assert.equal(locked.videos[0].unlocked, false);
  assert.equal(locked.videos[0].shortSummary, undefined);
  const cached = await b.service.unlock(b.request(b.video(1)));
  assert.equal(cached.allowance.used, 1); assert.equal(cached.fromCache, true); assert.equal(b.calls, 0);
  const fresh = await b.service.unlock(b.request(b.video(2)));
  assert.equal(fresh.allowance.used, 2); assert.equal(b.calls, 1);
  const visible = await b.service.state(b.request({ videoIds: [id(1)] }));
  assert.equal(visible.videos[0].shortSummary, ready.shortSummary);
});

test('reopens on later days are free and the reading allowance resets at midnight IST', async () => {
  const b = setup({ time: '2026-10-23T18:29:59Z' }); b.cache(1); b.cache(2);
  await b.service.unlock(b.request(b.video(1)));
  let result = await b.service.state(b.request({ videoIds: [] }));
  assert.equal(result.allowance.day, '2026-10-23'); assert.equal(result.allowance.used, 1);
  assert.equal(result.allowance.resetsAt, '2026-10-23T18:30:00.000Z');
  b.setTime('2026-10-23T18:30:00Z');
  result = await b.service.unlock(b.request(b.video(1)));
  assert.equal(result.allowance.day, '2026-10-24'); assert.equal(result.allowance.used, 0);
  result = await b.service.unlock(b.request(b.video(2)));
  assert.equal(result.allowance.used, 1);
});

test('concurrent opens charge once and simultaneous final slots cannot exceed the daily limit', async () => {
  const b = setup(); b.cache(1);
  await Promise.all(Array.from({length: 8}, () => b.service.unlock(b.request(b.video(1)))));
  assert.equal(b.docs.get('quotas/u').unlockCount, 1);
  b.docs.set('quotas/u', { unlockDay: '2026-10-23', unlockCount: 9 }); b.cache(2); b.cache(3);
  const results = await Promise.allSettled([b.service.unlock(b.request(b.video(2))), b.service.unlock(b.request(b.video(3)))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(b.docs.get('quotas/u').unlockCount, 10);
  await b.service.unlock(b.request(b.video(1))); // An old unlock still opens when the day is exhausted.
});

test('failed generation releases its reservation and does not charge reading allowance', async () => {
  const b = setup({ fail: true });
  await assert.rejects(b.service.unlock(b.request(b.video(1))), /Provider failed/);
  assert.equal(b.docs.get('quotas/u').unlockCount || 0, 0);
  assert.deepEqual(b.docs.get('quotas/u').unlockReservations, {});
  assert.equal(b.docs.has(`users/u/summaryUnlocks/${id(1)}`), false);
  assert.equal(b.docs.get('summaryGenerationBudgets/2026-10-23').attempts, 1);
});

test('Pro and trial receive 50, expired accounts receive 10, and verified developer bypasses the allowance', async () => {
  for (const [data, limit] of [[{isPro:true},50], [{trialEndsAt:'2099-01-01'},50], [{isPro:true,proUntil:'2000-01-01'},10]]) {
    const b = setup(); b.docs.set('users/u', data);
    assert.equal((await b.service.state(b.request({videoIds:[]}))).allowance.limit, limit);
  }
  const b = setup({ developer: true }); b.cache(1); b.docs.set('quotas/u',{unlockDay:'2026-10-23',unlockCount:10});
  const result = await b.service.unlock(b.request(b.video(1)));
  assert.equal(result.allowance.developer,true); assert.equal(result.allowance.used,10);
});

test('background preparation is private, bounded, and does not consume reading allowance', async () => {
  const b = setup({pro:true,policy:{preparationPerAccount:1}});
  const result = await b.service.prepare(b.request({}),b.video(1));
  assert.deepEqual(result,{videoId:id(1),ready:true}); assert.equal(b.docs.has('quotas/u'),false);
  assert.equal((await b.service.state(b.request({videoIds:[id(1)]}))).videos[0].shortSummary,undefined);
  await assert.rejects(b.service.prepare(b.request({}),b.video(2)),{code:'resource-exhausted'});
  const opened = await b.service.unlock(b.request(b.video(1)));
  assert.equal(opened.allowance.used,1); assert.equal(b.calls,1);
  const free = setup(); await assert.rejects(free.service.prepare(free.request({}),free.video(1)),{code:'permission-denied'});
});

test('simultaneous users share one generation and each pays their own unlock', async () => {
  const b = setup(); b.docs.set('users/other',{isPro:true});
  const results = await Promise.all([b.service.unlock(b.request(b.video(1))),b.service.unlock(b.request(b.video(1),'other'))]);
  assert.equal(b.calls,1); assert.equal(results[0].allowance.used,1); assert.equal(results[1].allowance.used,1);
});

test('existing explicit opens are grandfathered, but another account receives no entitlement', async () => {
  const b = setup(); b.cache(1);
  b.docs.set('users/u/summaryOpens/old',{videoId:id(1)});
  assert.equal((await b.service.state(b.request({videoIds:[id(1)]}))).videos[0].unlocked,true);
  assert.equal((await b.service.unlock(b.request(b.video(1)))).allowance.used,0);
  assert.equal((await b.service.state(b.request({videoIds:[id(1)]},'other'))).videos[0].shortSummary,undefined);
});

test('email generation uses a separate internal account budget and never consumes reading allowance', async () => {
  const b = setup({pro:true});
  await b.service.generated(b.video(1),'u','email');
  assert.equal(b.docs.has('quotas/u'),false);
  assert.equal(b.docs.get('summaryGenerationAccounts/2026-10-23_u_email').attempts,1);
  assert.equal(b.docs.has('summaryGenerationAccounts/2026-10-23_u'),false);
});

test('global budgets stop new AI work but leave cached unlocks available', async () => {
  const b = setup({policy:{generationGlobal:0}}); b.cache(1);
  await assert.rejects(b.service.unlock(b.request(b.video(2))),{code:'resource-exhausted'});
  assert.equal((await b.service.unlock(b.request(b.video(1)))).allowance.used,1);
});

test('a waiting background lease does not occupy all capacity for explicit Pro requests', async () => {
  let finish;
  const b = setup({pro:true,generate: video => video.videoId === id(1) ? new Promise(resolve => {finish=resolve;}) : Promise.resolve({...ready})});
  const background = b.service.prepare(b.request({}),b.video(1));
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const result = await b.service.unlock(b.request(b.video(2)));
  assert.equal(result.allowance.used,1);
  finish({...ready}); await background;
});

test('two function instances coalesce the same video through the shared Firestore lease', async () => {
  const b = setup(); b.docs.set('users/other',{isPro:true});
  const second = b.second();
  await Promise.all([b.service.unlock(b.request(b.video(1))),second.unlock(b.request(b.video(1),'other'))]);
  assert.equal(b.calls,1);
  assert.equal(b.docs.get('quotas/u').unlockCount,1);
  assert.equal(b.docs.get('quotas/other').unlockCount,1);
});

test('an incomplete AI result is not charged and failed retries stop at the internal video cap', async () => {
  const b = setup({generate:async () => ({shortSummary:ready.shortSummary})});
  for (let i=0;i<3;i++) await assert.rejects(b.service.unlock(b.request(b.video(1))),{code:'internal'});
  await assert.rejects(b.service.unlock(b.request(b.video(1))),{code:'unavailable'});
  assert.equal(b.calls,3); assert.equal(b.docs.has(`users/u/summaryUnlocks/${id(1)}`),false);
  assert.equal(b.docs.get('quotas/u').unlockCount || 0,0);
});

test('stale reservations expire and a crashed tab cannot hold the next day allowance', async () => {
  const b = setup(); b.cache(1);
  b.docs.set('quotas/u',{unlockDay:'2026-10-22',unlockCount:10,unlockReservations:{old:{day:'2026-10-22',expiresAt:Date.parse('2099-01-01')}}});
  assert.equal((await b.service.unlock(b.request(b.video(1)))).allowance.used,1);
  assert.deepEqual(b.docs.get('quotas/u').unlockReservations,{});
});
