(function (root) {
  'use strict';
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  // HTML attribute escaping alone does not quote a JavaScript string literal.
  const jsArg = value => html(JSON.stringify(String(value ?? '')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
  const videoUrl = id => typeof id === 'string' && /^[\w-]{11}$/.test(id) ? 'https://www.youtube.com/watch?v=' + id : '';
  function checkoutUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.lemonsqueezy.com') && !url.username && !url.password ? url.href : ''; }
    catch { return ''; }
  }
  function imageUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      if (!['i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname) && !/^lh\d+\.googleusercontent\.com$/.test(url.hostname)) return '';
      return url.href;
    } catch { return ''; }
  }
  // YouTube search results return titles with HTML entities (e.g. &#39;). Decode the
  // small known set once, to plain text; html() escapes it again when rendering.
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function text(value) {
    return String(value ?? '').replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, (match, code) => {
      const key = code.toLowerCase();
      if (named[key]) return named[key];
      const point = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : match;
    });
  }
  // "3d ago", "5 months ago", "11 years ago". Shared by both editions.
  function age(value, now = Date.now()) {
    const time = new Date(value).getTime();
    if (!value || !Number.isFinite(time)) return '';
    const minutes = Math.floor(Math.max(0, now - time) / 60000);
    if (minutes < 60) return minutes < 1 ? 'Just now' : `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    if (days < 365) { const months = Math.floor(days / 30); return `${months} ${months === 1 ? 'month' : 'months'} ago`; }
    const years = Math.floor(days / 365);
    return `${years} ${years === 1 ? 'year' : 'years'} ago`;
  }
  // Videos worth offering for a summary: not live or upcoming, and not a Short
  // (under a minute), which rarely has enough speech. Takes a YouTube API item.
  function summarisable(item) {
    const live = item?.snippet?.liveBroadcastContent;
    if (live && live !== 'none') return false;
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(item?.contentDetails?.duration || '');
    if (!m) return true; // Unknown length: keep it rather than hide a real video.
    const seconds = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
    return seconds >= 60;
  }
  const api = { html, text, jsArg, videoUrl, imageUrl, checkoutUrl, age, summarisable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SafeContent = api;
})(typeof globalThis === 'object' ? globalThis : this);
