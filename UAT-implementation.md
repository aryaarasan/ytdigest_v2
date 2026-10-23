# UAT implementation and release checks

The approved changes are implemented locally. Deployment and tests against real signed-in accounts are still required. Google popup branding is a separate Google Auth Platform configuration task.

## Approved behavior

- YouTube Edition uses the Classic sign-in design, and hides app navigation while signed out.
- Channel suggestions appear after a 420 ms typing pause. Outdated results cannot overwrite the latest search.
- Sidebar and top channel selections stay synchronized. Selecting the same channel again or choosing All clears the filter.
- The feed centres in the remaining space with the sidebar open or closed. Mobile navigation opens as an overlay.
- Video duration appears on thumbnails; upload age stays in the metadata row. Duration is fetched in batches across Feed, Search, Trending and Saved.
- Avatars centre photos or initials and fall back to initials if a photo fails.
- Cards reserve space for two preview lines and consistently align their actions. Full summaries remain in the expandable panel.
- Pro and active trial users load Firebase summary cache first. Missing summaries prepare after the app opens, with two background workers. Changing views cancels pending work; already started requests finish. A user click shares an existing request for the same video. Background work pauses when the document is hidden and stops on quota exhaustion.
- Failed summaries have a retry action. Cached summaries remain readable after the generation quota is exhausted.
- Search and Trending videos retain metadata and summaries in the current session; bookmarks preserve that metadata and complete breakdown fields.
- Both interfaces count explicit opens of ready summaries, including cached results. Background generation, bookmark actions and merely displaying a preview do not count.
- Analytics show Today, This week and This month, a daily chart, top channels and estimated time saved. The server checks account access and owns the records.

## Counting rules

Each video counts once per user in the selected period. Reopening it on another day creates daily activity, but it still counts only once in the week or month total. Weeks start on Monday. Dates use the account timezone, falling back to the browser timezone and then UTC. Generation quotas retain their existing UTC reset behavior.

New daily records live under `users/{uid}/summaryOpens`. Their identifiers deduplicate the same day and video across tabs and devices. Analytics query only the authenticated user's records. Existing monthly generation records remain intact and are not reinterpreted as historical opens. Historical daily activity cannot be reconstructed reliably.

Time saved estimates video duration minus reading time at 200 words per minute. A 15 minute duration is assumed if duration is unavailable; the dashboard labels this as an estimate.

## Verification

Run `npm test` for the regression suite. Tests use synthetic Firebase and YouTube responses and make no requests to production services.

The suite covers account tiers and expiry, cached and new summaries, worker limits across navigation, retries, quota behavior, duplicate opens, date boundaries, account isolation, channel selection and autocomplete, cross-tab bookmarks, Ask AI responses, and Classic feed/search/related summary flows.

A loopback-only test preview is available with `node tests/preview.cjs`. Open `http://127.0.0.1:4173/youtube.html?mode=pro`. Other fixture modes are `signedout`, `free`, `guest`, `trial` and `expired`. Preview data is synthetic and does not represent a production account.

Browser review covered desktop expanded/collapsed layouts, 390 px mobile cards and navigation, sign-in, analytics period selection, and updates after opening a cached summary.

## Release order

1. Deploy the two new callable functions before the frontend: `firebase deploy --only "functions:recordSummaryOpen,functions:getSummaryAnalytics,firestore:rules"`. Include `functions/summary-activity.js` in the functions source package. Existing generation, payment and email handlers do not need behavior changes for this release.
2. Publish `index.html`, `youtube.html`, `digest-analytics.js` and `sw.js` together. The service worker version is bumped and both app pages and analytics code bypass its cache. Authenticated service requests and non-GET requests also bypass it.
3. With real accounts, check Google sign-in, guest entry, trial/paid/expired account states, developer controls, Free and Pro summary limits, Ask AI, Saved, sharing, channel management, analytics and the existing email/checkout entry points in both interfaces. Real payments and scheduled email delivery have not been exercised by the local tests.
4. Reopen and refresh a cached summary in both interfaces. It should count once in the selected period. Preparing summaries without opening them must leave the count unchanged.
5. Refresh an existing installed/browser session to check the service worker update. Verify a newly generated summary persists in Firebase and loads from cache after reopening the app.

If the frontend needs rollback, restore its previous tracked versions. The added callable functions and isolated activity records are compatible with the previous frontend; existing monthly records, summary cache and user preferences are preserved.

## Google popup branding

In the existing Firebase project's Google Auth Platform Branding page, set the app name to **YT Digest** and review the current verification status, support email and required public links. Complete Google's brand verification where required. This has not been changed locally and is not completed by deploying HTML.

If the Firebase redirect hostname still appears, evaluate a verified custom authentication domain with Firebase Hosting, authorized domains and the matching OAuth redirect URI before changing `authDomain` in both interfaces. An arbitrary display name cannot be substituted for that hostname.

References: [Google OAuth branding](https://support.google.com/cloud/answer/15549049), [Firebase Google sign-in redirect domains](https://firebase.google.com/docs/auth/web/google-signin#customizing-the-redirect-domain-for-google-sign-in).
