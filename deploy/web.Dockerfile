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
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @app/web run build

FROM nginx:1.27-alpine AS runtime
# SPA fallback: the app has no client-side router today, but ticket
# 9f06f8f's magic-link verify page will add a second real route
# (`/verify` or similar) -- routing every unmatched path to index.html
# now means that ticket doesn't also need an nginx config change.
COPY deploy/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
