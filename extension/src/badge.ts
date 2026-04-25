// Floating trust-score badge injected into the Airbnb listing page.
// Stays out of the way until analysis is complete; click opens the side panel.

import type { AnalyzeResult } from "./types.js";

const HOST_ID = "airbnb-redflag-badge-host";

type BadgeState =
  | { phase: "loading"; label: string }
  | { phase: "ready"; result: AnalyzeResult }
  | { phase: "error"; message: string };

let currentListingId: string | null = null;

function ensureHost(): ShadowRoot {
  let host = document.getElementById(HOST_ID) as HTMLElement | null;
  if (host && host.shadowRoot) return host.shadowRoot;
  host = document.createElement("div");
  host.id = HOST_ID;
  // Top-right, below Airbnb's sticky header (~80px tall). Fixed so it stays
  // visible while scrolling. z-index sits below Airbnb's modal layer (10000+)
  // but above all page content.
  // NOTE: do NOT set `all: initial` on the host — that wipes position/z-index.
  // Shadow DOM already isolates the inner styles from the page.
  host.style.position = "fixed";
  host.style.top = "88px";
  host.style.right = "16px";
  host.style.zIndex = "9500";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${STYLES}</style><div id="root"></div>`;
  return shadow;
}

const STYLES = `
  :host, * { box-sizing: border-box; }
  #root {
    font: 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 8px;
    background: #fff;
    color: #222;
    border: 1px solid #d8d8d8;
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.10);
    cursor: pointer;
    user-select: none;
    transition: transform 80ms ease, box-shadow 80ms ease;
    line-height: 1;
  }
  .badge:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.14); }
  .emoji { font-size: 14px; line-height: 1; }
  .score { font-weight: 600; font-size: 11px; }
  .sub { color: #666; font-size: 10px; }
  .spinner {
    width: 11px; height: 11px;
    border: 2px solid #ccc; border-top-color: #444;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error {
    padding: 6px 10px;
    background: #fff5f5; color: #8a1f1f;
    border: 1px solid #f5c2c2; border-radius: 8px;
    font-size: 11px;
    max-width: 220px;
  }
`;

function bandEmoji(score: number): string {
  if (score >= 75) return "🟢";
  if (score >= 55) return "🟡";
  return "🔴";
}

export function setBadgeState(
  listingId: string,
  state: BadgeState,
) {
  currentListingId = listingId;
  const shadow = ensureHost();
  const root = shadow.getElementById("root");
  if (!root) return;

  if (state.phase === "loading") {
    root.innerHTML = `
      <div class="badge" data-action="open">
        <span class="spinner"></span>
        <span class="sub">${escapeHtml(state.label)}</span>
      </div>`;
  } else if (state.phase === "error") {
    root.innerHTML = `<div class="error">${escapeHtml(state.message)}</div>`;
  } else {
    const r = state.result;
    const flagsLabel =
      r.flags.length === 0
        ? "no flags"
        : `${r.flags.length} flag${r.flags.length === 1 ? "" : "s"}`;
    root.innerHTML = `
      <div class="badge" data-action="open" title="Click for details">
        <span class="emoji">${bandEmoji(r.trustScore)}</span>
        <span class="score">${r.trustScore}</span>
        <span class="sub">· ${escapeHtml(flagsLabel)}</span>
      </div>`;
  }

  const badgeEl = root.querySelector<HTMLElement>('[data-action="open"]');
  badgeEl?.addEventListener("click", () => {
    if (!currentListingId) return;
    chrome.runtime.sendMessage({
      type: "OPEN_SIDE_PANEL_FOR_LISTING",
      listingId: currentListingId,
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
