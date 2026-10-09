#!/usr/bin/env node
// Measures REAL computed layout of the built app in a REAL headless
// browser: ticket 042db32 ("Float the magic-link prompt beside the
// results, never above them"). See apps/web/HEADLESS-BROWSER.md (ticket
// 9c78da1) for how the headless-browser setup this reuses works and why it
// exists, and apps/web/scripts/layout-check.mjs /
// resume-list-fold-check.mjs for the two earlier worked examples of this
// same technique this script is a third of.
//
// Why a third file instead of extending one of the other two: same
// reasoning resume-list-fold-check.mjs already gives for being a second
// file rather than folding into layout-check.mjs -- this is a different
// fixture (the results list + the magic-link anchor floated beside/sticky
// above it, not the saved-resume picker) and a different shape of result
// (a PASS/FAIL gate against the ticket's own acceptance criteria, closer
// to layout-check.mjs's shape than resume-list-fold-check.mjs's
// before/after sweep, but checking several distinct claims at once rather
// than one fixed gap). Each duplicated Chromium-discovery/sysroot helper
// below carries a one-line pointer back to layout-check.mjs's own comment
// for the reasoning, same convention the other two scripts already use.
//
// Run from the repo root:
//
//   pnpm build && node apps/web/scripts/magic-link-float-check.mjs
//
// What this checks, directly against ticket 042db32's acceptance criteria:
//
//   1. At a laptop viewport (1366x768), the prompt floats BESIDE the
//      results (its left edge is to the right of the result cards' own
//      right edge), with its top no higher than the first result card's
//      top.
//   2. It never overlaps a result card, the results-summary paragraph, or
//      the tab nav, at either viewport, for a SHORT (one result) or LONG
//      (many results) list.
//   3. At a phone viewport (390x844), where there is no "side" to float
//      to, the documented fallback (position: sticky, pinned to the
//      results' own slot) does not put the card above the first result
//      either, and -- the one thing a static rect check can still prove
//      about a dynamic sticky rule -- scrolling partway into the list
//      moves the card's top toward the viewport's own top edge rather
//      than leaving it wherever it rendered at scroll position 0, which a
//      plain static (non-sticky) element could never do.
//
// Scope this does NOT cover, stated plainly (same caveat the other two
// scripts give themselves): this is a HAND-BUILT fixture reproducing the
// DOM shape ResultsList.tsx/App.tsx/MagicLinkPrompt.tsx/MagicLinkForm.tsx
// produce (verified against those four files' source on 2026-10-09, not
// reconstructed from memory) -- it does not render those components
// themselves. It would not catch any of them changing which elements
// render, renaming a class, or moving the anchor off the first result; in
// any of those this fixture would simply no longer match what the app
// actually produces. Re-check it by hand against those four files
// whenever they change the markup this script's fixture reproduces.
//
// Deliberately a standalone script, not a vitest suite member -- see
// HEADLESS-BROWSER.md's "Does this belong in `pnpm test`?" section for the
// full reasoning (cold-start cost, environment dependency, this project's
// own "one demonstration, not a CI-wired layout-regression suite" scope).
import { chromium } from "playwright-core";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const distAssets = join(webRoot, "dist", "assets");

// See layout-check.mjs's own `findBuiltCss` comment for why ALL .css files
// are concatenated, not just the first.
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
  const cssFiles = readdirSync(distAssets).filter((f) => f.endsWith(".css"));
  if (cssFiles.length === 0) {
    console.error(`${distAssets} has no .css file -- did the build actually run vite build?`);
    process.exit(1);
  }
  return cssFiles.map((f) => readFileSync(join(distAssets, f), "utf8")).join("\n");
}

// See layout-check.mjs's own `revisionOf`/`findCachedChromium` comments for
// the full reasoning (prefer the headless-shell build, highest revision
// wins, `executablePath` passed explicitly to skip Playwright's own
// revision check).
function revisionOf(dirName) {
  const m = dirName.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : -1;
}

