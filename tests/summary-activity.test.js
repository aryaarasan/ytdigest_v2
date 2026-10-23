const test = require('node:test');
const assert = require('node:assert/strict');
const { validTimezone, dayInTimezone, periodBounds, hasProAccess, aggregateActivity } = require('../functions/summary-activity');
const { readingMetrics } = require('../functions/summary-activity');
const { topicLabels } = require('../functions/video-metadata');

test('dates follow the user timezone around midnight and daylight saving', () => {
  assert.equal(dayInTimezone(new Date('2026-10-22T20:00:00Z'), 'Asia/Calcutta'), '2026-10-23');
  assert.equal(dayInTimezone(new Date('2026-11-01T06:30:00Z'), 'America/New_York'), '2026-11-01');
  assert.equal(validTimezone('invalid-timezone'), 'UTC');
  assert.deepEqual(periodBounds('2026-11-01'), { today: '2026-11-01', week: '2026-10-26', month: '2026-11-01' });
});

test('totals deduplicate a video across days while daily activity remains accurate', () => {
  const records = [
    { videoId: 'a', day: '2026-10-22', channel: 'Science', estimatedSavedSeconds: 600 },
    { videoId: 'a', day: '2026-10-23', channel: 'Science', estimatedSavedSeconds: 600 },
    { videoId: 'b', day: '2026-10-23', channel: 'News', estimatedSavedSeconds: 300 },
    { videoId: 'a', day: '2026-10-23', channel: 'Science', estimatedSavedSeconds: 600 },
    { videoId: 'old', day: '2026-09-23', channel: 'Old' },
  ];
  const result = aggregateActivity(records, '2026-10-23');
  assert.equal(result.today.total, 2);
  assert.equal(result.week.total, 2);
  assert.equal(result.month.total, 2);
  assert.equal(result.week.estimatedMinutesSaved, 15);
  assert.equal(result.week.daily.find(d => d.day === '2026-10-22').count, 1);
  assert.equal(result.week.daily.find(d => d.day === '2026-10-23').count, 2);
  assert.equal(result.week.daily[0].count, 0);
  assert.equal(result.month.channels.length, 2);
});

test('week and month can cross a year boundary without losing records', () => {
  const result = aggregateActivity([
    { videoId: 'old', day: '2026-12-31' }, { videoId: 'new', day: '2027-01-01' },
  ], '2027-01-01');
  assert.equal(result.week.total, 2);
  assert.equal(result.month.total, 1);
  assert.equal(result.today.total, 1);
});

test('analytics access honours trial and paid expiry without client privilege fields', () => {
  const now = new Date('2026-10-23T00:00:00Z');
  assert.equal(hasProAccess({}, now), false);
  assert.equal(hasProAccess({ isPro: true }, now), true);
  assert.equal(hasProAccess({ isPro: true, proUntil: '2026-10-22' }, now), false);
  assert.equal(hasProAccess({ trialEndsAt: '2026-10-24' }, now), true);
  assert.equal(hasProAccess({ trialEndsAt: { toDate: () => new Date('2026-10-22') } }, now), false);
});

test('topic rankings count a video once per topic and return only the top three', () => {
  const records = [
    { videoId: 'a', day: '2026-10-22', topics: ['Science', 'Technology', 'Science'] },
    { videoId: 'a', day: '2026-10-23', topics: ['Science', 'Technology'] },
    { videoId: 'b', day: '2026-10-23', topics: ['Science', 'Business'] },
    { videoId: 'c', day: '2026-10-23', topics: ['Health'] },
  ];
  const result = aggregateActivity(records, '2026-10-23').month;
  assert.equal(result.total, 3);
  assert.equal(result.topics.length, 3);
  assert.equal(result.topics[0].name, 'Science');
  assert.equal(result.topics[0].count, 2);
  assert.equal(result.topics[0].percentage, 67);
  assert.equal(result.classifiedVideos, 3);
});

test('specific YouTube topics take precedence over generic parents and fall back to category', () => {
  assert.deepEqual(topicLabels(['https://en.wikipedia.org/wiki/Knowledge', 'https://en.wikipedia.org/wiki/Artificial_intelligence'], 'Education'), ['Artificial intelligence']);
  assert.deepEqual(topicLabels(['https://en.wikipedia.org/wiki/Knowledge'], 'Science & Technology'), ['Science & Technology']);
  assert.deepEqual(topicLabels(['https://example.test/wiki/Untrusted'], ''), []);
});

test('reading time uses the displayed breakdown format once and preserves second-level savings', () => {
  const summary = { shortSummary: 'word '.repeat(20), detailedSummary: 'word '.repeat(1000), sections: [{ content: 'word '.repeat(80) }] };
  const result = readingMetrics(summary, 58);
  assert.equal(result.readingSeconds, 30);
  assert.equal(result.estimatedSavedSeconds, 28);
  assert.equal(readingMetrics({ shortSummary: 'word '.repeat(300) }, 58).estimatedSavedSeconds, 0);
});
