// Build script for the Chrome extension.
// Bundles each entry point with `bun build` and copies static assets to dist/.
// Pass --watch to rebuild on file changes.

import { rm, mkdir, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");

const ENTRY_POINTS: Record<string, string> = {
  "background.js": join(SRC, "background.ts"),
  "content.js": join(SRC, "content.ts"),
  "sidepanel.js": join(SRC, "sidepanel/sidepanel.ts"),
  "offscreen.js": join(SRC, "offscreen/offscreen.ts"),
};

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Bundle each entry point.
  for (const [outName, entry] of Object.entries(ENTRY_POINTS)) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      minify: false,
    });
    if (!result.success) {
      console.error("Build failed for", entry);
      for (const log of result.logs) console.error(log);
      process.exit(1);
    }
    const output = result.outputs[0];
    const text = await output.text();
    await Bun.write(join(DIST, outName), text);
  }

  // Static files.
  await copyFile(join(ROOT, "manifest.json"), join(DIST, "manifest.json"));
  await copyFile(
    join(SRC, "sidepanel/index.html"),
    join(DIST, "sidepanel.html"),
  );
  await copyFile(
    join(SRC, "sidepanel/sidepanel.css"),
    join(DIST, "sidepanel.css"),
  );
  await copyFile(
    join(SRC, "offscreen/index.html"),
    join(DIST, "offscreen.html"),
  );

  // Copy any icons.
  if (existsSync(PUBLIC)) {
    const files = await readdir(PUBLIC);
    for (const f of files) {
      await copyFile(join(PUBLIC, f), join(DIST, f));
    }
  }

  // The sidepanel HTML references "sidepanel.js" at the root of dist/, which
  // is what the bundler emits. No path rewrite needed.
  console.log("[build] dist/ updated");
}

const watch = process.argv.includes("--watch");

await build();

if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  let timer: Timer | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      build().catch((e) => console.error(e));
    }, 150);
  };
  fsWatch(SRC, { recursive: true }, trigger);
  fsWatch(join(ROOT, "manifest.json"), trigger);
  console.log("[build] watching for changes…");
}
