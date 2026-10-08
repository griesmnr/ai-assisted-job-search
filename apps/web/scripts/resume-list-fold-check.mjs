#!/usr/bin/env node
// Measures a REAL computed layout property of the built app in a REAL
// headless browser: ticket 6b14962 ("A long saved-resume list pushes the
// paste form below the fold"). See apps/web/HEADLESS-BROWSER.md (ticket
// 9c78da1, 2026-10-07) for how the headless-browser setup this reuses works
// and why it exists; this is a SECOND, standalone script rather than an
// extension of apps/web/scripts/layout-check.mjs.
//
// Why a second script instead of extending layout-check.mjs: NOT because
// HEADLESS-BROWSER.md prescribes a separate file for a second claim --
// corrected on review: its "The OTHER 'measured in real Chromium' claim"
// section says a second fixture would be "a second worked example" built
// "the same way" (same technique, reused), and that whoever next touches
// that CSS region "should use it" -- it never says build a NEW FILE. The
// real reason rests on the ticket's own instruction instead: "do not
// refactor the existing script beyond what you need." layout-check.mjs
// checks ONE fixed claim (a 1rem gap) as a pass/fail GUARD; this script
// sweeps a matrix (3 resume counts x 2 viewports) as a before/after
// DEMONSTRATION with no hard exit code (see the bottom of `main` for why)
// -- different fixture (the resume picker/paste form, not the results list
// + magic-link anchor), different shape of result, different purpose.
// Bolting that onto layout-check.mjs would mean either changing its exit
// behavior and single-claim structure (a real refactor of a file reviewed
// and merged hours earlier, which the ticket said not to do beyond need)
// or cramming two unrelated purposes into one file's control flow. A
// second file was the smaller change, not something the docs required.
// This file duplicates layout-check.mjs's small Chromium-discovery/
// sysroot-bootstrap helpers (findBuiltCss/findCachedChromium/revisionOf/
// sysrootLibDir) rather than importing them, for the same reason: importing
// would mean exporting them from layout-check.mjs first, which is itself an
// edit to that file. Each duplicated site below carries a one-line pointer
// to layout-check.mjs's own comment for the non-obvious ones, so the
// reasoning isn't silently lost in the copy (review finding F2).
//
// Run from the repo root (same pattern as layout-check.mjs):
//
//   pnpm build && node apps/web/scripts/resume-list-fold-check.mjs
//
// What this demonstrates: ticket 6b14962's claim that a long saved-resume
// list (`.resume-pick-saved .resume-picker-options`, an unbounded
// `flex-direction: column`) pushes the paste form's textarea below the fold
// at a realistic viewport. It builds the exact DOM shape `ResumeInput.tsx`
// renders for the no-active-resume branch (verified against that component's
// source on 2026-10-07 -- see the fixture builder below for the exact
// elements and classes), loads the app's OWN BUILT CSS
// (apps/web/dist/assets/*.css), and measures where the "Or paste a new one"
// divider, the "Paste your resume" label, and the textarea itself land
// relative to two chosen viewport heights, for N = 3, 8, 15 saved resumes.
//
// Scope this covers, stated plainly for the next reader (same caveat
// layout-check.mjs gives itself): this is a HAND-BUILT fixture, not a render
// of ResumeInput.tsx itself. It guards index.css's layout rules against
// regression given this markup shape holds; it would NOT catch
// ResumeInput.tsx changing which elements render in this branch, renaming a
// class, or changing the picker's button markup -- in any of those the
// fixture would simply no longer match what the component actually
// produces, and would keep reporting PASS or FAIL for a shape the app no
// longer renders. Re-check this fixture against ResumeInput.tsx by hand
// whenever that file's no-active-resume branch (the one gated on
// `resumeId === undefined`) changes.
//
// Deliberately a standalone script, not a vitest suite member -- same
// reasoning as layout-check.mjs (see HEADLESS-BROWSER.md's "Does this belong
// in `pnpm test`?" section): cold-start cost (~2.5min first run, ~0.5s warm),
// environment dependency (needs a cached Playwright Chromium and, on a cold
// sysroot cache, network access to Ubuntu's package mirrors), and this
// ticket's own scope (one demonstration, not a CI-wired layout-regression
// suite).
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
  const cssFiles = readdirSync(distAssets).filter((f) => f.endsWith(".css"));
  if (cssFiles.length === 0) {
    console.error(`${distAssets} has no .css file -- did the build actually run vite build?`);
    process.exit(1);
  }
  // Deliberate -- concatenate ALL .css files, not just the first. See
  // layout-check.mjs's own `findBuiltCss` comment for the full reasoning
  // (Vite emits one file today, but a future route-level code-split could
  // emit a second chunk; taking only the first would silently measure a
  // partial stylesheet).
  return cssFiles.map((f) => readFileSync(join(distAssets, f), "utf8")).join("\n");
}

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
  // Deliberate -- shell-build preferred, then highest revision wins within
  // each kind. See layout-check.mjs's own `findCachedChromium` comment for
  // the full reasoning (a newer revision installed alongside an old one
  // must win, not whichever `readdirSync` happens to list first).
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

