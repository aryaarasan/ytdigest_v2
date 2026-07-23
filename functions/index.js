const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const { initializeApp }      = require('firebase-admin/app');
const { getFirestore }       = require('firebase-admin/firestore');
const fetch                  = require('node-fetch');
const nodemailer             = require('nodemailer');

initializeApp();
const db = getFirestore();

const SUPADATA_KEY   = defineSecret('SUPADATA_KEY');
const OPENROUTER_KEY = defineSecret('OPENROUTER_KEY');
const GMAIL_PASS     = defineSecret('GMAIL_PASS');
const LEMON_SQUEEZY_API_KEY = defineSecret('LEMON_SQUEEZY_API_KEY');
const LEMON_SQUEEZY_WEBHOOK_SECRET = defineSecret('LEMON_SQUEEZY_WEBHOOK_SECRET');

// ─── OpenRouter config ────────────────────────────────────────────────────────
// Using OpenAI-compatible Chat Completions API via OpenRouter.
// Model: google/gemini-2.5-flash (same quality as direct Gemini, pay-as-you-go)
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL    = 'google/gemini-2.5-flash';

function openRouterHeaders(key) {
  return {
    'Authorization':  'Bearer ' + key.trim(),
    'Content-Type':   'application/json',
    'HTTP-Referer':   'https://aryaarasan.github.io/ytdigest_v2/',
    'X-Title':        'YTDigest',
  };
}
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_CHARS = 20000;