function findCachedChromium() {
  const cacheDir = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cacheDir)) return null;
  const candidates = readdirSync(cacheDir).filter(
    (d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"),
  );
  candidates.sort((a, b) => {
    const aShell = Number(a.startsWith("chromium_headless_shell"));
    const bShell = Number(b.startsWith("chromium_headless_shell"));
    if (aShell !== bShell) return bShell - aShell;
    return revisionOf(b) - revisionOf(a);
  });
  for (const dir of candidates) {
    const binName = dir.startsWith("chromium_headless_shell") ? "headless_shell" : "chrome";
    const exe = join(cacheDir, dir, "chrome-linux", binName);
    if (existsSync(exe)) return exe;
  }
  return null;
}

// See layout-check.mjs's own `sysrootLibDir` comment for the full
// reasoning (this container has no root/apt; the sysroot is fetched via
// `dpkg-deb -x`, never `dpkg --install`).
function sysrootLibDir() {
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const root =
    process.env.CHROMIUM_SYSROOT_CACHE || join(homedir(), ".cache", `chromium-sysroot-${arch}`);
  const marker = join(root, ".complete");
  if (!existsSync(marker)) {
    console.log(`Chromium sysroot not found at ${root} -- fetching (one-time, ~60MB)...`);
    execFileSync("bash", [join(webRoot, "scripts", "fetch-chromium-sysroot.sh")], {
      stdio: "inherit",
    });
  }
  const triplet = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  return join(root, "usr", "lib", triplet);
}

// The real MagicLinkPrompt/MagicLinkForm idle-state markup (verified
// against those two files' source on 2026-10-09): `<section
// class="magic-link-prompt">` wrapping MagicLinkForm's own `<div
// aria-live="polite">`, the pitch (`<h3>`+`<p>`), the form
// (`class="magic-link-form"`: label, email input, submit button), and the
// "Not now" secondary button `MagicLinkPrompt` passes in. Copy text is
// cosmetic for this script's purposes (only the real CSS classes and tag
// nesting matter for layout) but kept verbatim anyway so a reader
// comparing this file to the two components side by side doesn't have to
// wonder whether a difference is meaningful.
function magicLinkPromptHtml() {
  return `<div class="magic-link-prompt-host">
    <section class="magic-link-prompt" id="prompt">
      <div aria-live="polite">
        <h3>Want to find these results again later?</h3>
        <p>Add your email and we'll send you a link that ties these results to your email so that you can get them back anytime.</p>
        <form class="magic-link-form">
          <label for="ml-email">Email address</label>
          <input id="ml-email" type="email" autocomplete="email" placeholder="you@example.com" />
          <button type="submit">Email me a link</button>
          <button type="button" class="magic-link-secondary">Not now</button>
        </form>
      </div>
    </section>
  </div>`;
}

// The real ResultCard.tsx collapsed-state markup (verified against that
// file's source on 2026-10-09): header (score/title/meta/searched-with),
// the "Why this match?" toggle, and the action row. Real text/markup, not
// a height-stand-in div -- the whole point of this script is to measure
// whether a REAL card's real height leaves room for the floated prompt
// beside/after it, which a `style="height:40px"` placeholder (the
// technique layout-check.mjs's simpler fixture uses, where only the GAP
// between two cards mattered, not either card's actual height) would beg
// the question of.
function resultCardHtml(n) {
  return `<li class="result-card">
    <div class="result-card-header">
      <span class="result-score" aria-label="Match score">${70 + (n % 25)}%</span>
      <div class="result-title-block">
        <h3 class="result-title">Senior Backend Engineer ${n}</h3>
        <p class="result-meta">Company: Acme Corp ${n} &middot; Data source: greenhouse &middot; Location: Remote</p>
        <p class="result-searched-with">Searched with: <button type="button" class="result-resume-link">Resume 1</button></p>
      </div>
    </div>
    <button type="button" class="link-button">Why this match?</button>
    <div class="result-actions">
      <a href="https://example.com/job" target="_blank" rel="noreferrer">Open Job Page</a>
      <button type="button" class="result-action">Save</button>
      <button type="button" class="result-action">Apply</button>
      <button type="button" class="result-action">Dismiss</button>
    </div>
  </li>`;
}