// The exact DOM shape ResumeInput.tsx's no-active-resume branch renders
// (`resumeId === undefined`, verified against apps/web/src/components/
// ResumeInput.tsx on 2026-10-07):
//
//   <div class="app">
//     <div class="app-header"><h1>...</h1><p class="signed-in-cue">These results
//       are saved to <strong>...</strong></p></div>                 (SignedInCue.tsx)
//     <nav class="tab-nav">...3 buttons...</nav>
//     <section class="resume-section">
//       <form class="resume-input">
//         <div class="resume-pick-saved">                       (only when savedResumes.length > 0)
//           <p class="resume-picker-heading">Use a saved resume:</p>
//           <div class="resume-picker-options">
//             <button class="resume-picker-option">Use ...</button>  x N
//           </div>
//           <p class="resume-picker-or">Or paste a new one</p>
//         </div>
//         <label for="resume-text">Paste your resume</label>
//         <textarea id="resume-text" rows="10" ...></textarea>
//         <div class="resume-input-actions">
//           <div class="resume-nickname-field">...</div>         (unconditional since ticket 3db5b35;
//                                                                  no Cancel/Submit button here -- both
//                                                                  are gated on non-empty text/an
//                                                                  existing resumeId, neither of which
//                                                                  holds in this fixture, matching the
//                                                                  REAL first-load state right after a
//                                                                  magic-link sign-in with saved resumes
//                                                                  and an empty textarea)
//         </div>
//       </form>
//     </section>
//   </div>
//
// No application code is exercised -- a static fixture using the app's real
// CSS, not ResumeInput.tsx/App.tsx themselves (same boundary layout-check.mjs
// draws for its own fixture).
function buildFixtureHtml(css, n) {
  const buttons = Array.from(
    { length: n },
    (_, i) => `<button type="button" class="resume-picker-option">Use Resume ${i + 1}</button>`,
  ).join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
<div class="app">
  <div class="app-header">
    <h1>FitScore</h1>
    <!-- Real markup/text from SignedInCue.tsx (verified against that file
         2026-10-07, corrected in review -- F4): a p element, not a span,
         and the component's actual sentence ("These results are saved to
         [strong]{email}[/strong]"), not a bare email address. An earlier
         draft of this fixture used span.signed-in-cue with just
         verified@example.com -- same class, much less text -- which was a
         fixture-fidelity bug regardless of whether it changed any number.

         Re-measured directly (byte-identical copies of this file with only
         the h1 text and this cue element swapped, N=15, both viewports):
         with the app's real <h1>FitScore</h1> (ticket 9e00bc9, merged).
         Swapping the short <span> placeholder for this real <p> markup
         costs +27.1px at the 390px phone viewport and 0.0px at 1366px.

         That cost is specific to the SHORT heading: "FitScore" fits beside a
         short cue on one line, where the previous longer heading forced
         .app-header to wrap at 390px regardless, making the cue's own
         length moot. Confirmed bit-for-bit both ways.

         It is the cost of CORRECTING THIS FIXTURE, not a change to the
         figures this ticket ships -- those are identical either way.

         A review initially cited +19.1px here and that is now RESOLVED, not
         left open: that measurement changed the element AND the email address
         in one step, and the longer address wraps the cue to a THIRD line at
         390px (header 79.7px vs 60.6px) under
         .signed-in-cue { overflow-wrap: anywhere }. It measured email
         wrapping, not markup. Both halves reproduced independently.
    -->
    <p class="signed-in-cue">These results are saved to <strong>verified@example.com</strong></p>
  </div>
  <!-- Ticket 0a378a5 (review F2): the welcome paragraph is UNCONDITIONAL as of
       that ticket, so it belongs in this fixture. It was absent here because
       this script predates the paragraph losing its gate, and that absence
       made this file model a page the app no longer renders -- it under-reported
       above-fold height by 146.3px at 1366/1280px wide and 235.9px at 390px,
       which is to say it was blind to the single largest thing above the paste
       form. Its PASS verdict survived only because the verdict keys on
       label.top / textarea.top, both of which stay above the fold; the
       headroom it printed was fiction.

       Text is copied verbatim from App.tsx's <p className="app-welcome">
       (verified against that file 2026-10-08). Copy length is the dominant
       term in this element's height at phone widths, so a paraphrase here
       would be a fixture-fidelity bug of exactly the kind the SignedInCue
       note above documents. If the paragraph's wording changes, change it
       here in the same commit. -->
  <p class="app-welcome">
    Welcome to FitScore! Find jobs that fit your experience&mdash;not just your search terms. We take
    the pain out of job hunting by searching open roles for you and comparing them directly with
    your resume. Each job gets a match score from 1&ndash;100, so you can quickly spot the
    opportunities that best align with your skills and experience. Spend less time searching and
    more time applying!
  </p>
  <nav class="tab-nav" aria-label="Sections">
    <button type="button" class="tab-button" aria-pressed="true">New Job Search</button>
    <button type="button" class="tab-button">Already Scored Jobs</button>
    <button type="button" class="tab-button">My Resumes</button>
  </nav>
  <div>
    <section class="resume-section">
      <form class="resume-input">
        ${
          n > 0
            ? `<div class="resume-pick-saved">
          <p class="resume-picker-heading">Use a saved resume:</p>
          <div class="resume-picker-options" id="saved-options">
            ${buttons}
          </div>
          <p class="resume-picker-or" id="or-divider">Or paste a new one</p>
        </div>`
            : ""
        }
        <label for="resume-text" id="paste-label">Paste your resume</label>
        <textarea id="resume-text" rows="10" placeholder="Paste resume text here..."></textarea>
        <div class="resume-input-actions">
          <div class="resume-nickname-field">
            <label for="resume-nickname">Resume Nickname</label>
            <input id="resume-nickname" type="text" value="Resume ${n + 1}" />
          </div>
        </div>
      </form>
    </section>
  </div>
</div>
</body></html>`;
}

// Two viewports, chosen and stated per the ticket's own instruction ("there
// is no single viewport height -- pick a defensible one... state it"):
//
// - 1366x768: the most common laptop screen resolution for most of the last
//   decade (StatCounter's desktop-resolution breakdowns have had 1366x768
//   at or near the top for years) and matches the 768px-tall figure the
//   parent ticket (e2b5f9c's follow-up) already named explicitly.
// - 390x844: the viewport size of the iPhone 12/13/14 -- the most common
//   modern iPhone form factor -- chosen as "a common phone" per the
//   ticket's instruction to pick one and state it, not because the owner's
//   own device is confirmed to be this exact model.
const VIEWPORTS = [
  { name: "laptop (1366x768)", width: 1366, height: 768 },
  { name: "phone (390x844, iPhone 12/13/14)", width: 390, height: 844 },
];
const RESUME_COUNTS = [3, 8, 15];

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
  // Deliberate -- prepend, don't replace. See layout-check.mjs's own launch
  // comment for the full reasoning (an `LD_LIBRARY_PATH` already set in the
  // calling environment must not be silently discarded).
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

  let anyBelowFold = false;

  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n=== ${viewport.name} ===`);
      for (const n of RESUME_COUNTS) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.setContent(buildFixtureHtml(css, n), { waitUntil: "load" });

        const metrics = await page.evaluate(() => {
          const label = document.getElementById("paste-label");
          const textarea = document.getElementById("resume-text");
          const divider = document.getElementById("or-divider");
          const optionsBox = document.getElementById("saved-options");
          const labelRect = label.getBoundingClientRect();
          const textareaRect = textarea.getBoundingClientRect();
          return {
            dividerTop: divider ? divider.getBoundingClientRect().top : null,
            labelTop: labelRect.top,
            textareaTop: textareaRect.top,
            textareaBottom: textareaRect.bottom,
            optionsScrollHeight: optionsBox ? optionsBox.scrollHeight : null,
            optionsClientHeight: optionsBox ? optionsBox.clientHeight : null,
          };
        });

        await page.close();

        const fold = viewport.height;
        const labelVisible = metrics.labelTop < fold;
        const textareaTopVisible = metrics.textareaTop < fold;
        const textareaFullyVisible = metrics.textareaBottom <= fold;
        const scrollable =
          metrics.optionsScrollHeight !== null &&
          metrics.optionsClientHeight !== null &&
          metrics.optionsScrollHeight > metrics.optionsClientHeight + 0.5;

        if (!labelVisible || !textareaTopVisible) anyBelowFold = true;

        console.log(
          `N=${String(n).padStart(2)}: ` +
            `divider.top=${metrics.dividerTop === null ? "n/a" : metrics.dividerTop.toFixed(1)}px  ` +
            `label.top=${metrics.labelTop.toFixed(1)}px (${labelVisible ? "visible" : "BELOW FOLD"})  ` +
            `textarea.top=${metrics.textareaTop.toFixed(1)}px (${textareaTopVisible ? "visible" : "BELOW FOLD"})  ` +
            `textarea.bottom=${metrics.textareaBottom.toFixed(1)}px (${textareaFullyVisible ? "fully visible" : "clipped/below"})  ` +
            `saved-list internal scroll=${scrollable ? "yes (scrollHeight " + metrics.optionsScrollHeight.toFixed(0) + "px > clientHeight " + metrics.optionsClientHeight.toFixed(0) + "px)" : "no"}`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  console.log(
    anyBelowFold
      ? "\nFAIL (informational, not a hard exit): at least one case has the label or textarea top below the fold."
      : // Scoped deliberately (ticket 0a378a5 review): this verdict only ever
        // answered the label/textarea-TOP question it was built for (6b14962).
        // Since the welcome paragraph became unconditional, textarea.bottom is
        // clipped in every row above, so an unqualified "PASS" printed directly
        // beneath them reads as a general all-clear that it is not.
        "\nPASS (label and textarea TOP only -- textarea.bottom is clipped/below in the rows above; " +
          "that is a known, measured, bounded cost of the always-visible welcome paragraph, tracked in " +
          "git-bug 7ca41c4, NOT a regression this script is failing to catch).",
  );
  // No process.exit(1) on "FAIL", UNLIKE layout-check.mjs's own exitCode=1
  // -- that script guards ONE fixed claim (a 1rem gap) as a pass/fail gate;
  // this one sweeps a matrix (3 resume counts x 2 viewports) and is run
  // deliberately both BEFORE and AFTER a fix to produce a before/after
  // comparison, so a nonzero exit on the expected-bad "before" run would
  // just be noise the caller has to route around. This script is a one-shot
  // demonstration tool, not a regression guard -- said explicitly, not left
  // to be inferred from the missing exit code. Exit code stays 0 whenever
  // the measurement itself succeeded; the before/after numbers in the
  // ticket's own report, and the comment above the CSS rule they justify,
  // carry the pass/fail verdict instead.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
