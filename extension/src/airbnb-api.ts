// Direct fetch of reviews from Airbnb's internal GraphQL endpoint.
// This is the same persisted-query call the listing page uses to render
// reviews. We run it from the user's authenticated browser context
// (credentials: "include") so it inherits their session cookies.
//
// The persisted-query hash and the public API key are extracted from
// Airbnb's frontend bundle. They rotate occasionally — when they do, the
// request returns 400 with error_type "persisted_query_not_found" and we
// fall back to DOM scraping.

import type { Review } from "./types.js";

// Last verified: April 2026
const DEFAULT_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";
const DEFAULT_REVIEWS_QUERY_HASH =
  "2ed951bfedf71b87d9d30e24a419e15517af9fbed7ac560a8d1cc7feadfa22e6";
const PAGE_SIZE = 24;

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

// Try to grab a fresh API key + persisted-query hash from the page in case the
// hardcoded ones have rotated. Best-effort; falls back to defaults silently.
function sniffCredentials(): { apiKey: string; hash: string } {
  let apiKey = DEFAULT_API_KEY;
  let hash = DEFAULT_REVIEWS_QUERY_HASH;

  const meta = document.querySelector('meta[name="airbnb-api-key"]');
  if (meta) {
    const v = meta.getAttribute("content");
    if (v) apiKey = v;
  }

  // Search inline scripts for either an api key or the StaysPdpReviewsQuery
  // hash. Airbnb embeds these as JSON in their bootstrap scripts.
  const scripts = Array.from(document.querySelectorAll("script"));
  for (const s of scripts) {
    const t = s.textContent || "";
    if (t.length === 0) continue;
    if (apiKey === DEFAULT_API_KEY) {
      const m =
        t.match(/"api_config":\s*{\s*"key":\s*"([^"]+)"/) ||
        t.match(/X-Airbnb-API-Key[^"]*"\s*:\s*"([^"]+)"/);
      if (m) apiKey = m[1];
    }
    if (hash === DEFAULT_REVIEWS_QUERY_HASH) {
      const m = t.match(
        /StaysPdpReviewsQuery[^"]*"[^{]*"sha256Hash":\s*"([a-f0-9]{64})"/,
      );
      if (m) hash = m[1];
    }
    if (apiKey !== DEFAULT_API_KEY && hash !== DEFAULT_REVIEWS_QUERY_HASH) {
      break;
    }
  }

  return { apiKey, hash };
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

// Strip Airbnb's <br/> markup. Reviews come as HTML-ish strings.
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

export async function fetchAllReviews(opts: {
  listingId: string;
  locale?: string;
  currency?: string;
  maxReviews?: number;
}): Promise<{ reviews: Review[]; total: number }> {
  const { apiKey, hash } = sniffCredentials();
  const listingIdGlobal = btoa(`StayListing:${opts.listingId}`).replace(
    /=+$/,
    "",
  );
  const locale = opts.locale ?? "en";
  const currency = opts.currency ?? "USD";
  const maxReviews = opts.maxReviews ?? 200;

  const collected: Review[] = [];
  let total = 0;

  for (let offset = 0; offset < maxReviews; offset += PAGE_SIZE) {
    const url = buildUrl({
      origin: location.origin,
      hash,
      listingIdGlobal,
      offset,
      locale,
      currency,
    });
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "X-Airbnb-API-Key": apiKey,
        Accept: "application/json",
      },
    });

    // Persisted-query rotation: bubble up so caller can fall back to DOM.
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
    const batch = block?.reviews ?? [];
    if (block?.metadata?.reviewsCount && total === 0) {
      total = block.metadata.reviewsCount;
    }
    if (batch.length === 0) break;

    for (const r of batch) {
      const rev = toReview(r);
      if (rev) collected.push(rev);
    }

    if (collected.length >= total && total > 0) break;
    if (collected.length >= maxReviews) break;
  }

  return { reviews: collected.slice(0, maxReviews), total };
}
