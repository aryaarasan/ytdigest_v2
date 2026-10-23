'use strict';
const { randomUUID } = require('node:crypto');
const { dayInTimezone, hasProAccess } = require('./summary-activity');

// Owner-editable overrides live in systemConfig/summaryAccess (never client writable).
const DEFAULT_POLICY = Object.freeze({
  preparationPerAccount: 10, preparationGlobal: 100, generationGlobal: 1000,
  freeAttempts: 20, proAttempts: 80, emailAttempts: 100, attemptsPerVideo: 3,
  concurrent: 4, backgroundConcurrent: 1, freeConcurrent: 1,
});
const validVideoId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);
const usable = value => typeof value?.shortSummary === 'string' && value.shortSummary.length > 20
  && ((typeof value.detailedSummary === 'string' && value.detailedSummary.trim())
    || (Array.isArray(value.sections) && value.sections.some(section => typeof section?.content === 'string' && section.content.trim()))
    || (Array.isArray(value.keyPoints) && value.keyPoints.some(point => typeof point === 'string' && point.trim())));
const content = value => ({ shortSummary: value.shortSummary, detailedSummary: value.detailedSummary || '',
  sections: Array.isArray(value.sections) ? value.sections : [], keyPoints: Array.isArray(value.keyPoints) ? value.keyPoints : [] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createSummaryAccess({ db, generate, isDeveloper, error, now = () => new Date(), wait = sleep, policy: overrides = {} }) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  let policyUntil = 0;
  const pending = new Map();
  const day = () => dayInTimezone(now(), 'Asia/Kolkata');
  const userRef = uid => db.collection('users').doc(uid);
  const unlockRef = (uid, id) => userRef(uid).collection('summaryUnlocks').doc(id);
  const cacheRef = id => db.collection('videoCache').doc(id);
  function auth(request) {
    if (!request.auth) throw error('unauthenticated', 'Sign in required.');
    return request.auth.uid;
  }
  async function settings() {
    if (now().getTime() < policyUntil) return;
    const doc = await db.collection('systemConfig').doc('summaryAccess').get();
    const values = doc.exists ? doc.data() : {};
    for (const key of Object.keys(DEFAULT_POLICY)) {
      const value = values[key];
      if (Number.isInteger(value) && value >= 0 && value <= 100000) policy[key] = value;
    }
    policyUntil = now().getTime() + 60000;
  }
  function balance(user, quota, developer) {
    const today = day();
    const limit = hasProAccess(user, now()) ? 50 : 10;
    const used = quota.unlockDay === today ? quota.unlockCount || 0 : 0;
    return { day: today, limit, used, remaining: Math.max(0, limit - used), developer,
      resetsAt: new Date(Date.parse(`${today}T00:00:00+05:30`) + 86400000).toISOString() };
  }
  async function legacy(uid, ids) {
    if (!ids.length) return new Set();
    const records = await userRef(uid).collection('summaryOpens').where('videoId', 'in', ids).get();
    return new Set(records.docs.map(doc => doc.data().videoId));
  }
  async function state(request) {
    const uid = auth(request);
    if (request.data?.videoIds !== undefined && !Array.isArray(request.data.videoIds)) throw error('invalid-argument', 'Choose a list of videos.');
    const ids = [...new Set(request.data?.videoIds || [])];
    if (ids.length > 30 || ids.some(id => !validVideoId(id))) throw error('invalid-argument', 'Choose up to 30 valid videos.');
    const [user, quota, old, docs] = await Promise.all([
      userRef(uid).get(), db.collection('quotas').doc(uid).get(), legacy(uid, ids),
      ids.length ? db.getAll(...ids.flatMap(id => [unlockRef(uid, id), cacheRef(id)])) : [],
    ]);
    const developer = isDeveloper(request);
    return { allowance: balance(user.exists ? user.data() : {}, quota.exists ? quota.data() : {}, developer),
      videos: ids.map((id, index) => {
        const unlocked = docs[index * 2].exists || old.has(id);
        const cached = docs[index * 2 + 1];
        const ready = cached.exists && usable(cached.data());
        return { videoId: id, unlocked, ready: !!ready,
          ...(unlocked && ready ? content(cached.data()) : {}) };
      }) };
  }
  function activeReservations(quota) {
    return Object.fromEntries(Object.entries(quota.unlockReservations || {}).filter(([, value]) => value.expiresAt > now().getTime() && value.day === day()));
  }
  async function reserve(request, videoId, previous) {
    const uid = auth(request);
    const ref = db.collection('quotas').doc(uid);
    return db.runTransaction(async tx => {
      const [u, q, unlocked] = await Promise.all([tx.get(userRef(uid)), tx.get(ref), tx.get(unlockRef(uid, videoId))]);
      const allowance = balance(u.exists ? u.data() : {}, q.exists ? q.data() : {}, isDeveloper(request));
      if (unlocked.exists || previous || allowance.developer) return { allowance, exempt: true };
      const reservations = activeReservations(q.exists ? q.data() : {});
      if (reservations[videoId]) return { allowance, reservation: reservations[videoId] };
      if (allowance.used + Object.keys(reservations).length >= allowance.limit) throw error('resource-exhausted', `Daily allowance of ${allowance.limit} reached. Resets at 12:00 AM IST. Previously unlocked summaries remain available.`);
      const reservation = { token: randomUUID(), day: day(), expiresAt: now().getTime() + 180000 };
      reservations[videoId] = reservation;
      // Replacing the map removes expired entries; other quota fields are preserved.
      tx.set(ref, { ...(q.exists ? q.data() : {}), unlockReservations: reservations });
      return { allowance, reservation };
    });
  }
  async function release(uid, videoId, reservation) {
    if (!reservation) return;
    const ref = db.collection('quotas').doc(uid);
    await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) return;
      const value = doc.data();
      if (value.unlockReservations?.[videoId]?.token !== reservation.token) return;
      delete value.unlockReservations[videoId];
      tx.set(ref, value);
    });
  }
  async function commit(request, videoId, previous, summary) {
    const uid = request.auth.uid;
    const ref = db.collection('quotas').doc(uid);
    return db.runTransaction(async tx => {
      const [u, q, unlocked] = await Promise.all([tx.get(userRef(uid)), tx.get(ref), tx.get(unlockRef(uid, videoId))]);
      const value = q.exists ? q.data() : {};
      const allowance = balance(u.exists ? u.data() : {}, value, isDeveloper(request));
      if (unlocked.exists) return allowance;
      const charge = !previous && !allowance.developer;
      if (charge && allowance.remaining <= 0) throw error('resource-exhausted', 'Daily allowance reached. Resets at 12:00 AM IST. No allowance was deducted.');
      const reservations = activeReservations(value);
      delete reservations[videoId];
      tx.set(ref, { ...value, unlockDay: day(), unlockCount: allowance.used + (charge ? 1 : 0), unlockReservations: reservations });
      tx.set(unlockRef(uid, videoId), { videoId, unlockedAt: now().toISOString(), unlockedDay: day(), grandfathered: previous,
        prepared: summary.preparationKind === 'background', cacheHit: !!summary.fromCache, waitMs: summary.waitMs || 0 });
      return { ...allowance, used: allowance.used + (charge ? 1 : 0), remaining: allowance.remaining - (charge ? 1 : 0) };
    });
  }
  async function generated(video, uid, kind, developer = false) {
    const initial = await cacheRef(video.videoId).get();
    if (initial.exists && usable(initial.data())) return { ...initial.data(), fromCache: true };
    // A request can join an in-process job; the Firestore lease also coalesces across instances.
    if (pending.has(video.videoId)) return pending.get(video.videoId);
    const task = runGeneration(video, uid, kind, developer).finally(() => pending.delete(video.videoId));
    pending.set(video.videoId, task);
    return task;
  }
  async function runGeneration(video, uid, kind, developer) {
    await settings();
    const jobRef = db.collection('summaryGenerationJobs').doc(video.videoId);
    const globalRef = db.collection('summaryGenerationBudgets').doc(day());
    const accountRef = db.collection('summaryGenerationAccounts').doc(`${day()}_${uid}${kind === 'email' ? '_email' : ''}`);
    const token = randomUUID();
    let owner = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      const decision = await db.runTransaction(async tx => {
        const [cached, job, global, account, user] = await Promise.all([tx.get(cacheRef(video.videoId)), tx.get(jobRef), tx.get(globalRef), tx.get(accountRef), tx.get(userRef(uid))]);
        if (cached.exists && usable(cached.data())) return { cached: cached.data() };
        const j = job.exists ? job.data() : {};
        if (j.expiresAt > now().getTime()) return { wait: true };
        const g = global.exists ? global.data() : {};
        const a = account.exists ? account.data() : {};
        const pro = hasProAccess(user.exists ? user.data() : {}, now());
        if (kind === 'background' && !pro && !developer) throw error('permission-denied', 'Advance preparation is a Pro feature.');
        if ((g.attempts || 0) >= policy.generationGlobal || (kind === 'background' && ((g.background || 0) >= policy.preparationGlobal || (a.background || 0) >= policy.preparationPerAccount))) throw error('resource-exhausted', 'Advance preparation or service budget reached. Your reading allowance is unchanged.');
        if (!developer && (a.attempts || 0) >= (kind === 'email' ? policy.emailAttempts : pro ? policy.proAttempts : policy.freeAttempts)) throw error('resource-exhausted', 'Generation retry budget reached. Previously unlocked summaries remain available.');
        const videoAttempts = j.day === day() ? j.attempts || 0 : 0;
        if (videoAttempts >= policy.attemptsPerVideo) throw error('unavailable', 'This video could not be prepared. Please try again tomorrow; no reading allowance was used.');
        const active = Object.fromEntries(Object.entries(g.active || {}).filter(([, lease]) => lease.expiresAt > now().getTime()));
        const leases = Object.values(active);
        if (leases.length >= policy.concurrent || (kind !== 'interactive' && leases.filter(lease => lease.kind !== 'interactive').length >= policy.backgroundConcurrent) || (kind === 'interactive' && !pro && !developer && leases.filter(lease => lease.free).length >= policy.freeConcurrent)) return { busy: true };
        active[token] = { kind, free: !pro && !developer, expiresAt: now().getTime() + 150000 };
        tx.set(globalRef, { ...g, attempts: (g.attempts || 0) + 1, background: (g.background || 0) + (kind === 'background' ? 1 : 0), active });
        tx.set(accountRef, { ...a, attempts: (a.attempts || 0) + 1, background: (a.background || 0) + (kind === 'background' ? 1 : 0) });
        tx.set(jobRef, { day: day(), attempts: videoAttempts + 1, token, expiresAt: now().getTime() + 150000 });
        return { acquired: true };
      });
      if (decision.cached) return { ...decision.cached, fromCache: true };
      if (decision.acquired) { owner = true; break; }
      if (kind === 'background' && decision.busy) throw error('unavailable', 'Preparation paused while readers are being served.');
      await wait(900);
    }
    if (!owner) throw error('unavailable', 'Summary preparation is taking longer than expected. Please retry; no reading allowance was used.');
    let result;
    try {
      result = await generate(video);
      if (!usable(result)) throw error('internal', 'AI did not return a usable summary. Please try again.');
      result.preparationKind = kind;
      // A successful cache write is required before granting a permanent unlock.
      await cacheRef(video.videoId).set({ ...result, videoId: video.videoId, title: video.title, channel: video.channelName || '',
        date: (video.publishedAt || '').slice(0, 10), videoUrl: video.videoUrl || '', cachedAt: now().toISOString() }, { merge: true });
      return { ...result, fromCache: false };
    } finally {
      await db.runTransaction(async tx => {
        const [job, global] = await Promise.all([tx.get(jobRef), tx.get(globalRef)]);
        const g = global.exists ? global.data() : {};
        const active = { ...(g.active || {}) }; delete active[token];
        tx.set(globalRef, { ...g, active, completed: (g.completed || 0) + (usable(result) ? 1 : 0),
          promptTokens: (g.promptTokens || 0) + (Number(result?.usage?.prompt_tokens) || 0),
          completionTokens: (g.completionTokens || 0) + (Number(result?.usage?.completion_tokens) || 0) });
        if (job.exists && job.data().token === token) tx.set(jobRef, { ...job.data(), expiresAt: 0 });
      });
    }
  }
  async function unlock(request) {
    const uid = auth(request);
    const video = request.data || {};
    if (!validVideoId(video.videoId)) throw error('invalid-argument', 'A valid video is required.');
    const old = await legacy(uid, [video.videoId]);
    const held = await reserve(request, video.videoId, old.has(video.videoId));
    const started = now().getTime();
    try {
      const generatedSummary = await generated(video, uid, 'interactive', isDeveloper(request));
      const summary = { ...generatedSummary, waitMs: now().getTime() - started };
      const allowance = await commit(request, video.videoId, old.has(video.videoId), summary);
      return { ...content(summary), fromCache: summary.fromCache, unlocked: true, allowance, waitMs: now().getTime() - started };
    } catch (failure) {
      await release(uid, video.videoId, held.reservation);
      throw failure;
    }
  }
  async function prepare(request, video) {
    const uid = auth(request);
    await generated(video, uid, 'background', isDeveloper(request));
    // Never return any content from a background request.
    return { videoId: video.videoId, ready: true };
  }
  async function hasAccess(uid, id) {
    const unlocked = await unlockRef(uid, id).get();
    return unlocked.exists || (await legacy(uid, [id])).has(id);
  }
  return { state, unlock, prepare, generated, hasAccess };
}
module.exports = { createSummaryAccess, DEFAULT_POLICY, validVideoId, content, usable };
