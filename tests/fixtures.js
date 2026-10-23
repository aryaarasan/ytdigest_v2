/* Synthetic Firebase and YouTube responses. No production services are contacted. */
(function (global) {
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#193a48"/><circle cx="320" cy="180" r="100" fill="#39758b"/><path d="M290 125L380 180L290 235Z" fill="#d6f5ff"/></svg>');
  const ids = ['abcdefghij1', 'abcdefghij2', 'abcdefghij3', 'abcdefghij4'];
  const options = global.__fixtureOptions || {};
  const calls = [];
  const authHandlers = [];
  const cache = new Map([[ids[0], { shortSummary: '**Cached insight** ready to read.', detailedSummary: 'A detailed cached summary.', channel: 'Science', sections: [{ heading: 'The core idea', content: 'The cached explanation.' }] }]]);
  const userData = {
    channels: [{ id: 'channel-1', name: 'Science', thumbnail: svg }, { id: 'channel-2', name: 'News', thumbnail: svg }],
    timezone: 'Asia/Calcutta', country: 'IN', saved: [],
    ...(options.mode === 'trial' ? { trialEndsAt: '2099-01-01' } : { isPro: options.mode === 'pro' }),
    ...(options.mode === 'expired' ? { isPro: true, proUntil: '2000-01-01' } : {}),
  };
  const user = { uid: 'test-user', displayName: 'Sample User', email: 'sample@example.test', emailVerified: true, isAnonymous: options.mode === 'guest', providerData: [{ providerId: 'google.com' }] };
  const auth = {
    currentUser: user, onAuthStateChanged(fn) { authHandlers.push(fn); },
    signInWithPopup: async () => {}, signInAnonymously: async () => {}, signOut: async () => {},
  };
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            async get() { return name === 'users' ? { exists: true, data: () => userData } : { exists: cache.has(id), data: () => cache.get(id) }; },
            async set(data) { Object.assign(userData, data); },
            async update(data) { Object.assign(userData, data); },
            collection: name => db.collection(name),
          };
        },
        where(field, op, values) {
          return { async get() { return { forEach(fn) { values.forEach(id => { if (cache.has(id)) fn({ id, data: () => cache.get(id) }); }); } }; } };
        },
      };
    },
    async runTransaction(fn) { return fn({ get: ref => ref.get(), set: (ref, data) => ref.set(data) }); },
  };
  let active = 0;
  let maximumActive = 0;
  const opened = new Set();
  const functions = { httpsCallable(name) {
    return async data => {
      calls.push({ name, data });
      if (name === 'summarizeVideo') {
        active++; maximumActive = Math.max(maximumActive, active);
        try {
          if (options.summaryDelay) await new Promise(r => setTimeout(r, options.summaryDelay));
          if (options.failSummary) throw Object.assign(new Error('Summary failed'), { code: options.failSummary });
          const summary = { shortSummary: '**New insight** prepared automatically.', detailedSummary: 'A complete explanation.', keyPoints: ['One useful insight'], sections: [{ heading: 'The evidence', content: 'Detailed evidence from the video.' }], channel: data.channelName };
          cache.set(data.videoId, summary);
          return { data: summary };
        } finally { active--; }
      }
      if (name === 'recordSummaryOpen') { opened.add(data.videoId); return { data: { recorded: true } }; }
      if (name === 'getSummaryAnalytics') {
        const period = { total: opened.size, estimatedMinutesSaved: opened.size * 10, daily: [{ day: '2026-10-22', count: 0 }, { day: '2026-10-23', count: opened.size }], channels: opened.size ? [{ name: 'Science', count: opened.size }] : [] };
        return { data: { timezone: 'Asia/Calcutta', today: '2026-10-23', periods: { today: period, week: period, month: period } } };
      }
      if (name === 'askAboutVideo') return { data: { answer: 'An answer from the video.' } };
      return { data: {} };
    };
  } };
  function authFactory() { return auth; }
  authFactory.GoogleAuthProvider = function () {};
  function firestoreFactory() { return db; }
  firestoreFactory.FieldPath = { documentId: () => '__name__' };
  firestoreFactory.FieldValue = { serverTimestamp: () => 'now' };
  global.firebase = { initializeApp() {}, auth: authFactory, firestore: firestoreFactory, app: () => ({ functions: () => functions }) };
  global.fetch = async input => {
    const url = new URL(input, 'http://localhost');
    const params = url.searchParams;
    calls.push({ name: 'fetch', url: url.href });
    const snippet = i => ({ title: i === 1 ? "A creator's surprising discovery" : 'A useful video about science and the world', channelTitle: i < 2 ? 'Science' : 'News', channelId: i < 2 ? 'channel-1' : 'channel-2', publishedAt: `2026-10-${23 - i}T08:00:00Z`, thumbnails: { high: { url: svg }, default: { url: svg } } });
    let items = [];
    if (url.pathname.endsWith('/channels')) items = [{ contentDetails: { relatedPlaylists: { uploads: params.get('id') } }, snippet: { title: 'Science' } }];
    else if (url.pathname.endsWith('/playlistItems')) {
      const indexes = params.get('playlistId') === 'channel-1' ? [0, 1] : [2, 3];
      items = indexes.map(i => ({ snippet: { ...snippet(i), resourceId: { videoId: ids[i] } } }));
    } else if (url.pathname.endsWith('/videos')) {
      const selected = params.get('id') ? params.get('id').split(',') : ids;
      items = selected.map(id => ({ id, snippet: snippet(Math.max(0, ids.indexOf(id))), statistics: { viewCount: '12345' }, contentDetails: { duration: 'PT12M34S' } }));
    } else if (url.pathname.endsWith('/search')) {
      if (params.get('type') === 'channel') items = [{ id: { channelId: 'channel-new' }, snippet: { title: `${params.get('q')} Channel`, thumbnails: { default: { url: svg } } } }];
      else items = [{ id: { videoId: 'searchvid01' }, snippet: snippet(1) }];
    }
    return { ok: true, json: async () => ({ items }) };
  };
  global.__fixture = { calls, cache, userData, user, options, authHandlers, opened,
    get maximumActive() { return maximumActive; }, async signIn() { for (const fn of authHandlers) await fn(options.mode === 'signedout' ? null : user); },
  };
})(window);
