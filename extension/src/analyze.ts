import type {
  AnalyzeResult,
  CategoryScore,
  Flag,
  FlagCategoryT,
  Review,
} from "./types.js";

const ALL_CATEGORIES: FlagCategoryT[] = [
  "cleanliness",
  "safety",
  "accuracy",
  "host",
  "hidden_costs",
];

// Nano's context is small. Keep batches modest so the system prompt + reviews
// + JSON output fit comfortably. ~10 reviews per call has worked well in
// practice; tune via `inputUsage` / `inputQuota` if needed.
const REVIEWS_PER_BATCH = 10;

const SYSTEM_PROMPT = `You read Airbnb reviews and find concrete concerns a careful traveler would want to know.

For each batch of reviews, output strict JSON:
{
  "flags": [
    {
      "category": "cleanliness" | "safety" | "accuracy" | "host" | "hidden_costs",
      "severity": 1 | 2 | 3,
      "quote": "<verbatim short quote from a review>",
      "reviewId": "<the id from the review header, if available>"
    }
  ]
}

Rules:
- Only flag concrete issues: dirt/bugs/smells (cleanliness), locks/neighborhood/fire (safety), photos-vs-reality or wrong size/location (accuracy), slow or rude host (host), surprise charges or fees (hidden_costs).
- Do NOT flag minor preferences ("bed was firm", "loud street").
- Quote must be a real substring from one of the reviews.
- severity 1 = mild, 2 = notable, 3 = serious (bedbugs, dangerous, scam).
- If no concerns: return {"flags": []}.
- Output JSON only. No prose.`;

const FLAGS_SCHEMA = {
  type: "object",
  required: ["flags"],
  additionalProperties: false,
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        required: ["category", "severity", "quote"],
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["cleanliness", "safety", "accuracy", "host", "hidden_costs"],
          },
          severity: { type: "integer", enum: [1, 2, 3] },
          quote: { type: "string" },
          reviewId: { type: "string" },
        },
      },
    },
  },
} as const;

export type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export async function checkAvailability(): Promise<Availability> {
  if (typeof LanguageModel === "undefined") return "unavailable";
  try {
    return await LanguageModel.availability();
  } catch {
    return "unavailable";
  }
}

export type ProgressCallback = (done: number, total: number) => void;

export async function analyzeReviews(
  reviews: Review[],
  onProgress?: ProgressCallback,
): Promise<AnalyzeResult> {
  if (typeof LanguageModel === "undefined") {
    throw new Error("On-device LanguageModel API is not available.");
  }

  const batches = chunk(reviews, REVIEWS_PER_BATCH);
  const allFlags: Flag[] = [];

  // One session reused across batches keeps the system prompt cached.
  const session = await LanguageModel.create({
    initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
    temperature: 0.2,
    topK: 3,
  });

  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const userMsg = formatBatch(batch);
      let raw: string;
      try {
        raw = await session.prompt(userMsg, {
          responseConstraint: FLAGS_SCHEMA,
        });
      } catch {
        // Some Nano builds don't yet support responseConstraint. Fall back to
        // unconstrained generation and parse defensively.
        raw = await session.prompt(userMsg);
      }
      const parsed = parseBatchOutput(raw, batch);
      allFlags.push(...parsed);
      onProgress?.(i + 1, batches.length);
    }
  } finally {
    session.destroy();
  }

  const categories = computeCategoryScores(allFlags);
  const patternWarnings = detectPatternWarnings(reviews);
  const trustScore = computeTrustScore(categories, allFlags);

  return {
    trustScore,
    reviewCount: reviews.length,
    categories,
    flags: dedupeFlags(allFlags),
    patternWarnings,
    generatedAt: new Date().toISOString(),
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function formatBatch(reviews: Review[]): string {
  const block = reviews
    .map(
      (r) =>
        `[id=${r.id} date=${r.date}${
          r.rating ? ` rating=${r.rating}` : ""
        }]\n${r.text}`,
    )
    .join("\n\n---\n\n");
  return `Reviews:\n\n${block}\n\nReturn JSON now.`;
}

// Normalize text for hallucination check: lowercase, collapse whitespace,
// strip punctuation. Nano sometimes paraphrases or changes capitalization,
// so we don't require an exact substring match.
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true if at least a meaningful chunk of `quote` appears in any of
// the source reviews. We accept either:
//   1. The full normalized quote as a substring of the corpus, OR
//   2. Any contiguous 6-word window from the quote appearing in the corpus.
// (1) catches verbatim quotes; (2) catches quotes Nano slightly trimmed.
function quoteAppearsInCorpus(quote: string, corpus: string): boolean {
  const nq = normalizeForMatch(quote);
  if (nq.length < 12) return false;
  if (corpus.includes(nq)) return true;
  const words = nq.split(" ");
  if (words.length < 6) return false;
  for (let i = 0; i + 6 <= words.length; i++) {
    const window = words.slice(i, i + 6).join(" ");
    if (corpus.includes(window)) return true;
  }
  return false;
}

function parseBatchOutput(raw: string, batch: Review[]): Flag[] {
  const json = extractJson(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  const flagsIn = (obj as { flags?: unknown })?.flags;
  if (!Array.isArray(flagsIn)) return [];

  const idsInBatch = new Set(batch.map((r) => r.id));
  const dateById = new Map(batch.map((r) => [r.id, r.date]));
  const corpus = normalizeForMatch(batch.map((r) => r.text).join(" \n "));

  const out: Flag[] = [];
  for (const f of flagsIn) {
    if (!f || typeof f !== "object") continue;
    const flag = f as Record<string, unknown>;
    const category = flag.category;
    const severity = flag.severity;
    const quote = flag.quote;
    if (
      typeof category !== "string" ||
      !ALL_CATEGORIES.includes(category as FlagCategoryT) ||
      typeof severity !== "number" ||
      severity < 1 ||
      severity > 3 ||
      typeof quote !== "string" ||
      quote.length < 4
    ) {
      continue;
    }
    // Drop hallucinated quotes: Nano sometimes paraphrases or invents quotes.
    if (!quoteAppearsInCorpus(quote, corpus)) continue;
    const reviewId =
      typeof flag.reviewId === "string" && idsInBatch.has(flag.reviewId)
        ? flag.reviewId
        : undefined;
    out.push({
      category: category as FlagCategoryT,
      severity: Math.round(severity) as 1 | 2 | 3,
      quote: quote.slice(0, 240),
      reviewId,
      reviewDate: reviewId ? dateById.get(reviewId) : undefined,
    });
  }
  return out;
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start, end + 1);
  }
  return raw.trim();
}

