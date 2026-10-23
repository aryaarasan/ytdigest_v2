'use strict';
const { durationSeconds, readingMetrics } = require('./summary-activity');

function topicLabels(urls, category) {
  const generic = new Set(['Knowledge', 'Society', 'Lifestyle', 'Entertainment']);
  const labels = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    try {
      const url = new URL(raw);
      if (!/(^|\.)wikipedia\.org$/.test(url.hostname) || !url.pathname.startsWith('/wiki/')) continue;
      const label = decodeURIComponent(url.pathname.slice(6)).replace(/_/g, ' ').trim();
      if (label && label.length <= 100) labels.push(label);
    } catch (_) {}
  }
  const specific = labels.filter(label => !generic.has(label));
  return [...new Set(specific.length ? specific : category ? [category] : labels)];
}

function createVideoMetadata({ db, fetch, apiKey, log = console }) {
  const categories = new Map();
  const pending = new Map();
  async function request(path, params) {
    const query = new URLSearchParams({ ...params, key: apiKey });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${query}`, { timeout: 5000 });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error('Video metadata unavailable');
    return data.items || [];
  }

  async function loadUncached(videos) {
    const items = await request('videos', { part: 'contentDetails,snippet,topicDetails', id: videos.map(v => v.videoId).join(',') });
    const missingCategories = [...new Set(items.map(item => item.snippet?.categoryId).filter(id => id && !categories.has(id)))];
    if (missingCategories.length) {
      try {
        const results = await request('videoCategories', { part: 'snippet', id: missingCategories.join(','), hl: 'en_US' });
        results.forEach(item => categories.set(item.id, item.snippet?.title || ''));
      } catch (_) { /* Specific topics can still be used if category lookup fails. */ }
    }
    await Promise.all(items.map(async item => {
      const video = videos.find(v => v.videoId === item.id);
      if (!video) return;
      const update = {
        analyticsMetadataVersion: 2,
        analyticsDurationSeconds: durationSeconds(item.contentDetails?.duration),
        analyticsTopics: topicLabels(item.topicDetails?.topicCategories, categories.get(item.snippet?.categoryId)),
      };
      // Only metadata fields are merged; summaries and their generation cache stay intact.
      await db.collection('videoCache').doc(item.id).set(update, { merge: true });
      Object.assign(video, update);
    }));
  }

  async function enrich(videos) {
    const unique = [...new Map(videos.map(video => [video.videoId, video])).values()];
    const outstanding = [];
    const missing = unique.filter(video => {
      if (video.analyticsMetadataVersion === 2) return false;
      if (pending.has(video.videoId)) { outstanding.push(pending.get(video.videoId).then(value => Object.assign(video, value))); return false; }
      return true;
    });
    for (let start = 0; start < missing.length; start += 50) {
      const batch = missing.slice(start, start + 50);
      const task = loadUncached(batch).catch(() => log.warn('Analytics metadata unavailable; existing activity is preserved.'));
      batch.forEach(video => {
        const item = task.then(() => video).finally(() => pending.delete(video.videoId));
        pending.set(video.videoId, item);
      });
      await task;
    }
    await Promise.all(outstanding);
    return unique;
  }

  async function summary(videoId) {
    const doc = await db.collection('videoCache').doc(videoId).get();
    if (!doc.exists || !doc.data().shortSummary) return null;
    const video = { ...doc.data(), videoId };
    await enrich([video]);
    return video;
  }

  async function repairActivity(records) {
    // Bound legacy repair work so a large history cannot hold up the dashboard.
    const ids = [...new Set(records.filter(record => record.metricsVersion !== 2 || record.metadataVersion !== 2).map(record => record.videoId))].slice(0, 100);
    const summaries = new Map();
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const docs = await db.getAll(...batch.map(id => db.collection('videoCache').doc(id)));
      docs.forEach((doc, index) => { if (doc.exists && doc.data().shortSummary) summaries.set(batch[index], { ...doc.data(), videoId: batch[index] }); });
    }
    await enrich([...summaries.values()]);
    await Promise.all(records.map(async record => {
      const video = summaries.get(record.videoId);
      if (!video) return;
      const update = { ...readingMetrics(video, video.analyticsDurationSeconds), topics: video.analyticsTopics || [], metadataVersion: 2 };
      // Do not permanently upgrade an estimate if YouTube metadata could not be retrieved.
      if (video.analyticsMetadataVersion !== 2) return;
      await record.ref.set(update, { merge: true });
      Object.assign(record, update);
    }));
    return records;
  }
  return { summary, repairActivity };
}

module.exports = { createVideoMetadata, topicLabels };
