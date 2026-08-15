# YTDigest v2 — Project Context
> This file is auto-loaded at the start of every chat. Keep it up to date as the project evolves.

---

## Project Basics

| Field | Value |
|---|---|
| **Repo** | `d:\MBA_SPJIMR\learning\app development\ytdigest_v2` |
| **GitHub** | `https://github.com/aryaarasan/ytdigest_v2` |
| **Live App** | `https://aryaarasan.github.io/ytdigest_v2/` (GitHub Pages) |
| **Backend** | Firebase Cloud Functions — project `booming-banner-491707-c8` (region: `asia-south1`) |
| **Frontend** | Single file: `index.html` (~4700 lines, monolithic HTML + CSS + JS) |
| **Payment** | LemonSqueezy (store `410502`, variant `1820322`) |
| **AI** | OpenRouter → Gemini 2.5 Flash for summaries and Ask AI |
| **Transcripts** | Supadata API |
| **Email** | Gmail via Nodemailer (Cloud Function) |

---

## Architecture

```
GitHub Pages (index.html)
  ↓ Firebase Auth (Google Sign-In)
  ↓ Firestore (user data, summaries cache, transcripts)
  ↓ Cloud Functions:
      summarizeVideo              — AI summary (cached), returns shortSummary, detailedSummary, keyPoints
      askAboutVideo               — per-video chat Q&A, multi-turn (last 20 msgs)
      dailyEmailDigest            — hourly cron, sends digest at user's chosen hour
      testEmailDigest             — HTTP trigger for manual testing (?uid=&token=ytdigest-test-2025)
      startFreeTrial              — 14-day one-time trial per account
      createLemonSqueezyCheckout  — creates LS hosted checkout, passes uid via custom_data
      lemonSqueezyWebhook         — HMAC-verified webhook, writes isPro to Firestore
```

### Firestore Collections

| Collection | Purpose |
|---|---|
| `users/{uid}` | channels, email, country, timezone, isPro, trialStartedAt/EndsAt, digestHour, saved[] |
| `users/{uid}/quota` | Monthly analytics: total summaries, channels map |
| `quotas/{uid}` | Daily rate limiting: `{ day, count }` |
| `videoCache/{videoId}` | Cached summaries: shortSummary, detailedSummary, keyPoints |
| `transcriptCache/{videoId}` | Raw transcript text |

---

## Payment Flow

```
User clicks "Upgrade to Pro"
  → createLemonSqueezyCheckout (Cloud Function)
  → Redirects to LemonSqueezy hosted checkout
  → On payment, LS POSTs to lemonSqueezyWebhook
  → Writes isPro: true + proUntil + lemonSqueezyCustomerId to Firestore users/{uid}
  → On next app load: isProUser = true, PRO badge shown, quota raised to 50/day
```

Free trial: 14 days, one per account, enforced server-side.
`isProUser = userData.isPro || isOnTrial || DEV_UIDS.includes(uid)`

**Status: Fully coded, NEVER end-to-end tested with a real payment.**

---

## Pro vs Free

| Feature | Free | Pro |
|---|---|---|
| AI Summaries | 10/day | 50/day |
| Feed / Trending / Saved / Ask AI | ✅ | ✅ |
| Analytics Tab | ✗ | ✅ |
| Export Summary (.txt) | ✗ | ~~✅ Removed~~ |
| Custom Digest Time | ✗ | ✅ |
| Weekly Email Rollup | ✗ | ✅ |

---

## Dev UIDs (bypass quota, show dev panel)

```
bSK3dQARB3PRAbe7notSr9gZP5N2
9DzujGsyn9SmkpZURFOXt0qCwzG2
VYALfUEjSMWIOThdC7zXUYoZegM2
```
Hardcoded in both `index.html` and `functions/index.js`.

---

## Known Bugs

### 🔴 Critical

(All previously listed critical bugs have been resolved)

### 🟡 Medium

**Bug 4 — Saved videos as array on user doc**
- `users/{uid}.saved[]` will hit Firestore's 1MB document limit at scale.
- Future fix: migrate to `users/{uid}/saved/{videoId}` subcollection.

---



---

## Prioritised Action Items

