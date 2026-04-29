// Direct fetch of reviews from Airbnb's internal GraphQL endpoint.
// This is the same persisted-query call the listing page uses to render
// reviews. We run it from the user's authenticated browser context
// (credentials: "include") so it inherits their session cookies.
//
// Credential strategy (Option A):
//   1. Sniff the API key + persisted-query hash from the live page bundle
//      (api_config JSON + StaysPdpReviewsQuery registration block).
//   2. Cache the result in module scope so we don't re-walk inline scripts
//      on every page (it's reset when the content script restarts on full
//      page load, which is exactly when the bundle could have changed).
//   3. Fall back to hardcoded defaults if sniff returns nothing — they're a
//      safety net, not the primary path.
//   4. On 400 persisted_query_not_found, invalidate the cache, re-sniff,
//      and retry once. Self-heals when Airbnb rotates the hash.

import type { Review } from "./types.js";

// Last verified April 2026. These exist as a fallback when sniffing fails;
// they will go stale eventually, hence the runtime sniff above.
const FALLBACK_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";
const FALLBACK_REVIEWS_QUERY_HASH =
  "2ed951bfedf71b87d9d30e24a419e15517af9fbed7ac560a8d1cc7feadfa22e6";
const PAGE_SIZE = 24;

type Credentials = { apiKey: string; hash: string; source: "sniff" | "fallback" };

// Module-scoped cache. Lifetime = content-script lifetime (resets on full
// page reload, which is when the bundle could have changed anyway).
let cachedCreds: Credentials | null = null;

type GraphQLReview = {
  id: string;
  comments: string;
  localizedDate?: string;
  createdAt?: string;
  rating?: number;
  language?: string;
  reviewer?: { firstName?: string };
  response?: string;
};

type GraphQLResponse = {
  data?: {
    presentation?: {
      stayProductDetailPage?: {
        reviews?: {
          reviews?: GraphQLReview[];
          metadata?: { reviewsCount?: number };
        };
      };
    };
  };
  error_code?: number;
  error_type?: string;
  error_message?: string;
};

export class PersistedQueryRotated extends Error {
  constructor() {
    super("Airbnb persisted-query hash has rotated.");
    this.name = "PersistedQueryRotated";
  }
}

// Strict matchers. We only accept values that appear inside known-good
// JSON shapes that Airbnb actually uses to bootstrap their frontend.
// A loose hex match anywhere on the page would be unsafe — tracking pixels,
// analytics blobs, and CSP nonces all contain hex strings.

