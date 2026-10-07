#!/usr/bin/env bash
# Downloads the shared libraries Playwright's cached Chromium needs that
# this container does not have, into a user-writable "sysroot" -- WITHOUT
# apt-get install and WITHOUT root.
#
# Background (ticket 9c78da1, dated 2026-10-07): this container's `dev` user
# cannot run `apt-get install` or `playwright install-deps` --
#
#   $ apt-get update
#   E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)
#   E: Unable to lock directory /var/lib/apt/lists/
#
#   $ sudo -n true
#   bash: sudo: command not found
#
# -- confirmed directly, not assumed. See apps/web/HEADLESS-BROWSER.md for
# the full investigation.
#
# The trick: apt-get's DOWNLOAD step doesn't need root, only its final
# `dpkg --install` (which writes to /var/lib/dpkg and runs maintainer
# scripts) does. `-o Dir::State::Lists=... -o Dir::Cache=...` points apt at
# throwaway, user-owned directories instead of the real system ones it can't
# write to; `--download-only` stops before the privileged step. The
# resulting .debs are then unpacked with `dpkg-deb -x`, which just extracts
# files to a plain directory (no dpkg status-db entry, no triggers, no
# privilege needed) -- not a system install. Point LD_LIBRARY_PATH at the
# result and the dynamic linker finds everything it needs without /usr or
# /var ever being touched as root.
#
# Verified end to end 2026-10-07 on this container (Ubuntu 24.04, aarch64):
# after extraction, `ldd` against Playwright's cached
# chromium_headless_shell-1234 binary reports zero "not found" libraries,
# and the binary launches and reports its version under
# `LD_LIBRARY_PATH=<sysroot>/usr/lib/aarch64-linux-gnu`.
set -euo pipefail

ARCH="$(uname -m)"
# $HOME, not the repo: this is a container-wide fact (what shared libs this
# OS image is missing), not a per-worktree or per-ticket one, and multiple
# worktrees under /workspace/.worktrees share the same $HOME. Same reason
# Playwright's own browser cache lives in ~/.cache/ms-playwright rather than
# inside any one checkout.
CACHE_ROOT="${CHROMIUM_SYSROOT_CACHE:-$HOME/.cache/chromium-sysroot-$ARCH}"
MARKER="$CACHE_ROOT/.complete"

if [[ -f "$MARKER" ]] && [[ "${1:-}" != "--force" ]]; then
  echo "chromium sysroot already present at $CACHE_ROOT (pass --force to redo)"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/state/lists/partial" "$WORK/cache/archives/partial"
mkdir -p "$CACHE_ROOT"

# The top-level packages actually missing, per `ldd` against the cached
# chromium_headless_shell binary (see HEADLESS-BROWSER.md for the full
# `ldd ... | grep "not found"` output this list comes from). Deliberately
# NOT a hardcoded list of the ~50 resulting .debs -- letting apt-get resolve
# the transitive closure itself means a future Ubuntu security update
# (noble-updates/noble-security) still resolves correctly without this
# script needing an edit.
PACKAGES=(
  libglib2.0-0t64
  libnspr4
  libnss3
  libatk1.0-0t64
  libdbus-1-3
  libxcomposite1
  libxdamage1
  libxfixes3
  libxrandr2
  libgbm1
  libxkbcommon0
  libasound2t64
  libatspi2.0-0t64
  libcups2t64
  libpango-1.0-0
  libcairo2
  libx11-6
  libxext6
  libxcb1
)

APT_OPTS=(
  -o "Dir::State::Lists=$WORK/state/lists/"
  -o "Dir::Cache=$WORK/cache/"
  -o "Dir::Cache::Archives=archives/"
  # `install --download-only` still probes dpkg's OWN lock
  # (/var/lib/dpkg/lock-frontend) before apt will even start resolving
  # dependencies, even though nothing in this invocation ever calls dpkg
  # --install -- apt's lock check doesn't know in advance that
  # --download-only will stop it short of that. This container's `dev`
  # user can't write there ("E: Could not open lock file
  # /var/lib/dpkg/lock-frontend ... Permission denied"), confirmed
  # 2026-10-07. `Debug::NoLocking=1` is apt's own documented escape hatch
  # for exactly this: it skips the lock-file check entirely rather than
  # trying to acquire a lock we have no permission to take. Safe here
  # specifically because this process never writes to /var/lib/dpkg (only
  # to $WORK and $CACHE_ROOT) -- it is not a workaround for a real
  # concurrent-apt race, there is no system apt state for a concurrent
  # process to race against.
  -o "Debug::NoLocking=1"
)

echo "Fetching package index into a throwaway dir (no write to /var/lib/apt)..."
apt-get "${APT_OPTS[@]}" update

echo "Downloading ${#PACKAGES[@]} packages + their dependencies (download-only, no install)..."
apt-get "${APT_OPTS[@]}" install --download-only --no-install-recommends -y "${PACKAGES[@]}"

shopt -s nullglob
debs=("$WORK"/cache/archives/*.deb)
if [[ ${#debs[@]} -eq 0 ]]; then
  echo "No .debs downloaded -- apt-get resolved nothing. Aborting without writing the marker." >&2
  exit 1
fi

echo "Extracting ${#debs[@]} .debs into $CACHE_ROOT (dpkg-deb -x, not a system install)..."
for deb in "${debs[@]}"; do
  dpkg-deb -x "$deb" "$CACHE_ROOT"
done

date -u +"%Y-%m-%dT%H:%M:%SZ" >"$MARKER"
echo "chromium sysroot ready at $CACHE_ROOT"
