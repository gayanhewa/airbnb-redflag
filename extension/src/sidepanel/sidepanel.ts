// Side panel reads cached results that the content/offscreen pipeline
// produced. It does NOT run analysis itself anymore — that's the offscreen
// document's job. Auto-refreshes when the active tab changes.

import { getCached } from "../cache.js";
import type {
  AnalyzeResult,
  CategoryScore,
  Flag,
  SidePanelState,
} from "../types.js";

const root = document.getElementById("root") as HTMLElement;

let currentState: SidePanelState = { phase: "idle" };
let currentListingId: string | null = null;

(async () => {
  await refresh();
})();

// React to listing-result writes (offscreen finishes → cache updated).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!currentListingId) return;
  if (changes[`cache:${currentListingId}`]) {
    refresh();
  }
});

// React to tab-switch / URL change.
chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((_, info) => {
  if (info.url || info.status === "complete") refresh();
});

async function refresh() {
  const listingId = await getActiveListingId();
  currentListingId = listingId;
  if (!listingId) {
    setState({ phase: "idle" });
    return;
  }
  const result = await getCached(listingId);
  if (result) {
    setState({ phase: "ready", result, cached: true });
    return;
  }
  setState({ phase: "analyzing", done: 0, total: 1 });
  // We rely on the storage-change listener above to re-render once analysis
  // completes and the cache entry is written.
}

async function getActiveListingId(): Promise<string | null> {
  // Ask the background which listing the active tab is currently on.
  const res = (await chrome.runtime.sendMessage({
    type: "GET_ACTIVE_LISTING_ID",
  })) as { listingId: string | null };
  return res?.listingId ?? null;
}

function setState(s: SidePanelState) {
  currentState = s;
  render();
}

function render() {
  const s = currentState;

  switch (s.phase) {
    case "idle":
      root.innerHTML = `<p class="muted">Open an Airbnb listing — the analysis runs automatically.</p>`;
      return;
    case "unsupported":
      root.innerHTML = `<div class="error">${escapeHtml(s.reason)}</div>`;
      return;
    case "scraping":
    case "analyzing":
      root.innerHTML = `<p><span class="spinner"></span>Analysis running on the page. The score will appear here when ready.</p>`;
      return;
    case "error":
      root.innerHTML = `<div class="error">${escapeHtml(s.error)}</div>`;
      return;
    case "ready":
      root.innerHTML = renderResult(s.result);
      return;
  }
}

function renderResult(r: AnalyzeResult): string {
  const b =
    r.trustScore >= 75
      ? "good"
      : r.trustScore >= 55
        ? "mixed"
        : "bad";
  const emoji = r.trustScore >= 75 ? "🟢" : r.trustScore >= 55 ? "🟡" : "🔴";

  return `
    <section class="score-card">
      <div class="score-number score-band-${b}">${emoji} ${r.trustScore}</div>
      <div>
        <div><strong>Trust score</strong> (${r.flags.length} flag${r.flags.length === 1 ? "" : "s"})</div>
        <div class="score-meta">${r.reviewCount} reviews · on-device</div>
      </div>
    </section>

    ${
      r.patternWarnings.length > 0
        ? `<section class="section">
            <h2>Pattern warnings</h2>
            ${r.patternWarnings.map((w) => `<div class="warning">${escapeHtml(w)}</div>`).join("")}
          </section>`
        : ""
    }

    <section class="section">
      <h2>Categories</h2>
      ${r.categories.map(renderCategory).join("")}
    </section>

    ${
      r.flags.length > 0
        ? `<section class="section">
            <h2>Flags</h2>
            ${r.flags.map(renderFlag).join("")}
          </section>`
        : `<section class="section"><h2>Flags</h2><p class="muted">No specific flags found.</p></section>`
    }
  `;
}

function renderCategory(c: CategoryScore): string {
  const pct = Math.round((c.score / 10) * 100);
  const cls = c.score >= 7.5 ? "" : c.score >= 5 ? "mixed" : "bad";
  return `
    <div class="cat-row">
      <span class="cat-name">${labelFor(c.category)}</span>
      <span class="cat-bar ${cls}"><span style="width:${pct}%"></span></span>
      <span class="cat-score">${c.score.toFixed(1)}</span>
    </div>
    <div class="cat-summary">${escapeHtml(c.summary)}</div>
  `;
}

function renderFlag(f: Flag): string {
  return `
    <div class="flag sev-${f.severity}">
      <div class="flag-meta">${labelFor(f.category)} · severity ${f.severity}${f.reviewDate ? ` · ${escapeHtml(f.reviewDate)}` : ""}</div>
      <div class="flag-quote">"${escapeHtml(f.quote)}"</div>
    </div>
  `;
}

function labelFor(cat: string): string {
  switch (cat) {
    case "cleanliness":
      return "🧹 Cleanliness";
    case "safety":
      return "🛡️ Safety";
    case "accuracy":
      return "📷 Accuracy";
    case "host":
      return "👤 Host";
    case "hidden_costs":
      return "💰 Hidden costs";
    default:
      return cat.charAt(0).toUpperCase() + cat.slice(1);
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
