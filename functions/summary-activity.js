'use strict';

function validTimezone(value) {
  try {
    if (typeof value === 'string' && value.length < 100) {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return value;
    }
  } catch (_) {}
  return 'UTC';
}

function dayInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: validTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function periodBounds(today) {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return { today, week: date.toISOString().slice(0, 10), month: today.slice(0, 7) + '-01' };
}

function hasProAccess(data, now = new Date()) {
  const asDate = raw => raw ? new Date(raw.toDate ? raw.toDate() : raw) : null;
  const trialEnd = asDate(data.trialEndsAt);
  const paidEnd = asDate(data.proUntil);
  return !!((trialEnd && trialEnd > now) || (data.isPro === true && (!paidEnd || paidEnd > now)));
}

function durationSeconds(iso) {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
  return match ? Math.floor((+match[1] || 0) * 86400 + (+match[2] || 0) * 3600 + (+match[3] || 0) * 60 + (+match[4] || 0)) : 0;
}

function readingMetrics(summary, duration) {
  // Sections and legacy detailedSummary are alternative breakdown formats, not additive.
  const breakdown = Array.isArray(summary.sections) && summary.sections.length
    ? summary.sections.map(section => `${section.heading || ''} ${section.content || ''}`).join(' ')
    : [summary.detailedSummary || '', ...(Array.isArray(summary.keyPoints) ? summary.keyPoints : [])].join(' ');
  const words = `${summary.shortSummary || ''} ${breakdown}`.replace(/\*\*/g, '').trim().split(/\s+/).filter(Boolean).length;
  const readingSeconds = Math.ceil(words / 200 * 60);
  const seconds = Number(duration);
  const known = Number.isFinite(seconds) && seconds > 0 && seconds <= 604800;
  const videoSeconds = known ? seconds : 900;
  return { videoSeconds, readingSeconds, durationEstimated: !known,
    estimatedSavedSeconds: Math.max(0, videoSeconds - readingSeconds), metricsVersion: 2 };
}

// Each video counts once in the selected period, even if opened on several days.
// The daily chart counts distinct videos on each day independently.
function aggregateActivity(records, today) {
  const bounds = periodBounds(today);
  const periods = {};
  for (const [period, start] of Object.entries(bounds)) {
    const days = {};
    const cursor = new Date(`${start}T12:00:00Z`);
    while (cursor.toISOString().slice(0, 10) <= today) {
      days[cursor.toISOString().slice(0, 10)] = new Set();
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const videos = new Map();
    for (const record of records) {
      if (!days[record.day] || !record.videoId) continue;
      days[record.day].add(record.videoId);
      videos.set(record.videoId, record);
    }
    const channels = new Map();
    const topics = new Map();
    let savedSeconds = 0;
    let classifiedVideos = 0;
    for (const record of videos.values()) {
      const channel = record.channel || 'Unknown channel';
      channels.set(channel, (channels.get(channel) || 0) + 1);
      savedSeconds += Math.max(0, Number(record.estimatedSavedSeconds) || 0);
      const labels = [...new Set(Array.isArray(record.topics) ? record.topics : [])].filter(label => typeof label === 'string' && label.trim());
      if (labels.length) classifiedVideos++;
      for (const label of labels) topics.set(label, (topics.get(label) || 0) + 1);
    }
    periods[period] = {
      total: videos.size,
      estimatedMinutesSaved: Math.round(savedSeconds / 60),
      estimatedSavedSeconds: savedSeconds,
      classifiedVideos,
      topics: [...topics].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
        .map(([name, count]) => ({ name, count, percentage: Math.round(count / videos.size * 100) })),
      daily: Object.entries(days).map(([day, ids]) => ({ day, count: ids.size })),
      channels: [...channels].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    };
  }
  return periods;
}

module.exports = { validTimezone, dayInTimezone, periodBounds, hasProAccess, aggregateActivity, durationSeconds, readingMetrics };