// The real App.tsx/ResultsList.tsx shape around the search tab's results
// section (verified against both files' source on 2026-10-09): `.app` ->
// header -> `.tab-nav` -> `.results-section` -> `.results-list` ->
// `.results-summary` + the three hide-toggles -> `.result-cards`, with the
// magic-link anchor placed right after the FIRST `<li class="result-card">`
// -- exactly where `ResultsList.tsx`'s own `index === 0` check puts it.
function buildFixtureHtml(css, resultCount) {
  const cards = Array.from({ length: resultCount }, (_, i) => resultCardHtml(i + 1));
  const [firstCard, ...restCards] = cards;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
<div class="app">
  <div class="app-header"><h1>FitScore</h1></div>
  <p class="app-welcome">Welcome to FitScore! Find jobs that fit your experience.</p>
  <nav class="tab-nav" aria-label="Sections" id="tab-nav">
    <button type="button" class="tab-button" aria-pressed="true">New Job Search</button>
    <button type="button" class="tab-button">Already Scored Jobs</button>
    <button type="button" class="tab-button">My Resumes</button>
  </nav>
  <div>
    <section class="results-section">
      <h2>Results from this search</h2>
      <div class="score-floor-control">
        <label for="floor">Minimum match score</label>
        <input id="floor" type="range" min="0" max="90" step="5" value="55" />
        <span class="score-floor-value">55%</span>
      </div>
      <div class="results-list" id="results-list">
        <p class="results-summary" id="results-summary">Showing ${resultCount} of ${resultCount} scored jobs from the sources you've selected.</p>
        <label class="hide-overqualified-toggle"><input type="checkbox" />Hide roles I'm overqualified for (0)</label>
        <label class="hide-underqualified-toggle"><input type="checkbox" />Hide roles I'm underqualified for (0)</label>
        <label class="hide-contract-toggle"><input type="checkbox" />Hide contract/temp roles (0)</label>
        <ul class="result-cards" id="result-cards">
          ${firstCard}
          <li class="magic-link-prompt-anchor" role="presentation" id="anchor">
            ${magicLinkPromptHtml()}
          </li>
          ${restCards.join("\n")}
        </ul>
      </div>
    </section>
  </div>
</div>
</body></html>`;
}

// The real App.tsx/GroupedResultsList.tsx shape for "Already Scored Jobs"
// (verified against both files' source on 2026-10-09): the same
// `.results-section`/`.results-list` wrapper, but `.result-cards` is now
// split into multiple `<section class="results-group">` blocks (one per
// non-empty `ScoredGroupKey`), each a SEPARATE `<ul class="result-cards">`.
// The anchor goes right after the first card of the FIRST non-empty group
// only (`anchorPlaced` in that component) -- so with a SHORT first group
// immediately followed by a second group's own section, this is the one
// fixture shape that can actually test the overlap risk this file's own
// index.css comment flags but the single-list fixture above cannot: a
// `position: absolute` floated card does not grow `.result-cards` to make
// room for itself, so if it is taller than the first group's own card(s),
// it can run down into whatever section the DOM places right after that
// group -- here, the "Applied" group's own heading and cards.
function buildGroupedFixtureHtml(css, firstGroupCount) {
  const firstGroupCards = Array.from({ length: firstGroupCount }, (_, i) => resultCardHtml(i + 1));
  const [firstCard, ...restOfFirstGroup] = firstGroupCards;
  const secondGroupCards = [resultCardHtml(90), resultCardHtml(91)];

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
<div class="app">
  <div class="app-header"><h1>FitScore</h1></div>
  <p class="app-welcome">Welcome to FitScore! Find jobs that fit your experience.</p>
  <nav class="tab-nav" aria-label="Sections" id="tab-nav">
    <button type="button" class="tab-button">New Job Search</button>
    <button type="button" class="tab-button" aria-pressed="true">Already Scored Jobs</button>
    <button type="button" class="tab-button">My Resumes</button>
  </nav>
  <div>
    <section class="results-section">
      <h2>Already Scored Jobs</h2>
      <div class="score-floor-control">
        <label for="floor2">Minimum match score</label>
        <input id="floor2" type="range" min="0" max="90" step="5" value="55" />
        <span class="score-floor-value">55%</span>
      </div>
      <div class="results-list" id="results-list">
        <p class="results-summary" id="results-summary">Showing ${firstGroupCount + 2} of ${firstGroupCount + 2} scored jobs.</p>
        <label class="hide-overqualified-toggle"><input type="checkbox" />Hide roles I'm overqualified for (0)</label>
        <label class="hide-underqualified-toggle"><input type="checkbox" />Hide roles I'm underqualified for (0)</label>
        <label class="hide-contract-toggle"><input type="checkbox" />Hide contract/temp roles (0)</label>
        <nav class="results-group-quicklinks" aria-label="Jump to group">
          <a href="#results-group-saved">Saved (${firstGroupCount})</a>
          <a href="#results-group-applied">Applied (2)</a>
        </nav>
        <section id="results-group-saved" class="results-group">
          <h3>Saved</h3>
          <ul class="result-cards" id="result-cards">
            ${firstCard}
            <li class="magic-link-prompt-anchor" role="presentation" id="anchor">
              ${magicLinkPromptHtml()}
            </li>
            ${restOfFirstGroup.join("\n")}
          </ul>
        </section>
        <section id="results-group-applied" class="results-group">
          <h3 id="next-group-heading">Applied</h3>
          <ul class="result-cards">
            ${secondGroupCards.join("\n")}
          </ul>
        </section>
      </div>
    </section>
  </div>
</div>
</body></html>`;
}

