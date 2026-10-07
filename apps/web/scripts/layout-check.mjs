#!/usr/bin/env node
// Measures a REAL computed layout property of the built app in a REAL
// headless browser, and fails if it's wrong. See apps/web/HEADLESS-BROWSER.md
// (ticket 9c78da1, dated 2026-10-07) for the full investigation this came
// out of -- in short: this container's `dev` user has no working headless
// browser out of the box (apt-get refuses, not root), so nobody running
// inside it could previously check any layout claim; this script, plus the
// sysroot fetched by fetch-chromium-sysroot.sh, is the fix.
//
// ONE DOCUMENTED COMMAND, from the repo root (apps/web/HEADLESS-BROWSER.md
// repeats this):
//
//   pnpm build && node apps/web/scripts/layout-check.mjs
//
// `pnpm build` is a separate, explicit step rather than something this
// script shells out to itself: a workspace build needs topological order
// (packages/shared before apps/web -- see root CLAUDE.md), which only the
// root-level `pnpm -r run build` knows how to do; re-deriving that here
// would just be a second, easier-to-drift copy of the same ordering logic.
//
// What this demonstrates: ticket 931df8a's review fix for the magic-link
// prompt's spacing inside the results list (apps/web/src/index.css, the
// `.magic-link-prompt-anchor .magic-link-prompt { margin-top: 0; }` rule
// and the long comment above it) was "caught by inspection, not a
// screenshot -- there is no working headless browser in this container."
// This script is that screenshot, in numbers: it builds the exact DOM
// shape ResultsList.tsx/App.tsx produce around the anchor `<li>`, loads
// the app's OWN BUILT CSS (apps/web/dist/assets/*.css -- not a hand-copied
// excerpt), and asserts the real gap is 1rem (16px at the default root
// font-size), not the pre-fix 2.5rem (40px).
//
// Deliberately a standalone script, not a vitest suite member (see
// HEADLESS-BROWSER.md's "Does this belong in `pnpm test`?" section for the
// reasoning) -- run it on demand when a layout claim needs checking, not on
// every `vitest` invocation.
import { chromium } from "playwright-core";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const distAssets = join(webRoot, "dist", "assets");

function findBuiltCss() {
  if (!existsSync(distAssets)) {
    console.error(
      `No build output at ${distAssets}.\n` +
        `Run this from the repo root first: pnpm build\n` +
        `(apps/web alone can't build -- @app/shared must build first; ` +
        `pnpm -r run build at the root handles that ordering.)`,
    );
    process.exit(1);
  }
  const cssFile = readdirSync(distAssets).find((f) => f.endsWith(".css"));
  if (!cssFile) {
    console.error(`${distAssets} has no .css file -- did the build actually run vite build?`);
    process.exit(1);
  }
  return readFileSync(join(distAssets, cssFile), "utf8");
}

// Finds Playwright's cached Chromium build ourselves rather than asking
// playwright-core to (`chromium.executablePath()` only returns a path for
// the EXACT browser revision this installed playwright-core version
// expects, and the browser already cached in this container -- downloaded
// by an earlier, differently-versioned session -- doesn't have to match).
// Passing `executablePath` explicitly to `launch()` skips that revision
// check entirely; CDP is stable enough across adjacent versions for this
// script's needs (navigate, read computed layout).
function findCachedChromium() {
  const cacheDir = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cacheDir)) return null;
  const candidates = readdirSync(cacheDir).filter(
    (d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"),
  );
  // Prefer the headless-shell build: smaller, and all this script needs is
  // computed layout/style, not screenshots or a visible head.
  candidates.sort(
    (a, b) =>
      Number(b.startsWith("chromium_headless_shell")) -
      Number(a.startsWith("chromium_headless_shell")),
  );
  for (const dir of candidates) {
    const binName = dir.startsWith("chromium_headless_shell") ? "headless_shell" : "chrome";
    const exe = join(cacheDir, dir, "chrome-linux", binName);
    if (existsSync(exe)) return exe;
  }
  return null;
}