const CORS_ORIGINS = [
  'https://aryaarasan.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

// ─── DEV BYPASS ──────────────────────────────────────────────────────────────
// Add your Firebase UIDs here to skip all quota/rate-limit checks.
// Find your UID in Firebase Console → Authentication → Users, or log it via
// console.log(request.auth.uid) in a function call.
// Anonymous UIDs are stable per device (stored in IndexedDB by the Firebase SDK).
const DEV_UIDS = new Set([
  'bSK3dQARB3PRAbe7notSr9gZP5N2',
  '9DzujGsyn9SmkpZURFOXt0qCwzG2',
  'VYALfUEjSMWIOThdC7zXUYoZegM2',
]);

function isDev(request) {
  return DEV_UIDS.has(request.auth?.uid);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Daily per-user quota (AI summary calls) ─────────────────────────────────
// 10 summaries for free users, 50 for Pro users. Resets at midnight UTC.
// proUntil is enforced here: if a paid sub lapses (webhook missed), the
// stored isPro:true is overridden and the user drops to the free limit.
async function checkAndIncrementQuota(uid) {
  const dayKey   = getDayKey();
  const now      = new Date();
  const quotaRef = db.collection('quotas').doc(uid);
  const userRef  = db.collection('users').doc(uid);

  return db.runTransaction(async (tx) => {
    const userDoc = await tx.get(userRef);
    const d = userDoc.exists ? userDoc.data() : {};

    // Trial check
    const rawTrialEnd = d.trialEndsAt;
    const trialEndsAt = rawTrialEnd
      ? new Date(rawTrialEnd.toDate ? rawTrialEnd.toDate() : rawTrialEnd)
      : null;
    const isOnTrial = trialEndsAt && trialEndsAt > now;

    // Paid subscription check — honour proUntil so lapsed subs are downgraded
    const rawProUntil = d.proUntil;
    const proUntil = rawProUntil
      ? new Date(rawProUntil.toDate ? rawProUntil.toDate() : rawProUntil)
      : null;
    // isPro is true only when: explicitly set AND (no expiry stored OR expiry in future)
    const isProPaid = d.isPro === true && (!proUntil || proUntil > now);
    const isPro = isProPaid || isOnTrial;
    const limit = isPro ? 50 : 10;

    const doc   = await tx.get(quotaRef);
    const data  = doc.exists ? doc.data() : {};
    const count = (data.day === dayKey ? data.count : 0) + 1;

    if (count > limit) {
      throw new HttpsError(
        'resource-exhausted',
        `Daily summary limit of ${limit} reached. Resets at midnight.`
      );
    }

    tx.set(quotaRef, { day: dayKey, count }, { merge: true });
    return count;
  });
}

// ─── Daily per-user quota (Ask AI calls) ─────────────────────────────────────
// 5 Ask AI questions/day for free users, unlimited for Pro. Resets at midnight UTC.
async function checkAndIncrementAskQuota(uid) {
  const dayKey   = getDayKey();
  const now      = new Date();
  const quotaRef = db.collection('quotas').doc(uid);
  const userRef  = db.collection('users').doc(uid);

  return db.runTransaction(async (tx) => {
    const userDoc = await tx.get(userRef);
    const d = userDoc.exists ? userDoc.data() : {};

    // Determine Pro status (same logic as summary quota)
    const rawTrialEnd = d.trialEndsAt;
    const trialEndsAt = rawTrialEnd
      ? new Date(rawTrialEnd.toDate ? rawTrialEnd.toDate() : rawTrialEnd)
      : null;
    const isOnTrial = trialEndsAt && trialEndsAt > now;
    const rawProUntil = d.proUntil;
    const proUntil = rawProUntil
      ? new Date(rawProUntil.toDate ? rawProUntil.toDate() : rawProUntil)
      : null;
    const isProPaid = d.isPro === true && (!proUntil || proUntil > now);
    const isPro = isProPaid || isOnTrial;

    // Pro users have unlimited Ask AI
    if (isPro) return;

    const ASK_LIMIT = 5;
    const doc  = await tx.get(quotaRef);
    const data = doc.exists ? doc.data() : {};
    const askCount = (data.askDay === dayKey ? data.askCount : 0) + 1;

    if (askCount > ASK_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        `Daily Ask AI limit of ${ASK_LIMIT} questions reached. Upgrade to Pro for unlimited questions, or wait until midnight.`
      );
    }

    // Write only the ask fields; keep the summary count intact
    tx.set(quotaRef, { askDay: dayKey, askCount }, { merge: true });
  });
}

async function logUserAnalytics(uid, channelName) {
  const d = new Date();
  const monthId = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const analyticsRef = db.collection('users').doc(uid).collection('quota').doc(monthId);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(analyticsRef);
      const data = doc.exists ? doc.data() : { total: 0, channels: {} };
      data.total = (data.total || 0) + 1;
      if (channelName) {
        data.channels = data.channels || {};
        data.channels[channelName] = (data.channels[channelName] || 0) + 1;
      }
      tx.set(analyticsRef, data, { merge: true });
    });
  } catch(e) {
    console.error('Analytics log error:', e.message);
  }
}

