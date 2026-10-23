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
    let savedSeconds = 0;
    for (const record of videos.values()) {
      const channel = record.channel || 'Unknown channel';
      channels.set(channel, (channels.get(channel) || 0) + 1);
      savedSeconds += Math.max(0, Number(record.estimatedSavedSeconds) || 0);
    }
    periods[period] = {
      total: videos.size,
      estimatedMinutesSaved: Math.round(savedSeconds / 60),
      daily: Object.entries(days).map(([day, ids]) => ({ day, count: ids.size })),
      channels: [...channels].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    };
  }
  return periods;
}

module.exports = { validTimezone, dayInTimezone, periodBounds, hasProAccess, aggregateActivity };
