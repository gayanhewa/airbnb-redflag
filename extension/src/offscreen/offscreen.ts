// Hidden offscreen document. Content scripts can't access the LanguageModel
// global, but offscreen pages can. The background worker spawns this page
// once and routes analyze requests through it.

import { analyzeReviews, checkAvailability } from "../analyze.js";
import type { AnalyzeJobRequest, AnalyzeJobResponse } from "../types.js";

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type?: string };
  if (m?.type !== "OFFSCREEN_ANALYZE") return false;

  const req = msg as AnalyzeJobRequest;

  (async () => {
    const availability = await checkAvailability();
    if (availability === "unavailable") {
      const r: AnalyzeJobResponse = {
        ok: false,
        error:
          "On-device AI (Gemini Nano) is not available in this Chrome. " +
          "Enable chrome://flags/#prompt-api-for-gemini-nano and restart.",
      };
      sendResponse(r);
      return;
    }
    try {
      const result = await analyzeReviews(req.reviews, (done, total) => {
        chrome.runtime.sendMessage({
          type: "ANALYZE_PROGRESS",
          listingId: req.listingId,
          done,
          total,
        });
      });
      const r: AnalyzeJobResponse = { ok: true, result };
      sendResponse(r);
    } catch (e) {
      const r: AnalyzeJobResponse = {
        ok: false,
        error: e instanceof Error ? e.message : "Analysis failed.",
      };
      sendResponse(r);
    }
  })();

  return true; // async
});