function getDayKey() {
  // UTC date string: YYYY-MM-DD
  return new Date().toISOString().slice(0, 10);
}
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
// FUNCTION 1: summarizeVideo
// =============================================================================
exports.summarizeVideo = onCall(
  {
    region: 'asia-south1', secrets: [SUPADATA_KEY, OPENROUTER_KEY],
    timeoutSeconds: 120, memory: '256MiB', cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const { videoId, title, channelName, publishedAt, videoUrl } = request.data;
    if (!videoId || !title) throw new HttpsError('invalid-argument', 'videoId and title required.');

    // Cache check — always serve from cache regardless of quota
    const cacheRef = db.collection('videoCache').doc(videoId);
    try {
      const cached = await cacheRef.get();
      if (cached.exists) {
        const d = cached.data();
        if (d.shortSummary && d.shortSummary.length > 20) {
          console.log('Cache hit:', videoId);
          await logUserAnalytics(request.auth.uid, channelName);
          return { fromCache: true, shortSummary: d.shortSummary, detailedSummary: d.detailedSummary || '', keyPoints: Array.isArray(d.keyPoints) ? d.keyPoints : [], sections: Array.isArray(d.sections) ? d.sections : [] };
        }
      }
    } catch(e) { console.log('Cache read error:', e.message); }

    // Quota check — skipped for dev UIDs
    if (!isDev(request)) {
      await checkAndIncrementQuota(request.auth.uid);
    } else {
      console.log('Dev UID — skipping quota check for', request.auth.uid);
    }

    const supKey = SUPADATA_KEY.value();
    const orKey  = OPENROUTER_KEY.value();

    // Fetch transcript
    const transcript = await fetchTranscript(videoId, supKey);
    if (transcript) {
      // Cache transcript for Ask tab
      db.collection('transcriptCache').doc(videoId)
        .set({ transcript, cachedAt: new Date().toISOString() })
        .catch(e => console.log('Transcript cache write error:', e.message));
    }

    const SYSTEM_PROMPT = `You are an expert at distilling YouTube videos into sharp, useful digests.
Your summaries are crisp, insightful, and avoid filler phrases like "In this video...", "The creator discusses...", or "This video covers...".
Lead with the most interesting, surprising, or counter-intuitive insight. Be direct and specific.`;

    const USER_PROMPT = `Analyze this video and return a JSON object with EXACTLY these three fields:
1. "short_summary": 2 punchy sentences. Start with the most surprising or important insight. Bold the single most impactful stat or claim using **double asterisks**.
2. "key_points": An array of 3-5 strings. Each string must be 15 words or fewer. Make them action-oriented or insight-driven. No bullet symbols in the strings.
3. "sections": An array of objects, each with a "heading" and "content". Create 3-4 sections adapting to the video type (e.g., "The Core Idea", "The Evidence", "Why It Matters"). Each content should be a comprehensive paragraph of 4-6 sentences, providing a deeper, more detailed dive into the content so no nuance is lost.
Rules: Return ONLY raw JSON. No markdown code fences. No explanation. No "In this video" or "The video" openers.
Example: {"short_summary":"**92% of forensic methods** lack scientific validation, yet courts treat them as infallible. Bite mark analysis alone has contributed to hundreds of wrongful convictions.","key_points":["Most forensic techniques have never been scientifically validated","Bite mark analysis wrongly convicted hundreds of innocent people","DNA evidence remains the only forensically sound method","Confirmation bias is endemic in forensic labs"],"sections":[{"heading":"The Core Idea","content":"The forensic science industry operates on assumption rather than evidence. Despite widespread use in criminal justice, techniques like bite mark analysis, hair matching, and blood spatter analysis have never been scientifically validated. This systemic failure has allowed junk science to dictate the outcomes of countless trials. Only nuclear DNA analysis actually meets rigorous scientific standards, while the rest rely heavily on subjective interpretation by examiners."},{"heading":"Why It Matters","content":"Flawed techniques like bite mark analysis have contributed to hundreds of wrongful convictions, destroying innocent lives. Courts continue to treat these methods as infallible, creating a dangerous legal precedent that is difficult to overturn. Furthermore, juries are often swayed by confident expert testimonies, unaware of the lack of empirical backing behind their claims. True justice requires a massive overhaul of how forensic evidence is admitted and evaluated."}]}`;

    const videoContext = transcript
      ? '\n---\nTitle: ' + title + '\nChannel: ' + channelName + '\nTranscript:\n' + transcript
      : '\n---\nTitle: ' + title + '\nChannel: ' + channelName + '\n(No transcript available — summarize from title and channel context only.)';

    const payload = {
      model:       OPENROUTER_MODEL,
      messages:    [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: USER_PROMPT + videoContext },
      ],
      temperature: 0.4,
      max_tokens:  2048,
      // Note: response_format json_object not supported by all OpenRouter models.
      // parseJson() below handles JSON extraction from free-form text.
    };

    let shortSummary = '', detailedSummary = '', keyPoints = [], sections = [];
    try {
      const orRes  = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: openRouterHeaders(orKey),
        body: JSON.stringify(payload),
      });
      const orData  = JSON.parse(await orRes.text());
      console.log('OpenRouter summarize status:', orRes.status);
      console.log('OpenRouter raw response:', JSON.stringify(orData).slice(0, 500));

      const rawText = orData?.choices?.[0]?.message?.content || '';
      const parsed  = parseJson(rawText);
      if (parsed) {
        shortSummary    = parsed.short_summary    || '';
        detailedSummary = parsed.detailed_summary || '';
        keyPoints       = Array.isArray(parsed.key_points) ? parsed.key_points : [];
        sections        = Array.isArray(parsed.sections) ? parsed.sections : [];
      }
      console.log('Parsed summary:', !!shortSummary, '| detailed:', !!detailedSummary, '| keyPoints:', keyPoints.length, '| sections:', sections.length);
    } catch(e) { console.error('OpenRouter summarize error:', e.message); }

    if (!shortSummary) throw new HttpsError('internal', 'AI did not return a usable summary. Please try again.');

    try {
      await cacheRef.set({
        videoId, title, channel: channelName || '',
        date: publishedAt ? publishedAt.substring(0, 10) : '',
        videoUrl: videoUrl || '', shortSummary, detailedSummary, keyPoints, sections,
        hadTranscript: transcript !== null, cachedAt: new Date().toISOString(),
      });
    } catch(e) { console.error('Firestore write error:', e.message); }

    await logUserAnalytics(request.auth.uid, channelName);
    return { fromCache: false, shortSummary, detailedSummary, keyPoints, sections };
  }
);