// Two viewports, same pair (and same stated reasoning) layout-check.mjs's
// sibling scripts already use -- see resume-list-fold-check.mjs's own
// comment for why these two specifically (1366x768: the most common
// laptop resolution for most of the last decade per StatCounter; 390x844:
// the iPhone 12/13/14 viewport, the most common modern iPhone form
// factor).
const VIEWPORTS = [
  { name: "laptop (1366x768)", width: 1366, height: 768 },
  { name: "phone (390x844, iPhone 12/13/14)", width: 390, height: 844 },
];

// "Short" = one result (the anchor sits right after the only card, so the
// floated/sticky prompt has the least possible real content beside/after
// it to keep it from overrunning whatever follows -- the exact scenario
// this file's own index.css comment flags as unverified-by-construction
// for the wide-viewport `position: absolute` mechanism). "Long" = enough
// results that the list is visibly taller than one viewport, matching the
// ticket's own instruction to check "a short results list and a long one."
const RESULT_COUNTS = { short: 1, long: 12 };

async function main() {
  const css = findBuiltCss();
  const chromiumPath = findCachedChromium();
  if (!chromiumPath) {
    console.error(
      "No cached Chromium found under ~/.cache/ms-playwright. Run:\n" +
        "  npx playwright-core install chromium-headless-shell\n" +
        "first (needs network access to Playwright's CDN, not apt).",
    );
    process.exit(1);
  }
  const libDir = sysrootLibDir();
  const inheritedLdPath = process.env.LD_LIBRARY_PATH;
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...process.env,
      LD_LIBRARY_PATH: inheritedLdPath ? `${libDir}:${inheritedLdPath}` : libDir,
    },
  });

  let anyFailure = false;

  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n=== ${viewport.name} ===`);
      for (const [label, count] of Object.entries(RESULT_COUNTS)) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.setContent(buildFixtureHtml(css, count), { waitUntil: "load" });

        const metrics = await page.evaluate(() => {
          const rect = (id) => document.getElementById(id)?.getBoundingClientRect() ?? null;
          const firstCard = document.querySelector(".result-card");
          const allCards = Array.from(document.querySelectorAll(".result-card"));
          return {
            tabNav: rect("tab-nav"),
            resultsSummary: rect("results-summary"),
            resultCards: rect("result-cards"),
            firstCard: firstCard ? firstCard.getBoundingClientRect() : null,
            lastCard:
              allCards.length > 0 ? allCards[allCards.length - 1].getBoundingClientRect() : null,
            prompt: rect("prompt"),
            // Confirms the floated card actually lands inside the
            // viewport's own width (the outer-gutter fit this file's
            // index.css comment computes by hand) rather than merely
            // "doesn't overlap the cards" while hanging off the right edge
            // of the screen -- `scrollWidth > clientWidth` on
            // `documentElement` is how a real browser reports "this page
            // is wider than its own viewport," independent of any
            // element-by-element rect math.
            horizontalOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        });

        // Overlap test: two axis-aligned boxes overlap iff they overlap on
        // BOTH axes. Exactly touching edges (e.g. prompt.left ===
        // card.right) does not count as overlap -- `<` not `<=`.
        function overlaps(a, b) {
          if (!a || !b) return false;
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        }

        const promptOverlapsFirstCard = overlaps(metrics.prompt, metrics.firstCard);
        const promptOverlapsSummary = overlaps(metrics.prompt, metrics.resultsSummary);
        const promptOverlapsTabNav = overlaps(metrics.prompt, metrics.tabNav);
        // Every OTHER card too -- not just the first -- since the floated
        // (wide-viewport) card sits in the gutter beside the WHOLE list,
        // not just card 1, and a tall prompt could in principle reach down
        // far enough to overlap card 2 even if it clears card 1. Computed
        // inside a second `page.evaluate()` (rather than reusing
        // `metrics`, which only captured the first/last card) because the
        // check needs EVERY card's rect, not just the two already pulled
        // out above.
        const anyCardOverlap = await page.evaluate(() => {
          const prompt = document.getElementById("prompt");
          if (!prompt) return false;
          const p = prompt.getBoundingClientRect();
          return Array.from(document.querySelectorAll(".result-card")).some((el) => {
            const c = el.getBoundingClientRect();
            return p.left < c.right && p.right > c.left && p.top < c.bottom && p.bottom > c.top;
          });
        });

        const promptTopBelowFirstCardTop =
          metrics.prompt !== null &&
          metrics.firstCard !== null &&
          metrics.prompt.top >= metrics.firstCard.top - 0.5; // 0.5px rounding tolerance

        const isWide = viewport.width >= 1366;
        const floatsBeside =
          isWide &&
          metrics.prompt !== null &&
          metrics.resultCards !== null &&
          metrics.prompt.left >= metrics.resultCards.right - 0.5;

        const ok =
          promptTopBelowFirstCardTop &&
          !promptOverlapsFirstCard &&
          !anyCardOverlap &&
          !promptOverlapsSummary &&
          !promptOverlapsTabNav &&
          !metrics.horizontalOverflow &&
          (!isWide || floatsBeside);

        if (!ok) anyFailure = true;

        console.log(
          `${label.padEnd(5)} (N=${String(count).padStart(2)}): ` +
            `firstCard.top=${metrics.firstCard?.top.toFixed(1)}  ` +
            `prompt.top=${metrics.prompt?.top.toFixed(1)}  ` +
            `prompt.left=${metrics.prompt?.left.toFixed(1)}  ` +
            `prompt.bottom=${metrics.prompt?.bottom.toFixed(1)}  ` +
            `resultCards.right=${metrics.resultCards?.right.toFixed(1)}  ` +
            `lastCard.bottom=${metrics.lastCard?.bottom.toFixed(1)}  ` +
            `top<=firstCardTop:${promptTopBelowFirstCardTop ? "PASS" : "FAIL"}  ` +
            `overlapsAnyCard:${anyCardOverlap ? "FAIL" : "PASS"}  ` +
            `overlapsSummary:${promptOverlapsSummary ? "FAIL" : "PASS"}  ` +
            `overlapsTabNav:${promptOverlapsTabNav ? "FAIL" : "PASS"}  ` +
            `horizontalOverflow:${metrics.horizontalOverflow ? "FAIL" : "PASS"}  ` +
            (isWide ? `floatsBeside:${floatsBeside ? "PASS" : "FAIL"}  ` : "") +
            `=> ${ok ? "PASS" : "FAIL"}`,
        );

        await page.close();
      }
    }

    // Scrolling check, narrow viewport only (390x844): the ONE piece of
    // "is this actually `position: sticky`, not a plain static element
    // that merely happens to render in the same place at scroll 0" a
    // static getBoundingClientRect() snapshot can't tell apart on its
    // own. Scrolls the page partway into a LONG list and re-measures: a
    // sticky element pins toward the viewport's top edge; a static one
    // would keep scrolling up and off-screen with the rest of the list.
    console.log(`\n=== phone (390x844) -- scroll check (sticky vs. static) ===`);
    {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setContent(buildFixtureHtml(css, RESULT_COUNTS.long), { waitUntil: "load" });
      const before = await page.evaluate(
        () => document.getElementById("prompt").getBoundingClientRect().top,
      );
      await page.evaluate(() => window.scrollBy(0, 500));
      const after = await page.evaluate(
        () => document.getElementById("prompt").getBoundingClientRect().top,
      );
      // After scrolling 500px, a STATIC element's viewport-relative top
      // would drop by ~500px (it scrolls with the page); a STUCK sticky
      // element's viewport-relative top stays pinned near 0 instead. This
      // asserts the sticky behavior is real, not merely that the two
      // numbers differ by exactly 500 (which would indicate the opposite
      // -- the "sticky" rule silently not applying).
      const stuck = after < before - 100; // moved toward (or to) the top, not with the scroll
      if (!stuck) anyFailure = true;
      console.log(
        `prompt.top before scroll=${before.toFixed(1)}  after scrollBy(0,500)=${after.toFixed(1)}  ` +
          `=> ${stuck ? "PASS (stuck near top, confirming position: sticky is live)" : "FAIL (moved with the page -- sticky rule is not applying)"}`,
      );
      await page.close();
    }

    // The grouped-list ("Already Scored Jobs") short-first-group check:
    // the one scenario the plain `.result-cards` fixture above cannot
    // exercise, because it has only ONE `<ul>` and nothing follows it in
    // the DOM. Here a second group's `<section>` -- with its own heading
    // and cards -- sits immediately after the first group's `</ul>`, so a
    // floated (wide-viewport) prompt taller than the first group's own
    // card(s) has something real to overlap if it runs past them.
    console.log(`\n=== laptop (1366x768) -- grouped list, short first group ===`);
    {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.setContent(buildGroupedFixtureHtml(css, 1), { waitUntil: "load" });
      const metrics = await page.evaluate(() => {
        const rect = (id) => document.getElementById(id)?.getBoundingClientRect() ?? null;
        return {
          prompt: rect("prompt"),
          nextGroupSection: rect("results-group-applied"),
          nextGroupHeading: rect("next-group-heading"),
        };
      });
      const overlapsNextGroup = (() => {
        const p = metrics.prompt;
        const g = metrics.nextGroupSection;
        if (!p || !g) return false;
        return p.left < g.right && p.right > g.left && p.top < g.bottom && p.bottom > g.top;
      })();
      if (overlapsNextGroup) anyFailure = true;
      console.log(
        `prompt.bottom=${metrics.prompt?.bottom.toFixed(1)}  ` +
          `nextGroup("Applied").top=${metrics.nextGroupSection?.top.toFixed(1)}  ` +
          `nextGroupHeading.top=${metrics.nextGroupHeading?.top.toFixed(1)}  ` +
          `=> ${overlapsNextGroup ? "FAIL (floated prompt overlaps the NEXT group's section)" : "PASS (no overlap with the next group)"}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }

  if (anyFailure) {
    console.error("\nFAIL: at least one check above did not pass.");
    process.exitCode = 1;
  } else {
    console.log("\nPASS: every check above passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