| # | Task | Effort | Status |
|---|---|---|---|
| 1 | Fix trial quota bug (Bug 1) | ~5 min | ✅ Done |
| 2 | Test payment end-to-end in LS test mode | ~30 min | ⏳ Pending (test mode active) |
| 3 | Fix `v.title` ReferenceError (Bug 2) | ~5 min | ✅ Done |
| 4 | Fix `TRENDING_COUNTRY` bug (Bug 3) | ~2 min | ✅ Done |
| 5 | Implement Share feature (WhatsApp + Email) | ~1–2 hrs | ✅ Done |
| 6 | ~~Remove export feature entirely~~ | ~5 min | ✅ Done |
| 7 | Remove "Priority Processing" from modal | ~10 min | ✅ Done |
| 8 | Firestore security rules for quotas/transcriptCache/analytics | ~15 min | ✅ Done |
| 9 | Enforce `proUntil` server-side in quota check | ~20 min | ✅ Done |
| 10 | Atomic `startFreeTrial` (Firestore transaction) | ~10 min | ✅ Done |
| 11 | Ask AI rate limit (5/day free users) | ~30 min | ✅ Done |
| 12 | Remove `past_due` from Pro statuses in webhook | ~5 min | ✅ Done |
| 13 | Add OG/Twitter meta tags | ~10 min | ✅ Done |
| 14 | Add `List-Unsubscribe` header to digest emails | ~15 min | ✅ Done |
| 15 | Add Pro renewal date to account dropdown | ~20 min | ✅ Done |
| 16 | Add "Weekly Email Rollup" row to upgrade modal | ~5 min | ✅ Done |

---

## Recent Major Updates (For context in new chat)

**E2E Platform Audit Fixes (Latest Update)**
- Closed 3 Firestore security rule gaps: `quotas/`, `transcriptCache/`, `users/{uid}/quota` subcollection.
- Added server-side `proUntil` expiry enforcement in `checkAndIncrementQuota` — lapsed paid subs auto-downgrade even if webhook is missed.
- Made `startFreeTrial` atomic via Firestore transaction to prevent race-condition double-grants.
- Added `checkAndIncrementAskQuota`: 5 Ask AI questions/day for free users, unlimited for Pro. Stored as `askDay`/`askCount` in `quotas/{uid}`.
- Removed `past_due` from active subscription statuses in `lemonSqueezyWebhook` — failed payments now immediately downgrade.
- Added `List-Unsubscribe` + `List-Unsubscribe-Post` headers to all digest emails (bulk sender compliance).
- Frontend: OG/Twitter meta tags, improved page title, "Weekly Email Rollup" in Pro modal, Pro renewal date in account dropdown, Ask AI quota error triggers Pro upgrade modal.

**Unified Architecture Refactor**
- Replaced 4 duplicate layout structures with a single `buildCard()` function across Feed, Trending, Search, and Saved tabs.
- Resulted in all premium features (Export, Share, Ask AI, and new deep summaries) being available globally across the entire platform.
- Cleaned up ~300+ lines of redundant CSS and JS functions.

**Enhanced AI Summaries**
- Enforced 4-6 sentences per summary section in the backend `USER_PROMPT`.
- Addressed mobile overflow issues by fixing layout CSS.

---

## Deploy Instructions (PowerShell — no `&&`)

```powershell
# Frontend only
git add index.html
git commit -m "your message"
git push origin main

# Backend only
firebase deploy --only functions

# Both (run separately)
git add index.html functions/index.js
git commit -m "your message"
git push origin main
firebase deploy --only functions
```
Hard-refresh after frontend deploy: `Ctrl+Shift+R`

---

## Key Code Locations

### index.html
| Section | ~Line |
|---|---|
| Firebase config | 1602 |
| `isProUser` + trial check | 1757–1780 |
| `buildCard()` | 2235 |
| `toggleExpand()` | 2392 |
| `openAskPanel()` | 2415 |
| `fetchSummaryOnDemand()` | 2428 |
| `showProUpgradeModal()` | 4347 |
| `exportSummary()` | 4428 |
| Dev panel HTML | 4449 |

### functions/index.js
| Section | ~Line |
|---|---|
| `summarizeVideo` | 115 |
| `askAboutVideo` | 220 |
| `checkAndIncrementQuota` | 55 |
| `startFreeTrial` | 586 |
| `createLemonSqueezyCheckout` | 614 |
| `lemonSqueezyWebhook` | 654 |
| DEV_UIDS | 47 |