// =============================================================================
// FUNCTION 2: askAboutVideo
// Grounded in video transcript + summary context.
// Note: Google Search grounding (Gemini-specific) has been removed.
// Answers are based on the transcript/summary provided in the system prompt.
// =============================================================================
exports.askAboutVideo = onCall(
  {
    region: 'asia-south1', secrets: [SUPADATA_KEY, OPENROUTER_KEY],
    timeoutSeconds: 60, memory: '256MiB', cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

    const { videoId, title, channelName, videoUrl, question, history } = request.data;
    if (!videoId || !question) throw new HttpsError('invalid-argument', 'videoId and question required.');

    // Ask AI quota check — 5 questions/day for free users, unlimited for Pro
    // Dev UIDs skip this check
    if (!isDev(request)) {
      await checkAndIncrementAskQuota(request.auth.uid);
    } else {
      console.log('Dev UID — skipping Ask AI quota check for', request.auth.uid);
    }

    const supKey = SUPADATA_KEY.value();
    const orKey  = OPENROUTER_KEY.value();

    // 1. Get transcript — Firestore cache first, then Supadata
    let transcript       = null;
    let transcriptSource = 'none';

    try {
      const tDoc = await db.collection('transcriptCache').doc(videoId).get();
      if (tDoc.exists && tDoc.data().transcript) {
        transcript       = tDoc.data().transcript;
        transcriptSource = 'cache';
        console.log('Transcript from Firestore cache:', transcript.length, 'chars');
      }
    } catch(e) { console.log('Transcript cache read error:', e.message); }

    if (!transcript) {
      transcript = await fetchTranscript(videoId, supKey);
      if (transcript) {
        transcriptSource = 'supadata';
        console.log('Transcript from Supadata:', transcript.length, 'chars');
        db.collection('transcriptCache').doc(videoId)
          .set({ transcript, cachedAt: new Date().toISOString() })
          .catch(() => {});
      }
    }

    // 2. Get summary context as fallback
    let summaryContext = '';
    try {
      const vDoc = await db.collection('videoCache').doc(videoId).get();
      if (vDoc.exists) {
        const d = vDoc.data();
        summaryContext = ((d.shortSummary || '') + ' ' + (d.detailedSummary || '')).trim();
      }
    } catch(e) {}

    const hasTranscript = transcript !== null;

    // 3. Build system prompt
    const videoContent = hasTranscript
      ? `FULL TRANSCRIPT:\nTitle: ${title}\nChannel: ${channelName}\n\n${transcript}`
      : `VIDEO SUMMARY (transcript unavailable):\nTitle: ${title}\nChannel: ${channelName}\n\n${summaryContext}`;

    const SYSTEM = `You are an AI assistant helping users learn more about a YouTube video.

${videoContent}

Instructions:
- Answer questions primarily based on the video content above.
- If asked about something not in the video, answer from your training knowledge and clearly note you are doing so.
- Be concise. Use **bold** for key terms. Use bullet points for lists.
- Do NOT use markdown headers (##).
- Keep answers under 250 words unless the question requires more depth.`;

    // 4. Build OpenAI-format messages array
    // History roles: client sends 'user'/'assistant', map accordingly
    const historyMessages = (history || []).slice(-20).map(h => ({
      role:    h.role === 'user' ? 'user' : 'assistant',
      content: h.text,
    }));

    const messages = [
      { role: 'system', content: SYSTEM },
      ...historyMessages,
      { role: 'user',   content: question },
    ];

    // 5. Call OpenRouter
    try {
      const payload = {
        model:       OPENROUTER_MODEL,
        messages,
        temperature: 0.5,
        max_tokens:  1024,
      };

      const orRes  = await fetch(OPENROUTER_ENDPOINT, {
        method:  'POST',
        headers: openRouterHeaders(orKey),
        body:    JSON.stringify(payload),
      });

      console.log('Ask OpenRouter status:', orRes.status);
      const orData = JSON.parse(await orRes.text());
      const answer = orData?.choices?.[0]?.message?.content?.trim() || '';

      if (!answer) throw new Error('Empty response from OpenRouter');

      console.log('Ask answer length:', answer.length, '| transcript source:', transcriptSource);
      return { answer, hadTranscript: hasTranscript };

    } catch(e) {
      console.error('askAboutVideo error:', e.message);
      throw new HttpsError('internal', 'Could not generate an answer. Please try again.');
    }
  }
);

