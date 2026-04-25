// Auto-runs on every Airbnb listing page. Fetches reviews via the API,
// checks cache, otherwise asks the background to run analysis. Renders a
// floating trust-score badge with the result; click opens the side panel.

import { fetchAllReviews } from "./airbnb-api.js";
import { setBadgeState } from "./badge.js";
import type { AnalyzeResult, Review } from "./types.js";

function getListingIdFromUrl(): string | null {
  const m = window.location.pathname.match(/\/rooms\/(\d+)/);
  return m ? m[1] : null;
}

function getLocaleAndCurrency(): { locale: string; currency: string } {
  let locale = "en";
  let currency = "USD";
  const scripts = Array.from(document.querySelectorAll("script"));
  for (const s of scripts) {
    const t = s.textContent || "";
    if (t.length === 0) continue;
    const lm = t.match(/"locale":\s*"([a-z]{2}(?:-[A-Z]{2})?)"/);
    if (lm && locale === "en") locale = lm[1];
    const cm = t.match(/"currency":\s*"([A-Z]{3})"/);
    if (cm && currency === "USD") currency = cm[1];
  }
  return { locale, currency };
}

let lastListingId: string | null = null;

async function runForCurrentListing() {
  const listingId = getListingIdFromUrl();
  if (!listingId) return;
  if (listingId === lastListingId) return; // already running/done for this id
  lastListingId = listingId;

  setBadgeState(listingId, { phase: "loading", label: "checking cache…" });

  // Cache hit → instant render.
  const cachedRes = (await chrome.runtime.sendMessage({
    type: "GET_CACHED_RESULT",
    listingId,
  })) as { ok: true; result: AnalyzeResult | null };
  if (cachedRes?.ok && cachedRes.result) {
    setBadgeState(listingId, { phase: "ready", result: cachedRes.result });
    return;
  }

  // No cache → fetch reviews, kick off analysis.
  setBadgeState(listingId, { phase: "loading", label: "fetching reviews…" });
  let reviews: Review[];
  try {
    const { locale, currency } = getLocaleAndCurrency();
    const res = await fetchAllReviews({
      listingId,
      locale,
      currency,
      maxReviews: 200,
    });
    reviews = res.reviews;
  } catch (e) {
    setBadgeState(listingId, {
      phase: "error",
      message:
        "Couldn't fetch reviews (" +
        (e instanceof Error ? e.message : "unknown") +
        ")",
    });
    return;
  }

  if (reviews.length === 0) {
    setBadgeState(listingId, {
      phase: "error",
      message: "No reviews on this listing yet.",
    });
    return;
  }

  setBadgeState(listingId, {
    phase: "loading",
    label: `analyzing ${reviews.length} reviews…`,
  });

  const analyzeRes = (await chrome.runtime.sendMessage({
    type: "RUN_FOR_LISTING",
    listingId,
    reviews,
  })) as
    | { ok: true; cached: boolean; result: AnalyzeResult }
    | { ok: false; error: string };

  if (!analyzeRes?.ok) {
    setBadgeState(listingId, {
      phase: "error",
      message: analyzeRes?.error ?? "Analysis failed.",
    });
    return;
  }

  setBadgeState(listingId, { phase: "ready", result: analyzeRes.result });
}

// Surface incremental progress (analyze batches) coming from the offscreen page.
chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as {
    type?: string;
    listingId?: string;
    done?: number;
    total?: number;
  };
  if (m?.type === "ANALYZE_PROGRESS" && m.listingId === lastListingId) {
    setBadgeState(m.listingId, {
      phase: "loading",
      label: `analyzing… ${m.done ?? 0}/${m.total ?? "?"}`,
    });
  }
});

// Airbnb is a SPA; URL changes don't fire a new content-script load. Watch
// for navigation by polling the path.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    runForCurrentListing();
  }
}, 1000);

runForCurrentListing();