function dedupeFlags(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  const out: Flag[] = [];
  for (const f of flags) {
    const key = `${f.category}|${f.quote.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// Per-category score: start at 10, subtract for flags weighted by severity,
// capped at 0. Empty category = perfect.
function computeCategoryScores(flags: Flag[]): CategoryScore[] {
  return ALL_CATEGORIES.map((cat) => {
    const inCat = flags.filter((f) => f.category === cat);
    const penalty = inCat.reduce((s, f) => {
      if (f.severity === 3) return s + 4;
      if (f.severity === 2) return s + 2;
      return s + 1;
    }, 0);
    const score = Math.max(0, Math.min(10, 10 - penalty));
    const summary =
      inCat.length === 0
        ? "No notable mentions."
        : `${inCat.length} flag${inCat.length === 1 ? "" : "s"} (max severity ${Math.max(...inCat.map((f) => f.severity))}).`;
    return { category: cat, score, summary };
  });
}

function computeTrustScore(categories: CategoryScore[], flags: Flag[]): number {
  const avg =
    categories.reduce((s, c) => s + c.score, 0) / categories.length;
  const base = avg * 10;
  const penalty = flags.reduce((s, f) => {
    if (f.severity === 3) return s + 8;
    if (f.severity === 2) return s + 3;
    return s + 1;
  }, 0);
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

// Pattern detection runs locally in JS over review metadata, not the LLM.
// LLMs are expensive for this; pattern stats are cheap and deterministic.
function detectPatternWarnings(reviews: Review[]): string[] {
  const warnings: string[] = [];
  if (reviews.length < 5) return warnings;

  const shortCount = reviews.filter((r) => r.text.length < 80).length;
  const shortRatio = shortCount / reviews.length;
  if (shortRatio >= 0.4) {
    warnings.push(
      `${shortCount} of ${reviews.length} reviews are very short (under 80 chars).`,
    );
  }

  // Repeated phrasing across reviews can indicate templated/manipulated reviews.
  const phraseCounts = new Map<string, number>();
  for (const r of reviews) {
    const sentences = r.text
      .split(/[.!?]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 25 && s.length <= 120);
    for (const s of sentences) {
      phraseCounts.set(s, (phraseCounts.get(s) ?? 0) + 1);
    }
  }
  const repeated = [...phraseCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])[0];
  if (repeated) {
    warnings.push(
      `Identical phrase appears in ${repeated[1]} reviews: "${repeated[0].slice(0, 60)}…"`,
    );
  }

  return warnings;
}