// =============================================================================
// HELPERS
// =============================================================================
async function fetchTranscript(videoId, supKey) {
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8000); // 8s max

    const res = await fetch(
      'https://api.supadata.ai/v1/youtube/transcript?videoId=' + videoId + '&text=true&lang=en&mode=native',
      { headers: { 'x-api-key': supKey }, signal: controller.signal }
    );
    clearTimeout(timeout);

    if (res.ok) {
      const body = await res.json();
      const text = body.content || '';
      if (text.trim().length > 50) {
        return text.length > MAX_TRANSCRIPT_CHARS
          ? text.substring(0, MAX_TRANSCRIPT_CHARS) + ' [truncated]'
          : text;
      }
    }
    console.log('Supadata status:', res.status, '— no transcript');
  } catch(e) {
    console.log('Supadata error:', e.message);
  }
  return null;
}

function parseJson(raw) {
  try { return JSON.parse(raw.trim()); } catch(e) {}
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch(e) {} }
  const block = raw.match(/\{[\s\S]*\}/);
  if (block) { try { return JSON.parse(block[0]); } catch(e) {} }
  return null;
}

const YT_KEY = 'AIzaSyB4DrqzZiii1Aa8GCnUjaeDkDFQrc1JYhw'; // Exposing this safely since it's a client key
const GMAIL_USER = defineSecret('GMAIL_USER');

