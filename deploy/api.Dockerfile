# syntax=docker/dockerfile:1
#
# Production image for apps/api (ticket 17d14b1). Distinct from the
# repo-root Dockerfile, which builds a dev container for running Claude
# Code itself (see that file's own header) -- this ships nothing but the
# built server: no git-bug, no rtk, no Claude Code, no dev tooling.
#
# Build context must be the REPO ROOT, not apps/api, because @app/api
# depends on @app/shared via `workspace:*` -- pnpm needs the whole
# workspace present to resolve and build it. From the repo root:
#
#   docker build -f deploy/api.Dockerfile -t jobsearch-api .
#
# The container runs `drizzle-kit migrate` before starting the server (see
# CMD below) -- fine for this project's scale (one instance, no rolling
# deploys yet), but a real multi-instance deploy would need migrations
# pulled out into a separate release step so N starting instances don't
# race the same migration. Revisit if this ever needs more than one
# api replica.

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# @app/shared must build first -- @app/api's own build imports its
# compiled dist/, not its TS source (see tsconfig.json's moduleResolution).
RUN pnpm --filter @app/shared run build
RUN pnpm --filter @app/api run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Copied whole rather than pruned per-package: pnpm's workspace
# node_modules layout is symlinks (apps/api/node_modules/@app/shared ->
# ../../packages/shared, and per-package node_modules -> the root
# .pnpm store) that only resolve correctly when the surrounding directory
# structure is preserved exactly -- see CLAUDE.md's worktree section for
# the exact failure mode a broken version of this produces. Preserving the
# full /repo layout side-steps that class of bug entirely, at the cost of
# carrying devDependencies (eslint, vitest, tsx, ...) into the runtime
# image. Deliberate simplification for this project's current scale (one
# small side project, not a size-sensitive fleet) -- pruning to a
# --prod-only image is a legitimate later optimization, not done here.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/api ./apps/api

WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["sh", "-c", "node_modules/.bin/drizzle-kit migrate && node dist/index.js"]
