# YTDigest v2 — Project Context & Development Rules

> **Last updated**: June 2026 — reflects current `index.html` (anonymous-auth build)

## 1. PROJECT OVERVIEW

**YTDigest** is a personal AI-powered YouTube video digest **Progressive Web App (PWA)**. Users follow YouTube channels, and the app fetches recent videos, generates AI summaries on-demand via Gemini, and provides an "Ask AI" chat grounded in video transcripts. It also supports trending videos, video search, bookmarking, and related video discovery.

- **Live URL**: Hosted on GitHub Pages at `https://aryaarasan.github.io/ytdigest_v2/`
- **Firebase Project**: `booming-banner-491707-c8`
- **Cloud Functions Region**: `asia-south1`
- **Target Users**: Personal use / small audience

---

## 2. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────┐
│                  CLIENT (Single HTML PWA)                │
│  index.html — all CSS + HTML + JS in one 160KB file     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Firebase Auth│  │  Firestore   │  │ Cloud Funcs   │  │
│  │  (Google)    │  │  (read-only) │  │ (httpsCallable│  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│  ┌─────────────┐                                        │
│  │ YouTube Data │                                       │
│  │ API v3       │                                       │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│              FIREBASE CLOUD FUNCTIONS                    │
│  functions/index.js — Node 20                            │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │ summarizeVideo   │  │ askAboutVideo                │ │
│  │ - Supadata API   │  │ - transcript-grounded Q&A   │ │
│  │ - Gemini 2.5     │  │ - Google Search grounding   │ │
│  │   Flash          │  │ - Conversation history      │ │
│  │ - Firestore      │  │ - Gemini 2.5 Flash          │ │
│  │   caching        │  │                              │ │
│  └──────────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│              FIRESTORE COLLECTIONS                       │
│  users/{uid}        — channels[], saved[], country,     │
│                       daysBack                           │
│  videoCache/{id}    — shortSummary, detailedSummary,    │
│                       title, channel, date, etc.         │
│  transcriptCache/{} — transcript text, cachedAt          │
│  quotas/{uid}       — week, count (per-user weekly)      │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│          LEGACY: Google Apps Script Pipeline              │
│  Apps_Script_Phase2_addition.js                           │
│  Writes to Firestore videoCache via REST API             │
│  (batch daily run — supplementary to on-demand)          │
└─────────────────────────────────────────────────────────┘
```

---

## 3. FILE STRUCTURE

```
ytdigest_v2/
├── index.html                    # ★ MAIN APP — everything in one file (3462 lines, 160KB)
│                                 #   Lines 1-1090:    CSS (design tokens, all components)
│                                 #   Lines 1092-1311: HTML body (auth screen, app shell, panels)
│                                 #   Lines 1315-3462: JavaScript (all app logic)
├── manifest.json                 # PWA manifest (standalone, portrait-primary)
├── sw.js                         # Service worker (v2 — never caches HTML)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── firebase.json                 # Only configures Cloud Functions (no hosting)
├── firestore.rules               # Security rules for users + videoCache
├── .firebaserc                   # Firebase project alias
├── Apps_Script_Phase2_addition.js # Legacy batch pipeline (Apps Script reference)
└── functions/
    ├── index.js                  # ★ Cloud Functions (307 lines)
    ├── package.json              # Node 20, firebase-admin, firebase-functions, node-fetch
    └── node_modules/             # Installed dependencies
```

---

## 4. KEY TECHNOLOGIES & DEPENDENCIES

### Client-Side
| Technology | Version | Usage |
|---|---|---|
| Firebase JS SDK | 10.12.0 (compat) | Auth, Firestore, Functions |
| Google Fonts | — | Bebas Neue (display), DM Sans (body) |
| YouTube Data API v3 | — | Channel search, video fetch, trending, search |
| Vanilla CSS/JS | — | No frameworks, no build tools |

### Server-Side (Cloud Functions)
| Dependency | Version | Usage |
|---|---|---|
| firebase-admin | ^12.0.0 | Firestore read/write |
| firebase-functions | ^5.0.0 | onCall functions, secrets |
| node-fetch | ^2.7.0 | External API calls |
| Node.js | 20 | Runtime |

### External APIs (Server-Side)
| API | Purpose | Secret Key |
|---|---|---|
| Supadata | YouTube transcript extraction | `SUPADATA_KEY` |
| Gemini 2.5 Flash | AI summarization & Q&A | `GEMINI_KEY` |

---

## 5. DESIGN SYSTEM

### Color Tokens (Dark Theme Only)
```css
--bg:       #0f0f0f    /* Deepest background */
--bg2:      #161616    /* Card background */
--bg3:      #1e1e1e    /* Elevated surfaces, inputs */
--surface:  #242424    /* Hover states */
--border:   #2e2e2e    /* Subtle borders */
--border2:  #3a3a3a    /* Prominent borders */
--text:     #f0ede8    /* Primary text */
--text2:    #a09d97    /* Secondary text */
--text3:    #6b6865    /* Muted text */
--accent:   #ff4d1c    /* Primary accent (orange-red) */
--accent2:  #ff7a4d    /* Light accent (hover) */
--green:    #22c55e    /* Success / live status */
```

### Typography
- **Display**: `Bebas Neue` — logos, headings, stats
- **Body**: `DM Sans` — all body text, buttons, inputs
- **Base size**: 15px, line-height 1.6

### Spacing & Radius
- `--radius: 10px` — standard components
- `--radius-lg: 16px` — cards
- `--transition: 0.18s ease` — universal transition

### Key CSS Patterns
- **Screen system**: `.screen` hidden, `.screen.active` shown
- **Cards**: `.card` with `.expanded` and `.detail-open` states
- **Panels**: Slide-over from right with overlay backdrop
- **Chips**: Pill-shaped filter buttons with `.active` state
- **Skeletons**: Shimmer animation loading placeholders
- **Step indicators**: Multi-step loading progress UI

---

## 6. APP SCREENS & TABS

### Auth Screen (`#screen-auth`)
- **Anonymous Firebase sign-in** — no Google account required, one tap to start
- Button: "Get Started — No Sign-in Required"
- Fine print: "Your progress is saved locally. Switch devices to transfer."
- Branded card layout with radial gradient accent background
- ⚠️ Data is tied to the anonymous UID — switching devices loses data unless manually migrated

### Main App (`#screen-app`) — 3 Tabs
1. **My Feed** (`section-feed`):
   - Horizontal channel filter chips
   - Video cards grouped by date (Today, Yesterday, etc.)
   - Each card: side thumbnail (168px), channel badge, age, view count
   - Expandable summary panel with "Summary" / "Ask AI" tabs
   - On-demand summary generation with step indicator
   - Related videos carousel within expanded card
   - Bookmark button
   - **Search results also render inside this section** (feed elements hidden when search is active)

2. **Trending** (`section-trending`):
   - Category filter bar (All, Science & Tech, Education, etc.)
   - Region-based via user's country setting
   - Ranked cards with position numbers
   - On-demand summary generation

3. **Saved** (`section-saved`):
   - Bookmarked videos with pre-loaded summaries
   - Cards use **same side-thumbnail layout** as feed cards (168px wide, not full-width banner)
   - Accordion expand/collapse via `toggleSavedExpand()` — one card open at a time
   - Summary, full breakdown, and Watch button all inside the collapsed panel
   - Remove button inline in the card action row
   - Persistent in Firestore user document

> **No Search tab** — search is driven exclusively by the persistent header search bar.
> Typing triggers `switchTab('search')` which hides feed content and renders results in-place.
> Clearing the search bar returns to the My Feed view.

### Channel Panel (Slide-over)
- Search YouTube channels
- Add/remove channels (max 20)
- Stored in Firestore `users/{uid}.channels[]`

### User Dropdown Menu
- Region selector (10 countries)
- Feed window selector (3/7/14/21/30 days)
- Sign out button

---

## 7. DATA FLOW

### Feed Loading Flow
```
1. auth.onAuthStateChanged → initApp()  [anonymous UID, stable per device]
2. loadCountry() → reads users/{uid}.country, daysBack
3. loadUserChannels() → reads users/{uid}.channels[]
4. loadFeed():
   a. fetchChannelVideos(ch) per channel (parallel) → YouTube Playlist API
      - Gets upload playlist ID
      - Paginates up to 3 pages (150 videos max)
      - Filters to DAYS_BACK window
   b. Flatten + deduplicate by videoId
   c. Sort by date (newest first)
   d. enrichWithStats() → YouTube Videos API (view counts, published age)
   e. loadSummaries() → Firestore videoCache batch reads (chunks of 10)
5. renderAll() → groupByDate → renderGroups → buildCard
```

### On-Demand Summary Generation
```
1. User clicks "Summary" expand button on a video card
2. If summaryState === 'pending' → fetchSummaryOnDemand()
3. Shows step indicator (Fetching transcript → Analyzing → Writing)
4. Calls Cloud Function: summarizeVideo({videoId, title, ...})
5. Cloud Function:
   a. Checks Firestore videoCache for existing summary
   b. If not cached: checks/increments user quota (50/week)
   c. Fetches transcript via Supadata API
   d. Sends to Gemini 2.5 Flash with structured prompt
   e. Parses JSON response: { short_summary, detailed_summary }
   f. Writes to Firestore videoCache
   g. Returns to client
6. Client renders short summary + detailed breakdown + related videos
7. On quota error (functions/resource-exhausted):
   - Shows "⚠ Weekly summary limit reached. Resets Monday."
   - Retry button is hidden (retrying is pointless when quota is exhausted)
```

### Ask AI Flow
```
1. User switches to "Ask AI" tab in card panel
2. initAskContext() — checks transcriptCache in Firestore
3. User types question or picks suggestion
4. Calls Cloud Function: askAboutVideo({videoId, question, history})
5. Cloud Function:
   a. Gets transcript from cache or Supadata
   b. Gets summary from videoCache as fallback
   c. Builds system prompt with video content
   d. Includes conversation history (up to 20 turns)
   e. Calls Gemini with Google Search grounding enabled
   f. Returns answer
6. Client appends AI message bubble, updates history
```

---

## 8. CLOUD FUNCTIONS DETAILS

### `summarizeVideo` (onCall)
- **Region**: asia-south1
- **Timeout**: 120s
- **Memory**: 256MiB
- **Secrets**: SUPADATA_KEY, GEMINI_KEY
- **Auth**: Required (anonymous or Google)
- **Quota**: 50 summaries/week/user (resets Monday)
- **Dev bypass**: UIDs in `DEV_UIDS` set skip quota
- **Cache**: Checks videoCache first; returns cached if exists
- **Transcript**: Via Supadata API (8s timeout, max 20K chars)
- **AI Model**: Gemini 2.5 Flash, temperature 0.3
- **Prompt**: Returns JSON with `short_summary` + `detailed_summary`

### `askAboutVideo` (onCall)
- **Region**: asia-south1
- **Timeout**: 60s
- **Memory**: 256MiB
- **Auth**: Required
- **No separate quota** (uses transcript/summary caches)
- **Grounding**: Google Search tool enabled
- **Context**: Full transcript preferred, summary fallback
- **History**: Passed from client, last 20 messages

---

## 9. FIRESTORE SCHEMA

### `users/{uid}` (read/write by owner)
```json
{
  "channels": [
    { "id": "UCxxxxxx", "name": "Channel Name", "thumbnail": "https://..." }
  ],
  "saved": [
    {
      "videoId": "...",
      "title": "...",
      "channel": "...",
      "videoUrl": "...",
      "thumbnail": "...",
      "savedAt": "ISO date",
      "shortSummary": "...",
      "detailedSummary": "..."
    }
  ],
  "country": "IN",
  "daysBack": 7
}
```

### `videoCache/{videoId}` (read: any auth user, write: server only)
```json
{
  "videoId": "...",
  "title": "...",
  "channel": "...",
  "date": "2026-06-10",
  "videoUrl": "...",
  "shortSummary": "...",
  "detailedSummary": "...",
  "hadTranscript": true,
  "cachedAt": "ISO timestamp"
}
```

### `transcriptCache/{videoId}` (server-managed)
```json
{
  "transcript": "Full transcript text...",
  "cachedAt": "ISO timestamp"
}
```

### `quotas/{uid}` (server-managed)
```json
{
  "week": "2026-06-09",
  "count": 12
}
```

---

## 10. API KEYS & SECURITY

> [!CAUTION]
> **API keys are hardcoded in client-side code.** The YouTube API key (`YT_KEY`) and Firebase config are exposed in `index.html`. This is acceptable for a personal project but would need securing for production.

| Key | Location | Restrictions |
|---|---|---|
| Firebase Config | `index.html` L1321-1328 | Domain-restricted in Firebase Console |
| YouTube API Key | `index.html` L1333 | Should be HTTP referrer restricted |
| SUPADATA_KEY | Firebase Secrets | Server-side only |
| GEMINI_KEY | Firebase Secrets | Server-side only |

### CORS Origins (Cloud Functions)
```javascript
const CORS_ORIGINS = [
  'https://aryaarasan.github.io',
  'http://localhost',
  'http://127.0.0.1',
];
```

### Dev Bypass UIDs
```javascript
const DEV_UIDS = new Set([
  'bSK3dQARB3PRAbe7notSr9gZP5N2',
  '9DzujGsyn9SmkpZURFOXt0qCwzG2',
]);
```

---

## 11. SERVICE WORKER STRATEGY

- **Version**: `ytdigest-v2`
- **index.html**: NEVER cached (always fresh from network)
- **Google Fonts**: Cache-first (immutable URLs)
- **Google Sheets data**: Network-first with cache fallback
- **Everything else**: Network-first with cache fallback
- **Activation**: Deletes all old caches, claims all tabs immediately

---

## 12. DEVELOPMENT RULES

### Architecture Rules
1. **Single-file architecture**: The entire frontend lives in `index.html` — CSS, HTML, and JS. Do NOT split into separate files unless the user explicitly requests it.
2. **No build tools**: There is no bundler, no npm for the frontend, no framework. All client-side code is vanilla HTML/CSS/JS loaded via CDN scripts.
3. **Firebase compat SDK**: Uses `firebase-*-compat.js` CDN scripts (v10.12.0). Do NOT switch to modular imports.
4. **No framework**: No React, Vue, Angular. Pure DOM manipulation with `innerHTML`, `createElement`, event listeners.

### Code Style Rules
5. **Inline everything**: New CSS goes inside the `<style>` block (lines 21–1090). New JS goes inside the `<script>` block (lines 1315–3462). No external files.
6. **Functions are global**: All JS functions are in global scope (no modules, no classes). Keep this pattern.
7. **HTML templates**: Video cards, modals, panels are built via template literals in JS functions (`buildCard`, `buildTrendingCard`, `renderSavedTab`, etc.).
8. **XSS safety**: Always use the `esc()` function for user-provided strings in HTML templates.
9. **State management**: App state is in module-level variables (`currentUser`, `userChannels`, `allVideos`, `activeFilter`, `savedVideoIds`, etc.). No state library.

### Design Rules
10. **Dark theme only**: The app uses a dark color scheme. All new UI must use the existing CSS custom properties (`--bg`, `--text`, `--accent`, etc.).
11. **Design language**: Follow the existing card-based, minimal aesthetic. Use existing component patterns (chips, badges, panels, modals).
12. **Animations**: Use `cardIn` keyframe for new elements. Use `var(--transition)` for hover/state changes.
13. **Typography**: Display headings use `var(--font-display)` (Bebas Neue). Body text uses `var(--font-body)` (DM Sans).
14. **Responsive**: Mobile-first. Breakpoint at 560px (see CSS near line 1077).

### Auth Rules
15. **Anonymous auth only**: The app uses `auth.signInAnonymously()`. Do NOT reintroduce Google OAuth or any other provider without explicit user instruction.
16. **Anonymous UID logging**: On sign-in, the UID is logged to the browser console with a styled message for easy copying to the dev bypass list.
17. **Reset & Sign Out**: Sign-out includes a confirmation dialog that deletes the user's Firestore document (`users/{uid}`) before signing out.

### Firebase Rules
18. **Firestore reads**: Client reads from `videoCache` (any authenticated user) and `users/{uid}` (own data only).
19. **Firestore writes**: Client writes ONLY to `users/{uid}`. `videoCache` and `transcriptCache` are server-write only.
20. **Cloud Functions**: All sensitive operations (Gemini calls, Supadata calls, quota management) go through Cloud Functions, NEVER client-side.
21. **Secrets**: API keys for Supadata and Gemini are stored as Firebase secrets (`defineSecret`). Never expose them client-side.

### YouTube API Rules
22. **API key**: The YouTube Data API v3 key is in `YT_KEY` constant. All YouTube API calls are client-side (channel search, playlist items, video stats, trending).
23. **Pagination**: Channel video fetching paginates up to 3 pages (150 videos) to handle high-frequency channels.
24. **Rate limiting**: 2-second delay between video processing in Apps Script batch pipeline.

### Cloud Function Rules
25. **Region**: All functions deploy to `asia-south1`.
26. **Authentication**: All functions require `request.auth` (Firebase Auth — anonymous tokens are valid).
27. **Quota system**: Weekly per-user limit of 50 Gemini API calls, tracked in `quotas/{uid}`. Dev UIDs bypass this.
28. **Caching strategy**: Always check `videoCache` before calling Gemini. Write results back to cache.
29. **Transcript handling**: Try Supadata first (8s timeout), truncate at 20,000 chars. Cache in `transcriptCache`.
30. **Error handling**: Firestore cache errors are non-fatal; Gemini errors throw `HttpsError`. Quota errors use code `functions/resource-exhausted`.
31. **Quota error UX**: Client detects `functions/resource-exhausted` or messages containing 'limit' and shows a specific friendly message. The Retry button is hidden in this case.

### Deployment
32. **Frontend**: Hosted on GitHub Pages (push to repo). No Firebase Hosting configured.
33. **Functions**: Deploy via `firebase deploy --only functions` from the `functions/` directory.
34. **PWA**: `manifest.json` + `sw.js` enable installability. Service worker registered on page load.

### Testing / Debugging
35. **Dev UIDs**: Anonymous UIDs are logged to the browser console on sign-in (styled orange message). Copy the UID and add it to `DEV_UIDS` in `functions/index.js` to skip quota checks.
36. **Console logging**: Cloud Functions log to Google Cloud Logging (Gemini responses, cache hits, transcript sources).
37. **Status dot**: Header dot shows app state — green (ok), pulsing gray (loading), red (error).

---

## 13. KNOWN PATTERNS TO PRESERVE

### Card Expand/Collapse (accordion-style)
- Only one card expanded at a time per feed section
- Expanding a card collapses all others
- Summary state tracked via `data-summaryState` attribute: `'pending'` → `'loading'` → `'done'`
- **Saved tab** also uses accordion expand via `toggleSavedExpand()` — class `detail-open` on the card; detail toggle inside uses class `full-detail`

### Search UX Pattern
- **No dedicated Search tab** — search is driven by the persistent header bar only
- Typing in the header bar calls `switchTab('search')`, which:
  - Keeps `#section-feed` visible (display: block)
  - Hides `.channel-filter-row`, `#feed`, `.last-updated` elements inside it
  - Shows `#section-search` (the results container) inside the same space
  - Highlights the **My Feed** tab button as active
- Clearing the search bar calls `switchTab('feed')` to restore the normal feed view
- The in-tab `video-search-input` element still exists in HTML but is no longer synced to the header bar (no redundant listener)

### Step Indicator Pattern
When generating a summary on-demand:
```
1. Show step indicator with 3 steps (transcript → analyze → write)
2. Animate steps sequentially with timed delays
3. Make actual API call in parallel
4. Mark steps done as API resolves
5. On quota error: show specific message, suppress Retry button
```

### Related Videos Pattern
- Extract keywords from title + summary
- Search YouTube for related videos
- Display as horizontal scroll carousel
- Click opens a modal with full summary generation
- Modal also has "Ask AI" tab + its own related videos

### Bookmark Pattern
- Bookmark button on every card type (feed, trending)
- If no summary exists when bookmarking, auto-generate it first
- Saved data stored in Firestore `users/{uid}.saved[]` array
- Saved tab renders from Firestore, not from in-memory state

### Saved Card Layout
- Matches the standard feed card: **side thumbnail (168px wide)** + meta on the right
- Thumbnail has hover zoom + play overlay (same as feed cards)
- Title is a clickable link to the video
- Expand button shows accordion with: short summary → full breakdown toggle → Watch button
- Expand state uses class `detail-open`; inner detail toggle uses class `full-detail` (separate)

---

## 14. APPS SCRIPT LEGACY PIPELINE

`Apps_Script_Phase2_addition.js` is a reference file showing how the legacy Google Apps Script batch pipeline writes to Firestore. It's NOT deployed from this repo — it runs inside Google Apps Script IDE. The pipeline:
1. Fetches recent videos from subscribed channels
2. Gets transcripts via a separate service
3. Summarizes with Gemini
4. Writes to Google Sheets AND Firestore `videoCache`

This is supplementary to the on-demand Cloud Functions approach and may not be actively maintained.