// API key shape in api_config block:
//   "api_config": { "key": "<32-char>", ... }
// Allow any reasonable whitespace around the JSON tokens.
const API_KEY_PATTERN = /"api_config"\s*:\s*\{\s*"key"\s*:\s*"([a-zA-Z0-9_-]{16,64})"/;

// Persisted-query hash shape near the operation registration. Airbnb's
// bundle registers each persisted operation with both its name and its
// hash. We require both to appear within a small window of each other.
// The window is loose enough to handle JSON-pretty-printed and minified
// bundle variants.
const REVIEWS_HASH_PATTERN =
  /StaysPdpReviewsQuery[\s\S]{0,200}?"sha256Hash"\s*:\s*"([a-f0-9]{64})"/;
const REVIEWS_HASH_PATTERN_REVERSED =
  /"sha256Hash"\s*:\s*"([a-f0-9]{64})"[\s\S]{0,200}?StaysPdpReviewsQuery/;

function sniffFromPage(): { apiKey?: string; hash?: string } {
  const out: { apiKey?: string; hash?: string } = {};

  // Meta tag is the cleanest place — try it first.
  const meta = document.querySelector('meta[name="airbnb-api-key"]');
  const metaKey = meta?.getAttribute("content");
  if (metaKey && /^[a-zA-Z0-9_-]{16,64}$/.test(metaKey)) {
    out.apiKey = metaKey;
  }

  // Walk inline scripts. Skip empty or src-only ones.
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script"));
  for (const s of scripts) {
    if (out.apiKey && out.hash) break;
    const t = s.textContent;
    if (!t || t.length < 64) continue;

    if (!out.apiKey) {
      const m = t.match(API_KEY_PATTERN);
      if (m) out.apiKey = m[1];
    }
    if (!out.hash) {
      const m = t.match(REVIEWS_HASH_PATTERN) ?? t.match(REVIEWS_HASH_PATTERN_REVERSED);
      if (m) out.hash = m[1];
    }
  }

  return out;
}

function getCredentials(forceFresh = false): Credentials {
  if (!forceFresh && cachedCreds) return cachedCreds;

  const sniffed = sniffFromPage();
  const apiKey = sniffed.apiKey ?? FALLBACK_API_KEY;
  const hash = sniffed.hash ?? FALLBACK_REVIEWS_QUERY_HASH;
  const fullySniffed = !!(sniffed.apiKey && sniffed.hash);

  const creds: Credentials = {
    apiKey,
    hash,
    source: fullySniffed ? "sniff" : "fallback",
  };

  // Only cache fully-sniffed creds. If we used the fallback for either
  // value, don't pin it — we want the next call to try sniffing again in
  // case the page bundle finished loading.
  if (fullySniffed) {
    cachedCreds = creds;
  }

  return creds;
}

function invalidateCachedCredentials(): void {
  cachedCreds = null;
}

function buildUrl(opts: {
  origin: string;
  hash: string;
  listingIdGlobal: string;
  offset: number;
  locale: string;
  currency: string;
}): string {
  const variables = {
    id: opts.listingIdGlobal,
    pdpReviewsRequest: {
      fieldSelector: "for_p3_translation_only",
      forPreview: false,
      limit: PAGE_SIZE,
      offset: String(opts.offset),
      showingTranslationButton: false,
      first: PAGE_SIZE,
      sortingPreference: "MOST_RECENT",
    },
  };
  const extensions = {
    persistedQuery: { version: 1, sha256Hash: opts.hash },
  };
  return (
    `${opts.origin}/api/v3/StaysPdpReviewsQuery/${opts.hash}` +
    `?operationName=StaysPdpReviewsQuery` +
    `&locale=${encodeURIComponent(opts.locale)}` +
    `&currency=${encodeURIComponent(opts.currency)}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
  );
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function toReview(r: GraphQLReview): Review | null {
  const text = htmlToText(r.comments || "");
  if (text.length < 25) return null;
  return {
    id: r.id,
    date: r.localizedDate || r.createdAt || "unknown",
    text: text.slice(0, 1500),
    ...(typeof r.rating === "number" ? { rating: r.rating } : {}),
  };
}

async function fetchPage(
  creds: Credentials,
  opts: {
    listingIdGlobal: string;
    offset: number;
    locale: string;
    currency: string;
  },
): Promise<{
  batch: GraphQLReview[];
  reviewsCount: number;
}> {
  const url = buildUrl({
    origin: location.origin,
    hash: creds.hash,
    listingIdGlobal: opts.listingIdGlobal,
    offset: opts.offset,
    locale: opts.locale,
    currency: opts.currency,
  });
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      "X-Airbnb-API-Key": creds.apiKey,
      Accept: "application/json",
    },
  });

  if (res.status === 400) {
    let body: GraphQLResponse | null = null;
    try {
      body = (await res.json()) as GraphQLResponse;
    } catch {
      // ignore
    }
    if (body?.error_type === "persisted_query_not_found") {
      throw new PersistedQueryRotated();
    }
    throw new Error(`API 400: ${body?.error_message ?? "bad request"}`);
  }
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }

  const json = (await res.json()) as GraphQLResponse;
  const block = json.data?.presentation?.stayProductDetailPage?.reviews;
  return {
    batch: block?.reviews ?? [],
    reviewsCount: block?.metadata?.reviewsCount ?? 0,
  };
}

export async function fetchAllReviews(opts: {
  listingId: string;
  locale?: string;
  currency?: string;
  maxReviews?: number;
}): Promise<{ reviews: Review[]; total: number }> {
  const listingIdGlobal = btoa(`StayListing:${opts.listingId}`).replace(/=+$/, "");
  const locale = opts.locale ?? "en";
  const currency = opts.currency ?? "USD";
  const maxReviews = opts.maxReviews ?? 200;

  const collected: Review[] = [];
  let total = 0;

  let creds = getCredentials();
  let retriedAfterRotation = false;

  for (let offset = 0; offset < maxReviews; offset += PAGE_SIZE) {
    let page: { batch: GraphQLReview[]; reviewsCount: number };
    try {
      page = await fetchPage(creds, {
        listingIdGlobal,
        offset,
        locale,
        currency,
      });
    } catch (e) {
      if (e instanceof PersistedQueryRotated && !retriedAfterRotation) {
        // Hash rotated. Drop the cache, re-sniff, and try this same offset
        // again. We only retry once — if the new creds don't work either,
        // we surface the error so the caller can fall back to DOM scraping.
        retriedAfterRotation = true;
        invalidateCachedCredentials();
        creds = getCredentials(/* forceFresh */ true);
        // If the re-sniff didn't actually find anything new, don't loop
        // retrying with the same fallback values.
        if (creds.source !== "sniff") throw e;
        offset -= PAGE_SIZE; // retry the same offset
        continue;
      }
      throw e;
    }

    if (total === 0 && page.reviewsCount > 0) total = page.reviewsCount;
    if (page.batch.length === 0) break;

    for (const r of page.batch) {
      const rev = toReview(r);
      if (rev) collected.push(rev);
    }

    if (collected.length >= total && total > 0) break;
    if (collected.length >= maxReviews) break;
  }

  return { reviews: collected.slice(0, maxReviews), total };
}
