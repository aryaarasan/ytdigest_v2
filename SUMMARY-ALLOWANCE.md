# Summary unlocks and Pro preparation

## User allowance

Both interfaces share the authenticated account's allowance: Free gets 10 new video unlocks per day; Pro and active trials get 50. The day resets at midnight in Asia/Kolkata (IST), independently of the account's email delivery timezone. Ask AI retains its existing separate quota and reset.

One successful unlock includes the short preview and full breakdown. Cached and newly generated summaries cost the same one unlock. An account's permanent `users/{uid}/summaryUnlocks/{videoId}` record makes later reopens free, including across days, tabs and interfaces. Previously recorded explicit summary openings are recognised as grandfathered access; old generation totals and merely cached or saved summaries do not grant new access.

The backend reserves a slot before generation and commits the deduction only after a usable summary is safely cached. A failure releases its reservation. Expired reservations cannot hold later days' allowance. Transactions deduplicate simultaneous opens and enforce the last available slot. Cached, previously unlocked summaries remain readable when generation safeguards or the daily reading allowance are exhausted.

The verified developer Google identity retains its reading allowance bypass. Shared infrastructure safety limits still protect the service. Email generation has a separate internal account budget and never consumes reading allowance or grants a website unlock.

## Pro speed and privacy

Shared cache content remains private until unlocked. `getSummaryState` returns readiness for locked videos, and content only for the account's previously unlocked videos. `summarizeVideo` requires explicit versioned reading intent; older open tabs cannot turn their former automatic calls into paid unlocks. The interfaces show the balance, midnight IST reset and the cost on each locked card.

Pro can prepare recent, non-live videos from followed channels in advance. Preparation is triggered only for cards actually on screen (40% visibility). The client stops queued work when hidden or changing views; an already running request may finish. The server independently validates the actual YouTube channel and a 14-day publication window. The preparation endpoint returns readiness only, never the preview or full breakdown.

Existing cached preparations need no new AI generation. New work shares a per-video Firestore lease across function instances and across website/email callers. Transcript cache is reused. Requested Pro reads have capacity reserved from background preparation and Free requests. Generated responses are limited to 2,048 output tokens and transcripts to 20,000 characters, with a provider timeout. Generation is not guaranteed instant for an uncached video.

## Initial backend safeguards

These are internal generation-attempt limits, separate from user reading allowance. Failed AI attempts can still cost the service and therefore count against these safeguards.

| Setting | Default |
|---|---:|
| New advance preparations per Pro account/day | 10 |
| New advance preparations across the service/day | 100 |
| All new summary generation attempts across website and email/day | 1,000 |
| Website generation attempts per Free account/day | 20 |
| Website generation attempts per Pro account/day | 80 |
| Email generation attempts per account/day, in a separate counter | 100 |
| Generation attempts per video/day across users | 3 |
| Simultaneous summary generations | 4 |
| Simultaneous background/email generations | 1 |
| Simultaneous Free generations | 1 |

At most one background/email job and one Free job can run at once, leaving capacity for requested Pro reads. A busy background request defers rather than filling the interactive capacity. In-flight work for the same video is shared. Retry/service capacity errors do not spend reading allowance. These are bounded request and token-size safeguards, not a provider currency billing cap; Ask AI is separate.

The server reads owner-only overrides from `systemConfig/summaryAccess`, cached for 60 seconds per instance. Supported fields are the keys in `DEFAULT_POLICY` in `functions/summary-access.js`. Clients cannot read or write this document, budget counters, jobs or reservations. Set preparation limits to zero to pause advance preparation without disabling cached unlocks or explicit reading. Increase safeguards deliberately as usage grows.

Generation counters track attempts, completed results and reported prompt/completion tokens in `summaryGenerationBudgets/{IST-day}`. Per-account counters live in `summaryGenerationAccounts`. Permanent unlock records include cache hit, wait time and whether the result came from advance preparation, supporting later analysis of cache hits, latency and preparation usefulness.

## Interfaces and existing features

Both interfaces use the shared `summary-access.js` controller. Pro users can select up to 20 videos from the current view for an explicit reading session; selection cannot exceed the remaining allowance. Two requested unlocks run concurrently, and each successful result is charged once. Failures are reported without a charge. The Unlocked filter applies to the current view.

Saving a video stores metadata without generating or unlocking it. Saved cards are hydrated through the same entitlement check, including older bookmarks that contain summary text. Classic feed, Search, Trending and Saved use the same card and unlock flow, retaining Ask AI, sharing, bookmarking, related videos and complete section breakdowns. Free/Pro thumbnail dimensions and email preference controls are preserved.

Analytics still measures explicit openings of ready breakdowns. Preparing a summary or unlocking a reading session without opening a breakdown does not create viewing activity. Allowance and analytics are deliberately separate counters.

Firestore permits direct cache/transcript document reads only after a permanent account unlock; list queries and client cache writes are denied. Ask AI and summary activity endpoints also require access to the video.

## Checks and release

The regression suite covers the IST midnight boundary, permanent free reopens, cached charges, failure release, incomplete AI responses, account isolation, simultaneous last-slot requests, coalescing across two function instances, internal budgets, private preparation, email separation, historical access and old-client protection. UI checks cover balances, batches with partial failures, filters, card dimensions, all summary entry points and existing email controls.

Browser checks use synthetic responses and do not send real emails or use a production account's allowance. Desktop and 390 px mobile layouts are checked. Real payments, scheduled email delivery and provider generation are not exercised by these local tests. Rules are compiled when deployed; the local Firestore emulator is unavailable because Java is not installed.

Release backend functions first (`summarizeVideo`, `getSummaryState`, `prepareSummary`, `getSummaryContext`, `recordSummaryOpen`, `askAboutVideo`, `dailyEmailDigest`). Publish both app pages, `summary-access.js` and service worker together. Once the frontend is served, deploy the tighter Firestore rules. Older tabs must refresh; their automatic summary calls fail without a deduction. Do not roll back to an older frontend alone, since its direct cache reads and automatic calls are incompatible with the new access rules.

Daily counters start with this release's new unlock fields; earlier generation counts are preserved but are not converted into reading charges. No cache or user data is purged.
