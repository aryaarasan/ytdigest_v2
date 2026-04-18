// =============================================================================
// FIRESTORE INTEGRATION — Add this to your existing Apps Script file
// =============================================================================
// This writes video summaries to Firestore so the new personalized frontend
// can look them up without re-generating them.
//
// SETUP REQUIRED (do once):
// 1. In Apps Script editor → Project Settings → Google Cloud Platform project
//    → Change to your Firebase project number (found in Firebase Console → Settings)
// 2. In Google Cloud Console → APIs & Services → Enable "Cloud Firestore API"
// 3. In Google Cloud Console → IAM → find the Apps Script service account
//    (it looks like: project-id@appspot.gserviceaccount.com)
//    → Grant it the "Cloud Datastore User" role
// =============================================================================

// Your Firebase project ID (from Firebase Console → Project Settings)
const FIREBASE_PROJECT_ID = 'YOUR_FIREBASE_PROJECT_ID'; // ← replace this

/**
 * Writes a video + summary to the Firestore videoCache collection.
 * Uses the Apps Script OAuth token — works when the script is linked
 * to the same GCP project as Firebase.
 *
 * The document ID is the YouTube videoId (e.g. "BHY0FxzoKZE").
 * If the document already exists, it is overwritten (idempotent).
 *
 * @param {Object} video   - Video object from Phase 1
 * @param {Object} summary - Summary object from Phase 2
 */
function writeToFirestore(video, summary) {
  const token = ScriptApp.getOAuthToken();
  const videoId = video.videoId;

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/videoCache/${videoId}`;

  // Firestore REST API uses typed field values
  const doc = {
    fields: {
      videoId:         { stringValue: videoId },
      title:           { stringValue: video.title           || '' },
      channel:         { stringValue: video.channelName     || '' },
      channelId:       { stringValue: video.channelId       || '' },
      date:            { stringValue: video.publishedAt
                          ? video.publishedAt.substring(0, 10) : '' },
      thumbnail:       { stringValue: video.thumbnail       || '' },
      videoUrl:        { stringValue: video.videoUrl        || '' },
      shortSummary:    { stringValue: summary.short_summary    || '' },
      detailedSummary: { stringValue: summary.detailed_summary || '' },
      cachedAt:        { timestampValue: new Date().toISOString() },
    }
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method:             'PATCH',  // PATCH = create or overwrite
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      payload:            JSON.stringify(doc),
      muteHttpExceptions: true,
    });

    const status = response.getResponseCode();
    if (status === 200) {
      Logger.log('Firestore ✓ ' + videoId + ' — ' + video.title);
    } else {
      Logger.log('Firestore ✗ (' + status + ') ' + videoId + ': ' + response.getContentText());
    }
  } catch (err) {
    Logger.log('Firestore error for ' + videoId + ': ' + err.message);
    // Non-fatal — the Sheet write already happened; Firestore is supplementary
  }
}

// =============================================================================
// REPLACE your existing main() with this version.
// The only addition is the writeToFirestore() call after writeToSheet().
// Everything else is identical to your current main().
// =============================================================================

function main() {
  Logger.log('========================================');
  Logger.log('main() pipeline started: ' + new Date().toISOString());
  Logger.log('========================================');

  const stats = {
    fetched: 0, written: 0, skipped: 0,
    errors: 0, noTranscript: 0,
  };

  let videos = [];
  try {
    videos = fetchRecentVideos();
    stats.fetched = videos.length;
    Logger.log('Fetched ' + videos.length + ' recent video(s).');
  } catch (error) {
    Logger.log('FATAL: fetchRecentVideos() failed — ' + error.message);
    return;
  }

  if (videos.length === 0) {
    Logger.log('No new videos found. Pipeline complete.');
    cleanOldRows();
    return;
  }

  for (const video of videos) {
    Logger.log('--- Processing: ' + video.title + ' (' + video.videoId + ') ---');
    try {
      const transcript = getTranscript(video.videoId);
      if (!transcript) stats.noTranscript++;

      const summary = summarizeVideo(video, transcript);

      // Write to Google Sheet (existing)
      const written = writeToSheet(video, summary);
      if (written) {
        stats.written++;
      } else {
        stats.skipped++;
      }

      // ← NEW: Also write to Firestore cache
      writeToFirestore(video, summary);

      Utilities.sleep(2000); // rate limiting
    } catch (error) {
      stats.errors++;
      Logger.log('ERROR processing ' + video.videoId + ': ' + error.message);
    }
  }

  try {
    cleanOldRows();
  } catch (error) {
    Logger.log('Cleanup error: ' + error.message);
  }

  Logger.log('========================================');
  Logger.log('Pipeline complete: ' + new Date().toISOString());
  Logger.log(' Fetched: '      + stats.fetched);
  Logger.log(' Written: '      + stats.written);
  Logger.log(' Skipped (dup):' + stats.skipped);
  Logger.log(' No transcript:' + stats.noTranscript);
  Logger.log(' Errors: '       + stats.errors);
  Logger.log('========================================');
}

// =============================================================================
// Also update your appsscript.json (Project Settings → Edit manifest)
// to add the cloud-platform scope so ScriptApp.getOAuthToken() works.
// Add this line to "oauthScopes":
//   "https://www.googleapis.com/auth/cloud-platform"
// =============================================================================

/**
 * Quick test — run this after setup to confirm Firestore writes work.
 */
function testFirestoreWrite() {
  const mockVideo = {
    videoId:     'FIRESTORE_TEST_001',
    title:       'Firestore Test — delete me',
    channelName: 'Test Channel',
    channelId:   'UC_test',
    publishedAt: new Date().toISOString(),
    thumbnail:   '',
    videoUrl:    'https://youtube.com',
  };
  const mockSummary = {
    short_summary:    'This is a test write to confirm Firestore integration works.',
    detailed_summary: 'If you can see this document in your Firestore console, setup is complete.',
  };
  writeToFirestore(mockVideo, mockSummary);
  Logger.log('Test complete — check Firestore console for document: FIRESTORE_TEST_001');
}
