#!/usr/bin/env bash
# Rebuild-and-reattach the ai-assisted-job-search dev environment.
# Run this from the project root, on the host (not inside any container):
#
#   bash start-dev.sh
#
# Uses `docker compose --profile dev`, not a bare `docker run --name` (that
# was the previous version of this script, and the version that forced a
# full rebuild-from-scratch on 2026-09-02 after a force-quit: a
# manually-named `docker run` container that ends up in a bad state has no
# clean recovery short of removing and recreating it). The compose "dev"
# service (see docker-compose.yml) has `restart: unless-stopped`, so
# `up -d --build` is always the right command to rerun -- it reconciles
# cleanly whether the container is stopped, already running, or wedged,
# with no "does a container with this name already exist" branching here.
# It also already sits on the project's network, so postgres/rabbitmq
# resolve by service name with no `docker network connect` step.
set -euo pipefail
cd "$(dirname "$0")"

docker compose --profile dev up -d --build dev

echo
echo "Container is up. Attaching a shell..."
echo "Inside the container, run: bash start.sh   (launches Claude with permission prompts off)"
echo "  bash start.sh --continue    resumes the last Claude session instead of starting fresh"
echo

exec docker compose exec dev bash
