# UAT implementation and release checks

This document records the approved UAT changes and the follow-up email, card, analytics and summary unlock improvements. The current allowance design and backend safeguard settings are documented in [SUMMARY-ALLOWANCE.md](SUMMARY-ALLOWANCE.md). Automated and browser checks use synthetic accounts. Google popup branding is a separate Google Auth Platform configuration task.

## Approved behavior

- YouTube Edition uses the Classic sign-in design, and hides app navigation while signed out.
- Channel suggestions appear after a 420 ms typing pause. Outdated results cannot overwrite the latest search.
- Sidebar and top channel selections stay synchronized. Selecting the same channel again or choosing All clears the filter.
- The feed centres in the remaining space with the sidebar open or closed. Mobile navigation opens as an overlay.
- Video duration appears on thumbnails; upload age stays in the metadata row. Duration is fetched in batches across Feed, Search, Trending and Saved.
- Avatars centre photos or initials and fall back to initials if a photo fails.
- Pro cards keep their two-line preview and existing 188 px desktop thumbnail. Free cards omit the generation hint and use a 124 px desktop thumbnail, capped at 180 px on mobile. Full summaries remain in the expandable panel.
- Both interfaces check account unlocks through the server. Cached and new videos cost the same one reading allowance; previously unlocked videos reopen free. Pro and active trial users prepare a bounded selection of visible, recent followed-channel videos in advance, privately. Changing views or hiding the page cancels pending work; already started requests may finish. Firestore leases coalesce generation across users and function instances, and reserve capacity for requested Pro reads.
- Failed summaries have a retry action and do not consume reading allowance. Previously unlocked cached summaries remain readable after reading or generation limits are reached. Pro reading sessions require an explicit selection; failures are reported without a deduction. Both interfaces show the shared balance and an Unlocked filter.
- Search and Trending videos retain metadata and summaries in the current session; bookmarks preserve that metadata and complete breakdown fields.
- Both interfaces count explicit opens of ready summaries, including cached results. Background generation, bookmark actions and merely displaying a preview do not count.
- Analytics show Today, This week and This month, a daily chart, the top three topics, top channels and estimated time saved. The server checks account access and owns the records.
- YouTube Edition's profile menu offers Pro and active trial users email on/off, delivery address and hourly delivery time. Existing preferences load without subscribing anyone automatically. Changes require Save preferences; invalid addresses and failed saves are reported. Guests and Free users retain the appropriate sign-in/upgrade gates. Classic preserves a custom delivery address and offers the same 24 hourly choices.
- The profile menu remains accessible at narrow tablet widths, and its email panel scrolls within short screens.

## Counting rules

Each video counts once per user in the selected period. Reopening it on another day creates daily activity, but it still counts only once in the week or month total. Weeks start on Monday. Dates use the account timezone, falling back to the browser timezone and then UTC. The reading allowance and internal summary generation budgets reset at midnight IST. Ask AI retains its separate existing UTC reset.

New daily records live under `users/{uid}/summaryOpens`. Their identifiers deduplicate the same day and video across tabs and devices. Analytics query only the authenticated user's records. Existing monthly generation records remain intact and are not reinterpreted as historical opens. Historical daily activity cannot be reconstructed reliably.

Time saved estimates video duration minus reading time at 200 words per minute. The displayed section breakdown and legacy detailed summary are alternative formats, so they are not counted twice. Positive savings under a minute display in seconds. Zero is valid when reading the summary takes at least as long as the video; the dashboard explains it. A 15 minute duration is assumed if duration is unavailable.

Video duration and topic metadata come from YouTube and are cached alongside the summary without changing its content. Specific YouTube topics take precedence over generic parents; the video category is the fallback. Each unique video counts once per topic in the selected period. Percentages use all unique summaries opened, and a multi-topic video can contribute to multiple topics. Unclassified videos remain in the total and the dashboard shows classification coverage. No additional AI generation is required for this ranking.

Older activity receives corrected duration, reading metrics and topics when analytics loads, in batches of up to 100 unique videos per refresh. Original opening timestamps and counts are preserved. Metadata outages do not prevent summary openings or displaying existing activity.

## Verification

Run `npm test` for the regression suite. Tests use synthetic Firebase and YouTube responses and make no requests to production services.

All 63 regression checks passed across the backend and UI suite. The suite covers account tiers and expiry, cached and new summaries, worker limits across navigation, retries, quota behavior, duplicate opens, date boundaries, account isolation, channel selection and autocomplete, cross-tab bookmarks, Ask AI responses, and Classic feed/search/related summary flows. Follow-up coverage includes email preferences and failure handling, compact Free cards and unchanged Pro dimensions, topic ranking, second-level savings, true zero savings, metadata outages and bounded legacy activity repair. Unlock coverage adds cached charges, permanent reopens, IST midnight, reservations, last-slot races, cross-instance coalescing, internal safeguards, historical access, old-client protection, reading sessions and locked bookmarks.

A loopback-only test preview is available with `node tests/preview.cjs`. Open `http://127.0.0.1:4173/youtube.html?mode=pro`. Other fixture modes are `signedout`, `free`, `guest`, `trial` and `expired`. Preview data is synthetic and does not represent a production account.

Browser review covered desktop expanded/collapsed layouts, 390 px mobile cards and navigation, sign-in, analytics period selection, and updates after opening a cached summary. Follow-up review verified the 124/188 px Free/Pro desktop thumbnail heights, topic bars, email controls and saving a delivery time in the synthetic preview, narrow-screen profile access and mobile email layout.

## Release order

1. Deploy `summarizeVideo`, `getSummaryState`, `prepareSummary`, `getSummaryContext`, `recordSummaryOpen`, `askAboutVideo` and `dailyEmailDigest` before the frontend. Include both summary helper modules and the metadata helper. Billing handlers are unchanged.
2. Publish `index.html`, `youtube.html`, `digest-analytics.js`, `summary-access.js` and `sw.js` together. The service worker version is bumped and application scripts bypass its cache.
3. After the frontend is served, deploy `firestore:rules` to restrict direct cache and transcript reads to permanent account unlocks. Older open tabs receive a refresh message without a reading deduction.
4. Check published file contents, callable authentication and CORS. With real accounts, follow up on Google sign-in, guest entry, trial/paid/expired states, developer controls, reading limits, Ask AI, Saved, sharing, channel management, analytics and email preferences. Real payments and scheduled email delivery have not been exercised by local tests.
5. Previously opened summaries should reopen free; new cached and generated unlocks should each deduct once. Merely preparing a summary, saving a video or displaying a locked card must not deduct anything. Batch failures must not charge. Historical opening records remain intact.

Do not roll back the frontend alone: old versions depend on unrestricted cache queries and automatic calls to the summary endpoint. See the coordinated release and rollback considerations in [SUMMARY-ALLOWANCE.md](SUMMARY-ALLOWANCE.md). No cache or user data is purged by this release.

## Google popup branding

In the existing Firebase project's Google Auth Platform Branding page, set the app name to **YT Digest** and review the current verification status, support email and required public links. Complete Google's brand verification where required. This has not been changed locally and is not completed by deploying HTML.

If the Firebase redirect hostname still appears, evaluate a verified custom authentication domain with Firebase Hosting, authorized domains and the matching OAuth redirect URI before changing `authDomain` in both interfaces. An arbitrary display name cannot be substituted for that hostname.

References: [Google OAuth branding](https://support.google.com/cloud/answer/15549049), [Firebase Google sign-in redirect domains](https://firebase.google.com/docs/auth/web/google-signin#customizing-the-redirect-domain-for-google-sign-in).
