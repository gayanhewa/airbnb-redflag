# Runbook

Day-to-day instructions for building, installing, debugging, and maintaining
the extension.

## 1. First-time setup

### 1.1 Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 1.2 Install dependencies

```bash
cd extension
bun install
```

### 1.3 Build

```bash
bun run build           # one-shot
bun run dev             # watch mode (rebuilds on src/ change)
```

Output: `extension/dist/` (gitignored).

### 1.4 Load into Chrome

1. Open `chrome://extensions/`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select `extension/dist/`

The extension card appears. After every rebuild, click the refresh icon on
its card.

### 1.5 Verify Gemini Nano availability

Two ways:

- Visit `chrome://on-device-internals` — look for "Foundational Model" with
  status `Ready` or similar.
- On any normal webpage, open DevTools → Console:
  ```js
  typeof LanguageModel
  await LanguageModel.availability()
  ```
  Must return `"function"` and `"available"` (or `"downloadable"`).

If `LanguageModel` is `undefined`:
- Enable `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
- Enable `chrome://flags/#optimization-guide-on-device-model` →
  **Enabled BypassPerfRequirement**
- Fully quit and relaunch Chrome (not just close the window)

Hardware requirements: macOS 13+/Win 10+/Linux/ChromeOS, 22 GB free disk,
GPU with 4 GB+ VRAM, unmetered network for the initial model download.

## 2. Daily use

1. Open any `https://www.airbnb.com/rooms/<id>` (or regional TLD: `.com.au`,
   `.co.uk`, `.ca`)
2. The badge appears top-right within ~10 seconds (cache hit) or ~1–2
   minutes (first visit)
3. Click the badge → side panel opens
4. Re-visiting any listing within 90 days hits the cache and renders
   instantly

## 3. Reading the output

### Trust score bands

| Score   | Band  | Suggested behavior                         |
| ------- | ----- | ------------------------------------------ |
| 75–100  | 🟢    | Probably fine; skim flags anyway           |
| 55–74   | 🟡    | Read flags carefully — score is noisy here |
| 0–54    | 🔴    | Take seriously; cross-check actual reviews |

**The flag list is more informative than the number.** Severity-3 flags
(bedbugs, dangerous, scam) and any tripped pattern warnings deserve
attention regardless of score.

### Pattern warnings

These are deterministic JS heuristics, not LLM output:

- "N of M reviews are very short (under 80 chars)" → possible templated
  reviews
- "Identical phrase appears in N reviews" → copy-paste suspicion

A listing tripping both is suspect even if its trust score is high.

## 4. Debugging

### 4.1 Badge doesn't appear on a listing

Check the tab's DevTools console for errors:

```
Right-click on the page → Inspect → Console
```

Common causes:
- Extension wasn't reloaded after a rebuild
- Listing has zero reviews (badge shows error message)
- Gemini Nano unavailable (badge shows error)

### 4.2 Background service worker errors

```
chrome://extensions/ → click the extension card →
  "Inspect views: service worker"
```

This opens DevTools attached to the background context.

### 4.3 Offscreen page errors

The offscreen page is hidden but inspectable:

```
chrome://extensions/ → click the extension card →
  "Inspect views: offscreen.html"
```

(Only visible while a job is running. You may need to trigger an analysis
on a fresh listing first.)

### 4.4 Side panel errors

```
Open the side panel → right-click inside it → Inspect
```

### 4.5 Verify the API call

In the listing tab's DevTools console:

```js
const HASH = "2ed951bfedf71b87d9d30e24a419e15517af9fbed7ac560a8d1cc7feadfa22e6";
const id = btoa(`StayListing:30719772`).replace(/=+$/, "");
const v = encodeURIComponent(JSON.stringify({
  id,
  pdpReviewsRequest: {
    fieldSelector: "for_p3_translation_only",
    forPreview: false, limit: 24, offset: "0",
    showingTranslationButton: false, first: 24,
    sortingPreference: "MOST_RECENT",
  },
}));
const e = encodeURIComponent(JSON.stringify({
  persistedQuery: { version: 1, sha256Hash: HASH },
}));
const r = await fetch(
  `${location.origin}/api/v3/StaysPdpReviewsQuery/${HASH}` +
  `?operationName=StaysPdpReviewsQuery&locale=en&currency=USD` +
  `&variables=${v}&extensions=${e}`,
  {
    credentials: "include",
    headers: { "X-Airbnb-API-Key": "d306zoyjsyarp7ifhu67rjxn52tv0t20" },
  },
);
console.log(r.status, (await r.json()).data?.presentation?.stayProductDetailPage?.reviews?.metadata);
```

