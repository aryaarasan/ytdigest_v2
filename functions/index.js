const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { initializeApp }      = require('firebase-admin/app');
const { getFirestore }       = require('firebase-admin/firestore');
const fetch                  = require('node-fetch');

initializeApp();
const db = getFirestore();

const SUPADATA_KEY   = defineSecret('SUPADATA_KEY');
const OPENROUTER_KEY = defineSecret('OPENROUTER_KEY');

// ─── OpenRouter config ────────────────────────────────────────────────────────
// Using OpenAI-compatible Chat Completions API via OpenRouter.
// Model: google/gemini-2.5-flash (same quality as direct Gemini, pay-as-you-go)
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL    = 'google/gemini-2.5-flash';

function openRouterHeaders(key) {
  return {
    'Authorization':  'Bearer ' + key,
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
]);

function isDev(request) {
  return DEV_UIDS.has(request.auth?.uid);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Daily per-user quota (AI summary calls) ─────────────────────────────────
// 5 summaries per day, resets at midnight UTC.
const DAILY_LIMIT = 5;

async function checkAndIncrementQuota(uid) {
  const dayKey   = getDayKey();
  const quotaRef = db.collection('quotas').doc(uid);

  return db.runTransaction(async (tx) => {
    const doc   = await tx.get(quotaRef);
    const data  = doc.exists ? doc.data() : {};
    const count = (data.day === dayKey ? data.count : 0) + 1;

    if (count > DAILY_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        `Daily summary limit of ${DAILY_LIMIT} reached. Resets at midnight.`
      );
    }

    tx.set(quotaRef, { day: dayKey, count }, { merge: false });
    return count;
  });
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
          return { fromCache: true, shortSummary: d.shortSummary, detailedSummary: d.detailedSummary || '' };
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

    const PROMPT = `You are a concise summarizer for a YouTube video digest app.
Analyze this video and return a JSON object with EXACTLY these two fields:
1. "short_summary": 2-3 sentences. Bold the single most important phrase or stat using **double asterisks**.
2. "detailed_summary": 4-6 sentences covering main argument, key data points, insights, and why it matters. Bold 3-5 key terms or stats throughout using **double asterisks**.
Rules: Return ONLY raw JSON. No markdown code fences. No explanation.
Example: {"short_summary":"Text with **bold term** here.","detailed_summary":"Longer text with **key stat** and **important concept** explained."}`;

    const userContent = transcript
      ? PROMPT + '\n---\nTitle: ' + title + '\nChannel: ' + channelName + '\nTranscript:\n' + transcript
      : PROMPT + '\n---\nTitle: ' + title + '\nChannel: ' + channelName + '\n(No transcript available — summarize from title and channel context only.)';

    const payload = {
      model:           OPENROUTER_MODEL,
      messages:        [{ role: 'user', content: userContent }],
      temperature:     0.3,
      max_tokens:      2048,
      response_format: { type: 'json_object' },
    };

    let shortSummary = '', detailedSummary = '';
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
      }
      console.log('Parsed summary:', !!shortSummary, '| detailed:', !!detailedSummary);
    } catch(e) { console.error('OpenRouter summarize error:', e.message); }

    if (!shortSummary) throw new HttpsError('internal', 'AI did not return a usable summary. Please try again.');

    try {
      await cacheRef.set({
        videoId, title, channel: channelName || '',
        date: publishedAt ? publishedAt.substring(0, 10) : '',
        videoUrl: videoUrl || '', shortSummary, detailedSummary,
        hadTranscript: transcript !== null, cachedAt: new Date().toISOString(),
      });
    } catch(e) { console.error('Firestore write error:', e.message); }

    return { fromCache: false, shortSummary, detailedSummary };
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