function sysrootLibDir() {
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const root =
    process.env.CHROMIUM_SYSROOT_CACHE || join(homedir(), ".cache", `chromium-sysroot-${arch}`);
  const marker = join(root, ".complete");
  if (!existsSync(marker)) {
    console.log(`Chromium sysroot not found at ${root} -- fetching (one-time, ~60MB)...`);
    execFileSync("bash", [join(__dirname, "fetch-chromium-sysroot.sh")], { stdio: "inherit" });
  }
  // Debian/Ubuntu multiarch lib path -- matches `dpkg --print-architecture`-
  // style triplets (aarch64 -> arm64 isn't quite the dpkg name, but the
  // actual extracted path uses the GNU triplet, not the uname one).
  const triplet = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  return join(root, "usr", "lib", triplet);
}

async function main() {
  const css = findBuiltCss();
  const chromiumPath = findCachedChromium();
  if (!chromiumPath) {
    console.error(
      "No cached Chromium found under ~/.cache/ms-playwright. Run:\n" +
        "  npx playwright install chromium-headless-shell\n" +
        "first (needs network access to Playwright's CDN, not apt).",
    );
    process.exit(1);
  }
  const libDir = sysrootLibDir();

  // The exact DOM shape ResultsList.tsx (and GroupedResultsList.tsx)
  // render around the magic-link portal anchor -- verified against the
  // actual component source on 2026-10-07, not reconstructed from memory:
  //   <ul class="result-cards">
  //     <li class="result-card">...</li>                              (ResultCard.tsx line 114)
  //     <li class="magic-link-prompt-anchor" role="presentation">     (ResultsList.tsx, only after the FIRST result)
  //       <div class="magic-link-prompt-host">                       (App.tsx's portal root div)
  //         <section class="magic-link-prompt">...</section>          (MagicLinkPrompt.tsx line 108)
  //       </div>
  //     </li>
  //     <li class="result-card">...</li>
  //   </ul>
  // No application code is exercised here -- this is a static fixture
  // using the app's real CSS, not App.tsx itself (OUT of scope per the
  // ticket: no hooks added to make the real component tree testable).
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
<div class="app">
<ul class="result-cards">
  <li class="result-card" id="first-card" style="height:40px;background:#eee">first result (stand-in)</li>
  <li class="magic-link-prompt-anchor" role="presentation">
    <div class="magic-link-prompt-host">
      <section class="magic-link-prompt" id="prompt">
        <h3>Want to find this again?</h3>
        <p>Stand-in prompt body.</p>
      </section>
    </div>
  </li>
  <li class="result-card" style="height:40px;background:#ddd">second result (stand-in)</li>
</ul>
</div>
</body></html>`;

  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const rootFontSizePx = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const gapPx = await page.evaluate(() => {
      const first = document.getElementById("first-card").getBoundingClientRect();
      const prompt = document.getElementById("prompt").getBoundingClientRect();
      return prompt.top - first.bottom;
    });
    const gapRem = gapPx / rootFontSizePx;

    console.log(`root font-size: ${rootFontSizePx}px`);
    console.log(
      `measured gap, first result card -> magic-link-prompt: ${gapPx}px (${gapRem.toFixed(3)}rem)`,
    );

    // The claim being checked: 1rem, matching `.result-cards`' own
    // `gap: 1rem` -- not 2.5rem (the pre-fix bug: a flex item's margin
    // doesn't collapse with the container's gap, so the old
    // `margin-top: 1.5rem` on `.magic-link-prompt` added ON TOP of the
    // 1rem gap instead of competing with it). Tolerance of 0.5px for
    // sub-pixel layout rounding, same order of magnitude as the
    // 16.1px-vs-16px slack already called out for the OTHER measured
    // claim in index.css (the h1/tab-nav one).
    const expectedPx = rootFontSizePx * 1;
    const tolerancePx = 0.5;
    const ok = Math.abs(gapPx - expectedPx) <= tolerancePx;

    if (!ok) {
      console.error(
        `FAIL: expected ${expectedPx}px (1rem), got ${gapPx}px (${gapRem.toFixed(3)}rem) -- ` +
          `off by ${(gapPx - expectedPx).toFixed(2)}px. ` +
          `If this is exactly 1.5rem (24px) MORE than expected, the margin/gap-collapse bug is back.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`PASS: gap matches .result-cards' own gap: 1rem, within ${tolerancePx}px.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
