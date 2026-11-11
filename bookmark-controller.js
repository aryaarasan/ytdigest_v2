/* Shared candidate for index.html and youtube.html. Default remains disabled.
 * Both editions wire this candidate behind a hardcoded disabled selection.
 * Never falls back to saved[] writes after a server error. */
(function (global) {
  'use strict';
  function create({ selection = 'disabled', call, getUser, onChange = () => {}, pageSize = 25 } = {}) {
    let uid = null, epoch = 0, items = new Map(), nextCursor = null, busy = false;
    function snapshot() { return { items: [...items.values()], nextCursor, busy, sessionVersion: epoch }; }
    function reset() { epoch++; uid = getUser?.()?.uid || null; items = new Map(); nextCursor = null; busy = false; onChange(snapshot()); }
    function session() {
      if (selection !== 'subcollection-v1') throw new Error('Bookmark storage is disabled.');
      const current = getUser?.()?.uid;
      if (current !== uid) reset();
      if (!current) throw new Error('Sign in to use bookmarks.');
      return { uid: current, epoch };
    }
    function current(token) { return token.epoch === epoch && token.uid === getUser?.()?.uid; }
    async function run(payload, apply) {
      const token = session();
      if (busy) throw new Error('A bookmark request is in progress.');
      busy = true; onChange(snapshot());
      try {
        const result = await call(payload);
        if (!current(token)) { if (token.epoch === epoch) reset(); return { stale: true }; }
        apply(result.data); onChange(snapshot()); return result.data;
      } finally {
        if (current(token)) { busy = false; onChange(snapshot()); }
        else if (token.epoch === epoch) reset();
      }
    }
    return {
      enabled: selection === 'subcollection-v1', reset, snapshot,
      status: videoId => run({ operation: 'status', videoId }, () => {}),
      refresh: () => run({ operation: 'list', limit: pageSize }, data => {
        items = new Map(data.items.map(item => [item.videoId, item])); nextCursor = data.nextCursor;
      }),
      more: () => {
        session();
        if (!nextCursor) return Promise.resolve(snapshot());
        return run({ operation: 'list', limit: pageSize, cursor: nextCursor }, data => {
          data.items.forEach(item => items.set(item.videoId, item)); nextCursor = data.nextCursor;
        });
      },
      save: bookmark => run({ operation: 'save', bookmark }, data => { items.set(data.bookmark.videoId, data.bookmark); }),
      remove: videoId => run({ operation: 'remove', videoId }, () => { items.delete(videoId); }),
    };
  }
  // Registries also contain transient summary/UI fields; send only the storage schema.
  function metadata(video) {
    const fields = ['videoId', 'title', 'channel', 'channelId', 'videoUrl', 'thumbnail',
      'publishedAt', 'date', 'durationSeconds', 'durationLabel', 'shortSummary',
      'detailedSummary', 'keyPoints', 'sections'];
    return Object.fromEntries(fields.filter(key => video[key] !== undefined).map(key => [key, video[key]]));
  }
  const api = { create, metadata };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.BookmarkController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
