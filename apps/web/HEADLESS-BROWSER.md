# Headless browser in this dev container — findings (ticket 9c78da1)

Dated 2026-10-07. Read this before repeating the investigation.

## Conclusion

**Solved, not merely narrowed.** A headless Chromium launches in this
container, is driven by Playwright, and can measure real computed layout —
demonstrated below on an actual regression this project shipped and could
not verify in-container (ticket 931df8a's magic-link-prompt spacing). The
one command to run it is:

```bash
pnpm build && node apps/web/scripts/layout-check.mjs
```

The earlier finding that blocked this ("the cached Playwright Chromium in
this container fails to start — `libglib-2.0.so.0`, `libnss3.so`,
`libatk-1.0.so.0` and others missing") was correct as far as it went, but
stopped one step short: the missing pieces are ordinary Ubuntu shared
libraries, and getting them onto disk does **not** require `apt-get
install` or root — only `apt-get`'s dependency _resolution_ and _download_
steps are needed, and those run fine as an unprivileged user once pointed
at writable scratch directories. See "How it actually works" below.

## This container is not root, confirmed directly

Per this ticket's own notes, the trap was assuming a path forward rather
than checking. Checked first:

```
$ whoami
dev
$ id
uid=1001(dev) gid=1001(dev) groups=1001(dev)
$ sudo -n true
bash: sudo: command not found
$ apt-get update
E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)
E: Unable to lock directory /var/lib/apt/lists/
```

So: no root, no `sudo` binary at all, and `apt-get update`/`install` refuse
exactly as the ticket predicted. `playwright install-deps` (which just shells
out to `apt-get install`) was not even tried — it would fail for the
identical reason.

**This container is a different sandbox from the project's own
`docker compose` "dev" service** (built from the repo's own `Dockerfile`),
despite surface similarity — confirmed by the absence of a `docker` CLI
here at all (`which docker` exits 1), by `whoami` being `dev`/uid 1001 where
the Dockerfile's `dev` service has no `USER` directive and would run as
root, and by the `/workspace` mount being `fakeowner` rather than a plain
bind mount. **Editing the repo's `Dockerfile` would not fix this
container** — it would only affect Nicole's own dev container, which is a
different thing with (presumably) its own real host browser available to
her already. Everything below is scoped to the sandbox agents actually run
in.

## What was already present

Checked before assuming nothing existed:

- `/home/dev/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/`
  — a cached Chromium build (headless-shell variant) from an earlier
  session's `npx playwright install`, confirmed present but non-functional:
  ```
  $ ldd .../headless_shell | grep "not found"
  	libglib-2.0.so.0 => not found
  	libgobject-2.0.so.0 => not found
  	libnspr4.so => not found
  	libnss3.so => not found
  	libnssutil3.so => not found
  	libgio-2.0.so.0 => not found
  	libatk-1.0.so.0 => not found
  	libdbus-1.so.3 => not found
  	libXcomposite.so.1 => not found
  	libXdamage.so.1 => not found
  	libXfixes.so.3 => not found
  	libXrandr.so.2 => not found
  	libgbm.so.1 => not found
  	libxkbcommon.so.0 => not found
  	libasound.so.2 => not found
  	libatspi.so.0 => not found
  ```
  This matches the ticket's own description exactly.
- No `chromium`/`chromium-browser`/`google-chrome` binary anywhere on `PATH`.
- No `playwright`/`playwright-core`/`puppeteer` npm package installed
  anywhere in the repo yet.
- `uname -m` → `aarch64`. The container is ARM64, which matters for which
  Playwright/Ubuntu package builds are the right ones (all commands below
  are already arm64-correct; an x86_64 container would need the same
  technique with `x86_64-linux-gnu` library paths instead).
- `dpkg`, `dpkg-deb`, and `ar` are all present and usable as a non-root user
  (they only refuse when _writing to the system dpkg/apt state_, which
  normal `.deb` extraction does not touch).
- Outbound network access to `archive.ubuntu.com`/`ports.ubuntu.com` (Debian
  package mirrors) works from this container.

## How it actually works

`apt-get`'s privilege requirement is narrower than "needs root to do
anything" — it needs root only to **write to `/var/lib/apt`,
`/var/cache/apt`, and `/var/lib/dpkg`**, and to run `dpkg --install`'s
maintainer scripts. The dependency-resolution and download steps don't
touch any of that if told not to:

```bash
apt-get \
  -o Dir::State::Lists="$WORK/state/lists/" \
  -o Dir::Cache="$WORK/cache/" \
  -o Dir::Cache::Archives="archives/" \
  -o Debug::NoLocking=1 \
  install --download-only --no-install-recommends -y \
  libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libdbus-1-3 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libxkbcommon0 libasound2t64 libatspi2.0-0t64 libcups2t64 \
  libpango-1.0-0 libcairo2 libx11-6 libxext6 libxcb1
```

- `Dir::State::Lists`/`Dir::Cache` redirect apt's own bookkeeping to a
  throwaway, user-owned directory instead of the real system ones it can't
  write to.
- `--download-only` stops before the one step (`dpkg --install`) that
  actually needs root.
- `Debug::NoLocking=1` is needed too, and was the second surprise: even
  `--download-only` probes `/var/lib/dpkg/lock-frontend` before doing
  anything, and fails the same way apt-get update does without it:
  ```
  E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)
  E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?
  ```
  `Debug::NoLocking=1` is apt's documented escape hatch for exactly this —
  safe here because this process never writes to `/var/lib/dpkg` at all, so
  there's no real concurrent-install race for the lock to protect against.
- Result, confirmed: 51 `.deb` files (59.9 MB), the 19 requested packages
  plus their transitive dependencies, resolved correctly by `apt-get`
  itself against live `noble`/`noble-updates`/`noble-security` indices.

Then, with no `dpkg --install` (and so no root, no status-db entry, no
triggers) at all:

```bash
for deb in "$WORK"/cache/archives/*.deb; do
  dpkg-deb -x "$deb" "$PREFIX"
done
```

`dpkg-deb -x` just unpacks a `.deb`'s file tree into an arbitrary directory
— it is explicitly the "don't actually install this" mode of the tool.
Pointing the dynamic linker at the result closes the loop:

```
$ LD_LIBRARY_PATH="$PREFIX/usr/lib/aarch64-linux-gnu" ldd headless_shell | grep "not found"
(nothing — exit 1)
$ LD_LIBRARY_PATH="$PREFIX/usr/lib/aarch64-linux-gnu" headless_shell --version
Chromium 151.0.7922.34
$ LD_LIBRARY_PATH="$PREFIX/usr/lib/aarch64-linux-gnu" headless_shell \
    --headless --no-sandbox --disable-gpu --dump-dom "data:text/html,<h1>hi</h1>"
<html><head></head><body><h1>hi</h1></body></html>
```

(The dbus/gpu warnings Chromium prints alongside that are expected noise in
a container with no D-Bus daemon or GPU device — harmless, not errors.)

This is packaged as `apps/web/scripts/fetch-chromium-sysroot.sh`, which
downloads+extracts into `$HOME/.cache/chromium-sysroot-<arch>` (not inside
the repo or any one worktree — this is a container-wide fact, like
Playwright's own `~/.cache/ms-playwright`, and multiple worktrees under
`/workspace/.worktrees` share the same `$HOME`). It's idempotent (checks a
`.complete` marker; `--force` to redo) and is called automatically by
`layout-check.mjs` the first time it's needed, so the documented one-command
path bootstraps itself on a cold cache.

`--no-sandbox` is required too: Chromium's sandbox needs namespace/seccomp
privileges this container's unprivileged user doesn't have. Acceptable here
for the same reason it's commonly accepted in CI containers — this is a
disposable process rendering fixture HTML we wrote ourselves, not an
attacker-controlled page.

## Playwright version vs. cached browser revision — a second landmine, avoided

`playwright-core`'s own browser-management code (`chromium.executablePath()`)
only returns a path for the _exact_ Chromium revision its own installed
version expects (checked: `playwright-core@1.63.0` expects revision `1243`;
the browser already cached in this container from an earlier session is
revision `1234` — a different, slightly older build). Asking Playwright to
resolve the path itself would have reported "not installed" and tried to
download a second copy.

The fix: `layout-check.mjs` finds the cached build itself (scans
`~/.cache/ms-playwright/` for any `chromium_headless_shell-*` or
`chromium-*` directory) and passes it to `chromium.launch({ executablePath:
... })` explicitly. Passing `executablePath` skips Playwright's revision
check entirely — CDP (the protocol Playwright drives the browser over) is
stable enough across adjacent point releases for what this script does
(navigate, read computed style/layout). Confirmed working end to end with
this exact mismatch in place.

## The demonstration

`apps/web/scripts/layout-check.mjs` builds the exact DOM shape
`ResultsList.tsx`/`App.tsx` produce around the magic-link portal anchor —
verified against the actual component source, not reconstructed from
memory:

**Scope this actually covers, stated plainly because the next agent reading
only this file (not the script) needs it too:** the script hand-writes this
HTML; it does not render `ResultsList.tsx`, `App.tsx`, or `MagicLinkPrompt.tsx`
themselves. It guards `index.css`'s layout rules against regression, given
the markup shape below holds — it would NOT catch `ResultsList.tsx` moving
the anchor off the first result, `App.tsx` renaming
`magic-link-prompt-host`, `MagicLinkPrompt.tsx` changing its root element,
or the anchor gaining real children: in every one of those the fixture
still reads 16px and stays green while the real app regresses, because the
fixture's markup would simply no longer match what the components actually
produce. Re-check this comparison by hand against source whenever those
three files change, the same way it was built.

```html
<ul class="result-cards">
  <li class="result-card">...</li>
  <li class="magic-link-prompt-anchor" role="presentation">
    <div class="magic-link-prompt-host">
      <section class="magic-link-prompt">...</section>
    </div>
  </li>
  <li class="result-card">...</li>
</ul>
```

loads the app's own **built** CSS (`apps/web/dist/assets/*.css`, produced by
`pnpm build` — not a hand-copied excerpt), and measures the real gap between
the first result card and the prompt via `getBoundingClientRect()`.

Run against the current (fixed) build:

```
root font-size: 16px
measured gap, first result card -> magic-link-prompt: 16px (1.000rem)
PASS: gap matches .result-cards' own gap: 1rem, within 0.5px.
```

That confirms ticket 931df8a's review fix (`.magic-link-prompt-anchor
.magic-link-prompt { margin-top: 0; }`) actually produces 1rem in a real
browser, matching `.result-cards`' own `gap: 1rem` — the claim index.css's
comment made "by inspection, not a screenshot."

**Proof the check has real teeth**, not just agreement with the current
CSS — the pre-fix bug (`margin-top: 1.5rem` instead of `0`) was reproduced
by editing the _built_ CSS directly and re-running:

```
root font-size: 16px
measured gap, first result card -> magic-link-prompt: 40px (2.500rem)
FAIL: expected 16px (1rem), got 40px (2.500rem) -- off by 24.00px. If this is
exactly 1.5rem (24px) MORE than expected, the margin/gap-collapse bug is back.
exit: 1
```

40px = 2.5rem = exactly the bug ticket 931df8a's review fixed (1rem gap +
1.5rem margin, not collapsed, because a flex item's margin never collapses
with its container's `gap`). The built CSS was restored immediately after.

## The OTHER "measured in real Chromium" claim in index.css

`index.css` line 40's comment (the `h1`/`.tab-nav` margin-collapse figures,
16px vs 32px) is a **separate** claim from the one this ticket's
demonstration targets. It is **not** re-verified by `layout-check.mjs` —
doing so would need a second fixture (the `.app-header`/`h1`/`.tab-nav`
markup in each of its three states: cue present, absent, recovery link
open), which is a second worked example, not the one asked for here. Per
this ticket's scope ("one real demonstration is the deliverable; a test
suite is a later ticket"), that claim is annotated rather than re-verified:
the tool to check it now exists (this same technique — build a fixture with
the real markup, load the real built CSS, measure
`getBoundingClientRect()`), and whoever next touches that CSS region should
use it rather than inspection alone.

## What if `~/.cache/ms-playwright` is empty (a fresh container rebuild)?

Nothing in this ticket installs a Playwright browser itself.
`layout-check.mjs`'s `findCachedChromium()` only ever looks for one already
cached, and fails loudly with the exact fix if none is found:

```
No cached Chromium found under ~/.cache/ms-playwright. Run:
  npx playwright-core install chromium-headless-shell
first (needs network access to Playwright's CDN, not apt). Note: `playwright-core`, not `playwright` -- that's the package actually installed here (see HEADLESS-BROWSER.md's dependency section); `npx playwright ...` would fetch a different, unpinned package.
```

(Verbatim, including the trailing note — an earlier draft trimmed the last
sentence, which the prose below then paraphrased. Quoting real output and then
silently shortening it is how a doc stops being checkable against the thing it
documents.)

That's `playwright-core install`, **not** `playwright install` — only
`playwright-core` is a dependency here (see "Dependency added" below); the
plain `playwright` package isn't installed at all, so `npx playwright ...`
would silently fetch a second, different, unpinned package from the
registry just to run one subcommand, rather than using the one this ticket
already pinned.

This is a deliberate split, not an oversight: downloading a BROWSER needs
network access to Playwright's own CDN, which is a completely different
concern from this ticket's actual subject (getting the SYSTEM LIBRARIES an
already-cached browser needs onto disk without root). The container this
was built in already had a cached browser (left over from an earlier
session); a container rebuilt from scratch with no `ms-playwright` cache at
all needs the one-time `npx playwright-core install` command above before
`layout-check.mjs` has anything to find.

## Does this belong in `pnpm test` / the normal `vitest` suite?

**No — kept as an on-demand script, not wired into `vitest` or `pnpm
test`.** Decided explicitly, not by default:

- **Cold-start cost is real and network-dependent.** The _first_ run on a
  machine with no sysroot cache yet downloads ~60MB of `.deb`s from the
  Debian/Ubuntu mirrors (measured: ~2.5 minutes at this container's network
  speed, in two separate `apt-get` round trips). A CI runner or a freshly
  rebuilt container pays that cost on its very first invocation — acceptable
  for an on-demand check, not acceptable as a tax on every `vitest` run or
  every `git push`.
- **Warm-cache cost is small** (confirmed: ~1 second once the sysroot and
  Playwright's own browser cache are both already populated) — fast enough
  that the cost argument against normal-suite membership is specifically the
  COLD path, not browser launch overhead itself.
- **Environment dependency.** It needs outbound access to Ubuntu's package
  mirrors (for the one-time sysroot fetch) and a pre-existing Playwright
  Chromium cache (`~/.cache/ms-playwright`, not something this ticket
  installs — see "What if `~/.cache/ms-playwright` is empty" above). Neither
  is guaranteed in every environment
  this repo's tests might run in (a network-restricted CI runner, for
  instance). `vitest`'s own suite must keep working with neither present —
  see CLAUDE.md's existing `.env`-less-worktree skip-count warning for why a
  suite that silently degrades instead of failing loud is already a known
  risk here, and adding a second thing that can silently skip would compound
  it.
- **This ticket's own scope.** One demonstration is the deliverable; a
  layout guard that runs on every commit, for every CSS change, is the
  "broad suite" the ticket explicitly puts out of scope. Promoting this one
  script into the normal suite without that broader design (what else gets
  checked, how flaky real-Chromium measurements are tolerated, baseline
  management) would be scope creep in the other direction.

Run it **on demand** when a layout claim needs checking — exactly the
situation that motivated this ticket — via the one documented command at
the top of this file.

## Dependency added: `playwright-core`

- `apps/web/package.json` devDependency, `^1.63.0`.
- **Not** the `playwright` package (which bundles a CLI and its own
  browser-management/auto-download machinery) — `playwright-core` is the
  bare driver library with zero further npm dependencies of its own
  (confirmed via `npm view playwright-core@1.63.0` — no `dependencies`
  field) and does not try to download a browser on `pnpm install`, which
  matters here specifically because this setup deliberately drives an
  _already-cached_ browser by explicit `executablePath` rather than letting
  Playwright manage one itself.
- Needs no system libraries of its own — it's pure JS/TS talking CDP over a
  pipe/websocket to whatever browser executable it's pointed at. All the
  system-library work in this ticket is for the _browser_, not for
  `playwright-core`.
- Unpacked size ~13.4MB (`npm view playwright-core@1.63.0 dist.unpackedSize`).

## Verification performed

```
$ pnpm build        # from repo root
packages/shared build: Done
apps/api build: Done
apps/web build: Done

$ pnpm lint
(clean)

$ POSTGRES_HOST=127.0.0.1 RABBITMQ_HOST=127.0.0.1 npx vitest run
 Test Files  90 passed (90)
      Tests  1717 passed (1717)
   Duration  145.36s
(0 skipped -- confirmed by grep -ic skip on the full run output; see
CLAUDE.md's own warning about a worktree with no .env silently skipping
every DB-backed suite while still printing a green-looking summary line --
this run had a real .env copied into the worktree, and the skip count was
checked directly rather than inferred from PASS/FAIL alone)
```

Run 2026-10-07, on this worktree (`ticket/9c78da1-headless-browser`).

`eslint.config.js` gained one new block scoped to `**/scripts/**/*.mjs`,
declaring the Node (`process`, `console`) and browser (`document`,
`getComputedStyle` — used only inside `page.evaluate()` callbacks, which
ESLint parses as ordinary in-file code even though Playwright actually runs
them inside the browser page) globals `layout-check.mjs` needs. No existing
file's lint behavior changes — the glob only matches the new `scripts/`
directory, and this repo had no other bare `.mjs`/`.cjs` file before this
ticket.

## Known rough edges — recorded, not fixed

Flagged in review (2026-10-07) as real but not blocking. Each gets one
sentence here so the next person doesn't have to rediscover them:

- **Ubuntu-release-specific package names.** `fetch-chromium-sysroot.sh`'s
  `PACKAGES` list uses Ubuntu 24.04 ("noble") time64-transition names like
  `libglib2.0-0t64`; on a differently-versioned base image, `apt-get` would
  say `Unable to locate package` and the script fails safely (no `.deb`s
  extracted, `.complete` marker never written) but without saying _why_ —
  whoever hits this on a non-noble container should expect to update the
  package list for that release's naming, not debug the apt plumbing above.
- **A corrupted-but-marked cache fails unhelpfully.** If `.complete` exists
  but the extracted lib directory is missing or incomplete (manually
  deleted, partial copy, etc.), `layout-check.mjs` skips re-fetching (the
  marker says "done") and the actual failure surfaces ~60 lines deep in
  Playwright/Chromium's own startup error wall, with the one actionable
  line ("missing shared library") buried in GPU/sandbox noise rather than a
  one-line diagnosis pointing at `--force`.
- **Script mode mismatch.** `layout-check.mjs` carries a
  `#!/usr/bin/env node` shebang but is committed at mode `100644`, i.e. not
  executable (`git ls-files -s` → `100644 … layout-check.mjs`). Harmless
  today, because every documented invocation runs it as `node
apps/web/scripts/layout-check.mjs` or through the `layout-check` package
  script — the shebang is simply never used. It would bite only someone who
  tried `./apps/web/scripts/layout-check.mjs`. Fix by dropping the shebang or
  setting the bit; left as-is deliberately rather than churning the mode.
  (`fetch-chromium-sysroot.sh` IS `100755` and is fine — an earlier draft of
  this entry described that file instead, which was a "confirmed" stamped on
  the wrong subject. Corrected in re-review, and recorded because
  mis-attributed verification is the exact failure mode this whole ticket
  exists to reduce.)

## What a future agent should NOT need to repeat

- Whether `apt-get`/`sudo` work as this user: they don't, confirmed above.
- Whether the Dockerfile is the right place to fix this: it is not — this
  container isn't built from it.
- The exact `Debug::NoLocking=1` requirement for `--download-only`: easy to
  miss (the first attempt without it failed on the _dpkg_ lock, not the
  _apt_ lock already worked around) — see "How it actually works".
- The Playwright-version-vs-cached-revision mismatch and its fix
  (`executablePath` override).

Re-run `apps/web/scripts/fetch-chromium-sysroot.sh --force` if any of this
needs re-verifying against a different Ubuntu release or architecture.