Status 200 + `reviewsCount` = working. Status 400 + `error_type:
persisted_query_not_found` = hash rotated; see §5.

### 4.6 Force a fresh analysis (clear cache for one listing)

Replace `<ID>` with the numeric listing ID:

```js
// In the side panel's DevTools (or any extension context):
chrome.storage.local.remove("cache:<ID>");
```

Or wipe everything:

```js
chrome.storage.local.clear();
```

## 5. Maintenance

### 5.1 Airbnb rotated the persisted-query hash

Symptom: API call returns
`{"error_code":400,"error_type":"persisted_query_not_found"}`. The
extension auto-falls-back to DOM scraping (slow, brittle), but the fix is
to update the hash.

How to find the new hash:

1. Open an Airbnb listing
2. DevTools → Network tab → filter for `StaysPdpReviewsQuery`
3. Click the request → Headers → "Request URL"
4. The 64-char hex string after `/api/v3/StaysPdpReviewsQuery/` is the new
   hash. It also appears in the `extensions` query param as `sha256Hash`
5. Update `DEFAULT_REVIEWS_QUERY_HASH` in `extension/src/airbnb-api.ts`
6. Rebuild and reload the extension

### 5.2 Airbnb rotated the public API key

Same procedure as 5.1 — the key is in the request's `X-Airbnb-API-Key`
header. Update `DEFAULT_API_KEY` in `airbnb-api.ts`.

(The key has been `d306zoyjsyarp7ifhu67rjxn52tv0t20` for a long time, so
this is unlikely.)

### 5.3 Airbnb DOM changed and the fallback scraper broke

`extension/src/content.ts` has the DOM scraper as a last-resort fallback.
The selectors that matter:

- `[role="dialog"][aria-label*="reviews"]` — the reviews modal
- The "header" pattern: `^<Name>\n... on Airbnb` — identifies review blocks
- Walking up from the header div to the smallest ancestor that also
  contains the review body

When Airbnb changes any of these, run a similar DOM probe to what's
documented in the project history. Inspect the rendered modal in DevTools
and adjust the selectors.

### 5.4 Bumping cache TTL

`extension/src/cache.ts` → `CACHE_TTL_MS`. Currently 90 days.

### 5.5 Adjusting score weights

`extension/src/analyze.ts`:

- `computeCategoryScores` — per-category penalty per flag (severity 1/2/3
  → −1/−2/−4)
- `computeTrustScore` — overall penalty (severity 1/2/3 → −1/−3/−8)

These weights are calibration choices. Changing them moves all listings'
scores; document the change in a commit message.

### 5.6 Adjusting hallucination filter

`extension/src/analyze.ts` → `quoteAppearsInCorpus`:

- Requires either the full normalized quote as a substring, or any
  contiguous 6-word window
- Lower the window size to 5 words to be more permissive (more false
  positives)
- Raise it to 8 words to be stricter (more false negatives)

## 6. Distribution (future)

Currently load-unpacked only. To publish to the Chrome Web Store:

1. Bump `version` in `extension/manifest.json`
2. `bun run build`
3. `cd extension/dist && zip -r ../airbnb-redflag-vX.Y.Z.zip .`
4. Upload at https://chrome.google.com/webstore/devconsole/

## 7. Privacy notes

- All review data is fetched via the user's authenticated Airbnb session
  (the same way the listing page fetches its own data). Nothing is sent to
  any third party.
- All analysis runs locally in Gemini Nano via the Prompt API. The model
  weights live on the user's device.
- The cache is `chrome.storage.local`, scoped to this extension only. No
  sync, no telemetry.
- The listing ID is the only stable identifier stored.
