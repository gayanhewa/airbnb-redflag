// Background service worker. Responsibilities:
//   1. Lazy-spawn the offscreen analyzer document.
//   2. Broker analyze jobs from content scripts → offscreen → cache.
//   3. Open the side panel when the toolbar icon is clicked or the badge
//      requests it, and tell it which listing to render.

import { getCached, setCached } from "./cache.js";
import type {
  AnalyzeJobRequest,
  AnalyzeJobResponse,
  Review,
} from "./types.js";

const OFFSCREEN_PATH = "offscreen.html";

// Track which listing each tab is currently looking at, so the side panel
// can pick up the right cached result on open.
const tabListing = new Map<number, string>();

async function ensureOffscreen() {
  // Avoid the duplicate-document error if it's already open.
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["DOM_PARSER" as chrome.offscreen.Reason],
      justification:
        "Run on-device Gemini Nano analysis (LanguageModel API) which is not available in service workers.",
    });
  } catch (e) {
    // If the document was created concurrently, swallow the error.
    if (
      !(e instanceof Error && /Only a single offscreen/i.test(e.message))
    ) {
      throw e;
    }
  }
}

async function analyzeViaOffscreen(
  listingId: string,
  reviews: Review[],
): Promise<AnalyzeJobResponse> {
  await ensureOffscreen();
  const req: AnalyzeJobRequest = {
    type: "OFFSCREEN_ANALYZE",
    listingId,
    reviews,
  };
  const res = (await chrome.runtime.sendMessage(req)) as AnalyzeJobResponse;
  return res;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  const m = msg as { type?: string };

  if (m?.type === "RUN_FOR_LISTING") {
    const { listingId, reviews } = msg as {
      listingId: string;
      reviews: Review[];
    };
    if (sender.tab?.id) tabListing.set(sender.tab.id, listingId);

    (async () => {
      const cached = await getCached(listingId);
      if (cached) {
        sendResponse({ ok: true, cached: true, result: cached });
        return;
      }
      const res = await analyzeViaOffscreen(listingId, reviews);
      if (res.ok) {
        await setCached(listingId, res.result);
        sendResponse({ ok: true, cached: false, result: res.result });
      } else {
        sendResponse({ ok: false, error: res.error });
      }
    })();
    return true; // async
  }

  if (m?.type === "GET_CACHED_RESULT") {
    const { listingId } = msg as { listingId: string };
    if (sender.tab?.id) tabListing.set(sender.tab.id, listingId);
    getCached(listingId).then((result) =>
      sendResponse({ ok: true, result }),
    );
    return true;
  }

  if (m?.type === "OPEN_SIDE_PANEL_FOR_LISTING") {
    const tabId = sender.tab?.id;
    if (typeof tabId === "number") {
      chrome.sidePanel.open({ tabId }).then(() => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (m?.type === "GET_ACTIVE_LISTING_ID") {
    // Side panel asks: "what listing is the active tab on?"
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!tab?.id) return sendResponse({ listingId: null });
        sendResponse({ listingId: tabListing.get(tab.id) ?? null });
      });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabListing.delete(tabId);
});
