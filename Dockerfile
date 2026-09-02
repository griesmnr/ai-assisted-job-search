# Dev container for the AI-assisted job search project.
#
# Reproduces the environment documented in SETUP_HISTORY.md, in Dockerfile
# form, fixing the failures recorded there:
#
#   1. CA certificates were missing, so `go install` (and anything else doing
#      TLS) failed with "tls: failed to verify certificate". Fix: install
#      ca-certificates and run update-ca-certificates BEFORE any step that
#      talks to the network over HTTPS (go build/install, npm, curl).
#   2. `go install github.com/.../git-bug@latest` failed when SETUP_HISTORY.md
#      was recorded, against git-bug's floating master branch. This
#      Dockerfile instead builds git-bug at the pinned tag v0.10.1 for a
#      reproducible image -- and at that specific tag, `go install
#      github.com/git-bug/git-bug@v0.10.1` would in fact work standalone:
#      go.mod has no `replace` directives, and (unlike master at the time
#      this was first written) the web UI ships as committed, pre-generated
#      Go source (webui/packed_assets.go, produced by vfsgen) rather than an
#      embedded `dist/` directory that has to be built at compile time --
#      v0.10.1's Makefile `install` target is just `go generate; go install`,
#      with no webui/pnpm/Vite step (that lives in a separate `pack-webui`
#      target that `install` never calls). We still clone and `make install`
#      below, for parity with the exact sequence SETUP_HISTORY.md recorded
#      and verified working -- not because `go install` is broken at this
#      tag. If this Dockerfile ever tracks a newer git-bug tag where the
#      webui build IS back on the `install` path, re-check this comment.
#   3. Ubuntu 24.04's `apt install nodejs` gives Node 18, which is too old for
#      current pnpm. Fix: install Node 22 from the NodeSource repository
#      instead of the Ubuntu package. (This project's own toolchain needs
#      Node 22 + pnpm regardless of git-bug -- see CLAUDE.md's pnpm
#      workspaces monorepo layout -- so both stay in this image even though
#      git-bug's build no longer exercises them.)
#
# Note: git-bug v0.10.1's go.mod pins `go 1.24.0` (toolchain go1.24.2), newer
# than the Ubuntu 24.04 apt package (golang-go, currently 1.22.x). Go's
# GOTOOLCHAIN=auto default (set explicitly below) handles this transparently
# -- `make install` will download the required toolchain on first use. That
# download needs working CA certs (reason ca-certificates is installed
# first) and network access, and can add a few minutes to the first
# `docker compose build`. This is normal, not a hang.
#
# Claude Code ships in this image (added 2026-09-02, ticket 69608fc): the
# ticket originally scoped this out as "disruptive mid-project", but Nicole
# is now actively running Claude Code from inside a hand-built container
# with no reproducible source, which is the exact gap this ticket exists to
# close. Installed after the verification RUN below so a broken npm registry
# fetch for the (occasionally-updated) Claude Code package can't mask a
# failure in the toolchain steps that came before it.

FROM ubuntu:24.04

# Use bash with pipefail for every RUN below. Without this, Ubuntu's default
# /bin/sh (dash) does not support pipefail, so `curl ... | sh` style
# installers that fail mid-pipe (e.g. RTK's installer) exit 0 and leave a
# broken image with no error -- and CLAUDE.md mandates `rtk` for every
# command, so a silently-missing rtk breaks everything downstream with no
# clue why.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive
ENV GOTOOLCHAIN=auto

# Pin what we build/install from moving targets, so a rebuild next month
# doesn't silently pick up a different git-bug or rtk release.
ENV GIT_BUG_VERSION=v0.10.1
ENV RTK_VERSION=v0.45.0

# --- Base tools + CA certificates FIRST ---
# ca-certificates must be installed and activated before any step below that
# performs HTTPS (go build/install, npm, curl scripts) or TLS verification
# fails, per SETUP_HISTORY.md Step 5-6.
# build-essential: nothing in git-bug v0.10.1's module graph was found to
# require cgo (checked go.mod directly -- bleve v1.0.14 here is pure Go, and
# there is no go-faiss dependency at this tag). Kept anyway as cheap
# insurance: a missing C toolchain turns into a confusing cgo/linker error
# far from its cause, and the package costs comparatively little next to the
# base image. Revisit if image size becomes a real concern.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git \
        make \
        build-essential \
        golang-go \
        postgresql-client \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- Node 22 (NodeSource, not the Ubuntu 24.04 apt package which is Node 18) ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- pnpm ---
RUN npm install -g pnpm

# --- git-bug, built from source at a pinned tag ---
# `go install github.com/git-bug/git-bug@v0.10.1` would also work standalone
# at this tag -- see the top-of-file note. We still clone and `make install`
# here for parity with the exact sequence SETUP_HISTORY.md recorded and
# verified working, not because `go install` is broken. GOBIN is pinned to a
# directory already on PATH so the resulting binary is usable without
# further PATH changes. The Go module/build cache from this compile is
# pruned in the same layer so it doesn't bloat the image.
ENV GOBIN=/usr/local/bin
RUN git clone --branch "${GIT_BUG_VERSION}" --depth 1 \
        https://github.com/git-bug/git-bug.git /tmp/git-bug \
    && cd /tmp/git-bug \
    && make install \
    && cd / \
    && rm -rf /tmp/git-bug \
    && go clean -cache -modcache

# --- RTK, pinned via RTK_VERSION (supported by its install script) ---
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# --- Claude Code ---
# npm package requires Node 22+ as of v2.1.198, which we already have above.
RUN npm install -g @anthropic-ai/claude-code

# --- Build-time verification ---
# Fail the build here, in CI/on this machine, rather than leaving Nicole to
# discover a broken tool on her Mac with no diagnostic. Every tool this
# Dockerfile is supposed to provide must actually answer --version/version.
RUN node --version \
    && pnpm --version \
    && go version \
    && git-bug version \
    && rtk --version \
    && pg_isready --version \
    && claude --version

WORKDIR /workspace

# Stay running in the background under `docker compose up -d` so Nicole can
# attach a shell with `docker compose exec dev bash` at any time. A plain
# `bash` CMD would exit immediately with no attached TTY.
CMD ["sleep", "infinity"]
