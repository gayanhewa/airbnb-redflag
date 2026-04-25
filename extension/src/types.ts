export type Review = {
  id: string;
  date: string;
  rating?: number;
  text: string;
};

export type FlagCategoryT =
  | "cleanliness"
  | "safety"
  | "accuracy"
  | "host"
  | "hidden_costs";

export type Flag = {
  category: FlagCategoryT;
  severity: 1 | 2 | 3;
  quote: string;
  reviewId?: string;
  reviewDate?: string;
};

export type CategoryScore = {
  category: FlagCategoryT;
  score: number;
  summary: string;
};

export type AnalyzeResult = {
  trustScore: number;
  reviewCount: number;
  categories: CategoryScore[];
  flags: Flag[];
  patternWarnings: string[];
  generatedAt: string;
};

export type ScrapeResult =
  | {
      ok: true;
      listingId: string;
      listingTitle?: string;
      reviews: Review[];
    }
  | { ok: false; error: string };

export type SidePanelState =
  | { phase: "idle" }
  | { phase: "unsupported"; reason: string }
  | { phase: "scraping" }
  | { phase: "analyzing"; done: number; total: number }
  | { phase: "ready"; result: AnalyzeResult; cached: boolean }
  | { phase: "error"; error: string };

// Background <-> offscreen messages.
export type AnalyzeJobRequest = {
  type: "OFFSCREEN_ANALYZE";
  listingId: string;
  reviews: Review[];
};

export type AnalyzeJobResponse =
  | { ok: true; result: AnalyzeResult }
  | { ok: false; error: string };

// Background <-> content messages.
export type RunForListingRequest = {
  type: "RUN_FOR_LISTING";
  listingId: string;
  reviews: Review[];
};

export type GetCachedRequest = {
  type: "GET_CACHED_RESULT";
  listingId: string;
};

export type OpenSidePanelRequest = {
  type: "OPEN_SIDE_PANEL_FOR_LISTING";
  listingId: string;
};