// ─── Shared digest sender ─────────────────────────────────────────────────────
async function sendDigestToUser(uid, supKey, orKey, transporter, isWeekly = false) {
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) throw new Error('User not found: ' + uid);
  const user = doc.data();
  if (!user.email) throw new Error('No email set for user ' + uid);
  if (!user.channels || user.channels.length === 0) throw new Error('No channels for user ' + uid);

  const now = new Date();
  const cutoffDays = isWeekly ? 7 : 1;
  const cutoffTime = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);

  // Gather videos from last 24h across all subscribed channels
  let videos = [];
  for (const ch of user.channels) {
    try {
      const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${ch.id}&key=${YT_KEY}`);
      const chData = await chRes.json();
      if (!chData.items || chData.items.length === 0) continue;

      const uploadPlaylist = chData.items[0].contentDetails.relatedPlaylists.uploads;
      const channelTitle = chData.items[0].snippet.title;

      const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadPlaylist}&maxResults=15&key=${YT_KEY}`);
      const plData = await plRes.json();
      if (!plData.items) continue;

      for (const item of plData.items) {
        const pubDate = new Date(item.snippet.publishedAt);
        if (pubDate >= cutoffTime) {
          videos.push({
            videoId: item.snippet.resourceId.videoId,
            title: item.snippet.title,
            channel: channelTitle,
            thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
            url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
          });
        }
      }
    } catch(e) {
      console.error('Error fetching channel videos:', ch.name, e);
    }
  }

  if (videos.length === 0) {
    throw new Error('No new videos in the last ' + (isWeekly ? '7 days' : '24 hours') + ' for user ' + uid);
  }

  // Build HTML email
  const titleType = isWeekly ? 'Weekly YouTube Rollup' : 'daily video digest';
  let htmlContent = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff;">
    <div style="margin-bottom:24px;border-bottom:3px solid #ff4d1c;padding-bottom:16px;">
      <h1 style="margin:0;font-size:28px;font-weight:900;color:#111;">YT<span style="color:#ff4d1c;">Digest</span></h1>
      <p style="margin:6px 0 0;color:#666;font-size:14px;">Your ${titleType} — ${videos.length} new video${videos.length !== 1 ? 's' : ''} from your channels</p>
    </div>`;

  for (const v of videos) {
    let shortSummary = 'Summary not available.';
    try {
      // Use unified videoCache collection
      const cacheDoc = await db.collection('videoCache').doc(v.videoId).get();
      if (cacheDoc.exists && cacheDoc.data().shortSummary) {
        shortSummary = cacheDoc.data().shortSummary;
      } else {
        const transcript = await fetchTranscript(v.videoId, supKey);
        const PROMPT = `You are a concise summarizer for a YouTube video digest app.\nReturn ONLY raw JSON with exactly two fields:\n{"short_summary":"2-3 sentences with **bold** key terms.","detailed_summary":"4-6 sentences with **bold** key terms."}`;
        const userContent = transcript
          ? PROMPT + '\n---\nTitle: ' + v.title + '\nChannel: ' + v.channel + '\nTranscript:\n' + transcript
          : PROMPT + '\n---\nTitle: ' + v.title + '\nChannel: ' + v.channel + '\n(No transcript — summarize from title/channel only.)';

        const orRes = await fetch(OPENROUTER_ENDPOINT, {
          method: 'POST',
          headers: openRouterHeaders(orKey),
          body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: userContent }], temperature: 0.3 })
        });
        const orData = await orRes.json();
        const parsed = parseJson(orData?.choices?.[0]?.message?.content || '');
        if (parsed?.short_summary) {
          shortSummary = parsed.short_summary;
          await db.collection('videoCache').doc(v.videoId).set({
            videoId: v.videoId, title: v.title, channel: v.channel,
            shortSummary: parsed.short_summary,
            detailedSummary: parsed.detailed_summary || '',
            cachedAt: new Date().toISOString()
          }, { merge: true });
        }
      }
    } catch(e) {
      console.error('Summarization error for digest:', v.videoId, e);
    }

    const formattedSummary = shortSummary.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    htmlContent += `
      <div style="margin-bottom:32px;">
        <h2 style="font-size:17px;font-weight:700;margin:0 0 4px 0;line-height:1.3;">
          <a href="${v.url}" style="color:#111;text-decoration:none;">${v.title}</a>
        </h2>
        <div style="font-size:12px;color:#888;margin-bottom:10px;">${v.channel}</div>
        ${v.thumbnail ? `<a href="${v.url}"><img src="${v.thumbnail}" style="width:100%;border-radius:8px;margin-bottom:10px;display:block;" alt="Thumbnail"></a>` : ''}
        <p style="font-size:14px;color:#333;line-height:1.6;margin:0 0 10px;">${formattedSummary}</p>
        <a href="${v.url}" style="display:inline-block;padding:8px 18px;background:#ff4d1c;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:700;">Watch ▶</a>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:0 0 28px;">`;
  }

  htmlContent += `
    <p style="font-size:11px;color:#bbb;text-align:center;margin-top:16px;">
      You're receiving this because you enabled Email Notifications in YTDigest.<br>
      To unsubscribe, open the app and toggle off Email Notifications in your account settings.
    </p></div>`;

  const subjectStr = isWeekly
    ? `Your Weekly YouTube Rollup — ${new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} 📺`
    : `Your Daily YouTube Digest — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })} 📺`;

  // List-Unsubscribe header is required by Gmail/Yahoo bulk sender guidelines.
  // The link simply tells users to open the app and toggle off notifications.
  const appUrl = 'https://aryaarasan.github.io/ytdigest_v2/';

  await transporter.sendMail({
    from: '"YTDigest" <ytdigest1@gmail.com>',
    to: user.email,
    subject: subjectStr,
    html: htmlContent,
    headers: {
      'List-Unsubscribe': `<${appUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });

  console.log('Digest sent to', user.email, '—', videos.length, 'videos');
  return { sent: true, to: user.email, videoCount: videos.length };
}
// ─────────────────────────────────────────────────────────────────────────────

exports.dailyEmailDigest = onSchedule({
  schedule: "0 * * * *",
  secrets: [SUPADATA_KEY, OPENROUTER_KEY, GMAIL_USER, GMAIL_PASS]
}, async (event) => {
  const usersSnap = await db.collection('users').where('notificationsEnabled', '==', true).get();
  if (usersSnap.empty) return;

  const now = new Date();
  const supKey = SUPADATA_KEY.value();
  const orKey = OPENROUTER_KEY.value();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() }
  });

  for (const doc of usersSnap.docs) {
    const user = doc.data();
    if (!user.email || !user.timezone) continue;
    try {
      const userHourStr = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: user.timezone }).format(now);
      const userHour = parseInt(userHourStr, 10);
      const targetHour = user.digestHour !== undefined ? parseInt(user.digestHour, 10) : 10;
      if (userHour !== targetHour) continue;

      const userDayStr = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: user.timezone }).format(now);
      const isSunday = userDayStr === 'Sunday';

      if (isSunday && user.isPro) {
        await sendDigestToUser(doc.id, supKey, orKey, transporter, true);
      } else {
        await sendDigestToUser(doc.id, supKey, orKey, transporter, false);
      }
    } catch(e) {
      console.error('Digest error for user', doc.id, e.message);
    }
  }
});

// =============================================================================
// FUNCTION: testEmailDigest  (HTTP — call manually to test without waiting for 10 AM)
// Usage: GET https://<region>-<project>.cloudfunctions.net/testEmailDigest?uid=<uid>&token=ytdigest-test-2025
// =============================================================================
exports.testEmailDigest = onRequest({
  region: 'us-central1',
  secrets: [SUPADATA_KEY, OPENROUTER_KEY, GMAIL_USER, GMAIL_PASS]
}, async (req, res) => {
  // Simple token gate — not a user-facing secret, just prevents public spam
  const TEST_TOKEN = 'ytdigest-test-2025';
  if (req.query.token !== TEST_TOKEN) {
    res.status(403).json({ error: 'Forbidden — invalid token' });
    return;
  }

  const uid = req.query.uid;
  if (!uid) {
    res.status(400).json({ error: 'Missing ?uid= parameter' });
    return;
  }

  try {
    const supKey = SUPADATA_KEY.value();
    const orKey = OPENROUTER_KEY.value();
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() }
    });

    const result = await sendDigestToUser(uid, supKey, orKey, transporter);
    res.json({ success: true, ...result });
  } catch(e) {
    console.error('testEmailDigest error:', e);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// FREE TRIAL
// =============================================================================
exports.startFreeTrial = onCall(
  { region: 'asia-south1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);

    // Wrap in a transaction to make the "check then set" atomic.
    // Without this a race condition could grant two concurrent requests the trial.
    const trialEndsAt = await db.runTransaction(async (tx) => {
      const doc = await tx.get(userRef);

      // One trial per account — reject if already started
      if (doc.exists && doc.data().trialStartedAt) {
        throw new HttpsError('already-exists', 'Free trial already used for this account.');
      }

      const now = new Date();
      const ends = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // +14 days
      tx.set(userRef, { trialStartedAt: now, trialEndsAt: ends }, { merge: true });
      return ends;
    });

    return { trialEndsAt: trialEndsAt.toISOString() };
  }
);

// =============================================================================
// LEMON SQUEEZY INTEGRATION
// =============================================================================
exports.createLemonSqueezyCheckout = onCall(
  { region: 'asia-south1', secrets: [LEMON_SQUEEZY_API_KEY], cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const apiKey = LEMON_SQUEEZY_API_KEY.value();
    
    const payload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { custom: { uid: request.auth.uid } }
        },
        relationships: {
          store: { data: { type: 'stores', id: '410502' } },
          variant: { data: { type: 'variants', id: '1820322' } }
        }
      }
    };
    
    const res = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      const errTxt = await res.text();
      console.error('Lemon Squeezy API Error:', errTxt);
      throw new HttpsError('internal', 'Could not create checkout session.');
    }
    
    const data = await res.json();
    return { url: data.data.attributes.url };
  }
);

exports.lemonSqueezyWebhook = onRequest(
  { region: 'asia-south1', secrets: [LEMON_SQUEEZY_WEBHOOK_SECRET] },
  async (req, res) => {
    try {
      const crypto = require('crypto');
      const secret = LEMON_SQUEEZY_WEBHOOK_SECRET.value();
      const hmac = crypto.createHmac('sha256', secret);
      const digest = Buffer.from(hmac.update(req.rawBody).digest('hex'), 'utf8');
      const signature = Buffer.from(req.get('X-Signature') || '', 'utf8');

      if (digest.length !== signature.length || !crypto.timingSafeEqual(digest, signature)) {
        console.error('Invalid signature.');
        return res.status(400).send('Invalid signature.');
      }

      const eventName = req.body.meta.event_name;
      const obj = req.body.data;
      const uid = req.body.meta.custom_data?.uid;

      if (['subscription_created', 'subscription_updated'].includes(eventName)) {
        const status = obj.attributes.status;
        // 'past_due' means payment failed — treat as lapsed, not active.
        // Users in this state are downgraded immediately; they can re-subscribe.
        const isPro = ['active', 'trialing'].includes(status);
        const renewsAt = obj.attributes.renews_at;

        if (uid) {
          await db.collection('users').doc(uid).set({
            isPro: isPro,
            lemonSqueezyCustomerId: obj.attributes.customer_id,
            proUntil: renewsAt,
            lemonSqueezyStatus: status,
          }, { merge: true });
        }
      } else if (['subscription_cancelled', 'subscription_expired', 'subscription_payment_failed'].includes(eventName)) {
        if (uid) {
          await db.collection('users').doc(uid).set({
            isPro: false,
            lemonSqueezyStatus: eventName,
          }, { merge: true });
        }
      }

      res.json({received: true});
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Internal Server Error');
    }
  }
);

