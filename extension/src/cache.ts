// Shared listing-result cache. Used by both the offscreen analyzer (writer)
// and the side panel + content badge (readers). Keyed by listing ID so the
// cache survives URL query-string churn.

import type { AnalyzeResult } from "./types.js";

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

type CacheEntry = { result: AnalyzeResult; expiresAt: number };

function key(listingId: string) {
  return `cache:${listingId}`;
}

export async function getCached(
  listingId: string,
): Promise<AnalyzeResult | null> {
  const data = await chrome.storage.local.get(key(listingId));
  const entry = data[key(listingId)] as CacheEntry | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    await chrome.storage.local.remove(key(listingId));
    return null;
  }
  return entry.result;
}

export async function setCached(
  listingId: string,
  result: AnalyzeResult,
): Promise<void> {
  const entry: CacheEntry = {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  await chrome.storage.local.set({ [key(listingId)]: entry });
}
