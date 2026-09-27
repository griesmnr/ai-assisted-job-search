# syntax=docker/dockerfile:1
#
# Production image for apps/web (ticket 17d14b1): builds the Vite SPA and
# serves the static output with nginx. Build context must be the REPO
# ROOT (same reasoning as deploy/api.Dockerfile -- @app/web depends on
# @app/shared via `workspace:*`):
#
#   docker build -f deploy/web.Dockerfile \
#     --build-arg VITE_API_BASE_URL=https://api.example.com \
#     -t jobsearch-web .
#
# `VITE_API_BASE_URL` is baked in at BUILD time, not read at container
# startup -- Vite inlines `import.meta.env.*` into the built JS (see
# apps/web/src/api/client.ts). Rebuild the image if the deployed API's URL
# ever changes; there is no runtime env var that can override it after
# the fact.

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @app/shared run build
ARG VITE_API_BASE_URL
# Opus review, F3 (HIGH, verified live): an unpassed ARG becomes an EMPTY
# STRING env var, not an absent one -- client.ts's `?? "http://localhost:3000"`
# fallback only catches undefined/null, so a forgotten --build-arg here
# doesn't fall back to anything, it ships a build where every API call is a
# same-origin relative path against nginx, which happily 200s the SPA
# fallback for it -- a JSON-parse-error frontend that built, deployed, and
# "worked" all the way to a broken app. Fail the build instead.
RUN test -n "$VITE_API_BASE_URL" || \
  (echo "VITE_API_BASE_URL build-arg is required (the real https:// URL apps/api is served from) -- got an empty value" >&2 && exit 1)
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @app/web run build

FROM nginx:1.27-alpine AS runtime
# SPA fallback: the app has no client-side router today, but ticket
# 9f06f8f's magic-link verify page will add a second real route
# (`/verify` or similar) -- routing every unmatched path to index.html
# now means that ticket doesn't also need an nginx config change.
#
# Opus review, F4 (HIGH): a `.template` file under /etc/nginx/templates/
# is rendered through `envsubst` by the base image's own entrypoint at
# container START, not build time -- unlike a plain file dropped straight
# into conf.d, which would hardcode `listen 80` and (per the review,
# reproduced against Railway's own well-documented behavior for
# hardcoded-port nginx images) 502 on Railway, which assigns and injects
# a dynamic `PORT` per service. `ENV PORT=80` is the default for a plain
# `docker run`/self-host, where nothing else sets `PORT`.
ENV PORT=80
COPY deploy/web.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
