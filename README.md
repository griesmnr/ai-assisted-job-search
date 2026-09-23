# AI-Assisted Job Search

[![CI](https://github.com/griesmnr/ai-assisted-job-search/actions/workflows/ci.yml/badge.svg)](https://github.com/griesmnr/ai-assisted-job-search/actions/workflows/ci.yml)

You pick which job boards to search, paste in a resume, and get back postings
ranked by an AI-generated match score against that resume, best match first.
Under the hood it fans a search out across several independent, unreliable
job-board APIs and treats that unreliability as the actual design problem,
not an edge case.

This is a working pipeline against live data, not a canned demo: it queries
real job board APIs and scores real, currently open postings against a real
resume, and every number in this README came from a real run or a real
commit, not a projection.

## What it does, today

All of this currently runs end to end as a single script
(`apps/api/src/demo-match.ts`), not through the queue-driven architecture
diagrammed below — that part is still being built. See
[Current state](#current-state) for exactly what's real.

- Four job-board APIs (Greenhouse, Lever, Ashby, SmartRecruiters), covering
  several dozen configured employers, searched in one pass.
- Postings are normalized into one `Job` shape, filtered down to
  software-engineering roles in a target location, deduplicated, and scored
  against a resume by Claude — each score comes back as a 0-100 number plus
  a rationale, strengths, and gaps, not free text.
- Jobs, resumes, and match scores are persisted, so re-running a search
  never re-pays for a score it already has.

## Current state

Built and tested:

- Four source adapters (Greenhouse, Lever, Ashby, SmartRecruiters), each
  with its own idiosyncrasies handled — see
  [Source adapters](#source-adapters).
- A Postgres schema (Drizzle) with idempotent upserts on jobs, resumes, and
  match scores.
- A RabbitMQ topology with per-queue dead-letter exchanges and a
  tiered-backoff retry path (see
  [Retries, dead letters, and idempotency](#retries-dead-letters-and-idempotency)),
  plus a `fetch.source` worker that consumes it.
- An end-to-end vertical slice (`demo-match.ts`) that runs the real
  pipeline — search, filter, score, persist — against live APIs and a real
  Anthropic account.

Not built yet:

- **The REST API has no routes.** `apps/api/src/index.ts` builds a bare
  Fastify instance; `POST /searches` and `GET /searches/:id/results` don't
  exist yet.
- **The frontend is not built.** `apps/web` is a placeholder scaffold — no
  source toggles, no resume input, no results list.
- **There is no `score.job` worker.** The RabbitMQ topology and the
  `fetch.source` worker are real, but scoring currently happens
  synchronously inside `demo-match.ts`, not as a queue consumer. The queue
  path for scoring is designed (see the diagram below) but not implemented.
- **The ranked list you'd get today is missing real candidates.** Widening
  the funnel from 4 employers to dozens (across four sources) took the pool
  of matching postings from 13 survivors to 166 (about 13x) — and changed
  the actual output by nothing, because the shortlist takes the first 12
  survivors in source-iteration order rather than the best 12. Filed as an
  open bug, not hidden — see
  [What "adversarial review" actually catches](#what-adversarial-review-actually-catches)
  for the details.
- **A fifth adapter (USAJOBS) exists but isn't wired in.** It's fully
  built and tested against recorded fixtures, but the current search only
  configures the four ATS sources above.

## Architecture

```mermaid
flowchart LR
    UI["React frontend\n(not built yet)"] -->|"POST /searches"| API["Fastify API\n(no routes yet)"]
    API -->|"1 fetch.source msg\nper selected source"| FQ["fetch.source queue"]
    FQ --> FW["fetch.source worker\n(built)"]
    FW -->|normalize + upsert| DB[(Postgres)]
    FW -->|"1 score.job msg\nper new job"| SQ["score.job queue"]
    SQ --> SW["score.job worker\n(not built yet)"]
    SW -->|resume + description| Claude["Claude\n(match score)"]
    Claude --> SW
    SW --> DB
    UI -.->|poll / render ranked list| API
```

Two work queues, `fetch.source` and `score.job`, each with its own
dead-letter exchange. A search publishes one `fetch.source` message per
selected job source; each source that successfully ingests a job publishes
one `score.job` message for it. The `fetch.source` side of this — topology,
worker, retry, DLQ — is built. The `score.job` worker is designed but not
implemented; today, scoring happens synchronously inside `demo-match.ts`
instead of through the queue.

### Why a queue, not a direct fan-out

A search hits four independent job-board APIs that are unequal and
unreliable in different ways: one rate-limits, one 404s a mistyped board
name, one returns HTTP 200 with zero results for both a real employer with
no openings and a nonexistent one (see
[Source adapters](#source-adapters)). A synchronous fan-out means one slow
or failing source blocks or corrupts the whole search. A queue gives each
of the three patterns below an actual home instead of being bolted on
after the fact.

### Retries, dead letters, and idempotency

- **Retries.** A retryable failure (rate limit, transient network error) is
  republished into one of five backoff-tier queues
  (`fetch.source.retry.1s` … `.60s`) rather than retried inline. Each tier
  is its own durable queue with a queue-level TTL, not a shared queue with
  a per-message expiration — RabbitMQ only evaluates TTL at the head of a
  queue, so a shared queue with mixed per-message TTLs would let a
  long-TTL message block every shorter-TTL message queued behind it, which
  turns "back off gradually" into "wait, then retry everything against a
  struggling source at once." A non-retryable failure (bad credentials, a
  malformed response) skips retry entirely and dead-letters immediately —
  retrying a request that can never succeed just delays the operator
  finding out. Attempt count is tracked via an `x-attempt` message header,
  since RabbitMQ doesn't count attempts for you; the top 60s tier exists
  specifically because some sources hand back a `Retry-After` in that
  range, and without a tier that can hold that long the worker would clamp
  down to 8s and get rate-limited again inside the same window.
- **Dead-letter queues.** A message that exhausts its retries, or that was
  never retryable, lands in `fetch.source.dlq` or `score.job.dlq`. That
  source is then reportable as unavailable — distinct from "searched and
  found nothing" — while every other configured source still returns.
  Product behavior, not a demo: a search doesn't fail because one board is
  down.
- **Idempotency.** Jobs upsert on `(data_source, external_id)`; the
  `search_results` join table has a unique constraint on
  `(search_id, job_id)`; match scores are unique on `(resume_id, job_id)`;
  resumes are content-addressed by a sha256 hash so identical resume text
  is stored once. A redelivered `fetch.source` message (RabbitMQ's
  at-least-once delivery, or a worker dying mid-run) re-links existing rows
  instead of duplicating them, and never re-publishes a `score.job` message
  for a job it already ingested. This matters commercially, not just
  architecturally: without it, a redelivery re-scores a job through the
  Anthropic API and pays for it again.

## Source adapters

Every adapter implements the same `JobSource` interface
(`search(criteria) -> { jobs, skipped }`) but the four APIs behind it
disagree about almost everything else.

| Source              | What makes it awkward                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Greenhouse**      | No server-side location/keyword query support — every search downloads a whole board and filters client-side. No public directory maps a company name to its board token, so candidates have to be checked individually (`check-greenhouse-board.ts`) before being added; of 25 hand-guessed tokens in this project's own history, 7 (28%) weren't on Greenhouse at all, and 13 more (about half) resolved to real, sizeable boards that still contributed zero postings after filtering. |
| **Lever**           | Posting content is split across a plain-text summary field and a separate `lists` field that actually holds the requirements — reading only the summary field discards the majority of a posting's real content. Location is similarly split between one canonical field and an `allLocations` array that doesn't always agree with it; reading only one silently drops real matches, and it took three review rounds to land on reading the union of both correctly.                     |
| **Ashby**           | Location data is spread across a primary field, a `secondaryLocations` array, and a structured `address.postalAddress` block that's absent from the API response unless you read it — missing any one of the three silently zeroes out entire cities' worth of results. Compensation data only exists at all behind an undocumented query parameter.                                                                                                                                      |
| **SmartRecruiters** | Returns HTTP `200` with `totalFound: 0` for both a real employer with no current openings and a completely nonexistent company identifier — byte-identical responses. Distinguishing the two required an independent liveness check against the company's own careers-site redirect behavior. Descriptions live behind a separate per-posting detail endpoint, so a large employer can cost thousands of extra HTTP requests for one search.                                              |

## What "adversarial review" actually catches

Every change here goes through adversarial review by a stronger model
before it merges — its job is to find reasons the change should _not_
merge, not to approve it. That process has repeatedly caught the same
defect shape: code that passed its own tests while being silently,
materially wrong. A few examples, verifiable in the git history:

- The Lever adapter originally stored only a posting's marketing summary,
  discarding 69-74% of every posting's actual text — including every
  requirements section. The suite's one content assertion checked the
  marketing intro, which the bug left intact, so the test passed with
  69-74% of every posting missing (`c4e51ab`).
- Adversarial review caught that the Ashby adapter never read
  `address.postalAddress`: `search({ location: "New York City" })`
  returned zero results while 115 real postings were headquartered there.
  (The adapter had already caught a related gap on its own before review
  even started — a separate unread field, `secondaryLocations` — see
  [Source adapters](#source-adapters).) (`e5ca1f1`)
- A migration backfilling a resume-content hash used
  `"resume_text"::bytea`, which parses text as bytea _escape_ syntax, not
  raw bytes. A resume containing a Windows path like `C:\Users\...` aborted
  the migration outright; one containing a sequence like `\101` succeeded
  with a silently wrong hash — which meant the de-duplication this feature
  exists for would never fire, and every run would re-pay Anthropic for a
  resume it had already scored. It passed two prior reviews because the
  database had zero resume rows at the time, so the backfill had never
  actually executed (`2d3ff4c`).
- A test suite reported `83/83 tests passed` while the file itself had
  failed — the failure was in teardown, so the test count stayed green and
  hid it (`2d3ff4c`).
- Widening the search funnel from 545 postings to 11,609 across two
  tickets changed the ranked list a user actually sees by nothing, because
  a fixed `slice(0, 12)` took the first twelve survivors in source order
  rather than the best twelve — filed as an open bug, not silently
  shipped (`cc793ee`, ticket `16c824a`).

The recurring lesson: **make broken look different from empty.** That's
why every adapter reports a per-token/per-board `skipRate` distinct from a
board simply having no openings, why a 404'd board is recorded as a
`SkippedRecord` rather than silently dropped, and why a truncated run must
never look identical to a complete one.

## Running it locally

### Prerequisites

- Node.js 22+. `pnpm` itself doesn't need a separate install — this repo
  pins `pnpm@10.33.0` via `packageManager`, so `corepack enable` (ships
  with Node 22) makes the `pnpm` command resolve to the pinned version.
- Docker Desktop, for Postgres and RabbitMQ.
- An Anthropic API key — not needed for `pnpm install`, migrations, or
  `pnpm test`/`pnpm lint`, but required before step 5
  (`demo-match.ts`); see that step for why it can't be skipped silently.

### 1. Enable pnpm and configure environment

```bash
corepack enable
[ -f .env ] || cp .env.example .env
```

That guard matters: a bare `cp .env.example .env` silently **overwrites**
an existing `.env`, and since `.env` is gitignored there is no undo. The
command above only copies the template when `.env` doesn't already exist.

Then edit `.env` and fill in `ANTHROPIC_API_KEY` if you want to run real
scoring. The Postgres/RabbitMQ credentials and the default employer lists
for each source adapter already have working values in `.env.example`.

### 2. Start Postgres and RabbitMQ

```bash
docker compose up -d
docker compose ps    # postgres and rabbitmq should both show healthy
```

Both containers publish to `127.0.0.1` only, not `0.0.0.0` — deliberate,
since `.env.example` ships with placeholder credentials. `docker compose
down` keeps their data in named volumes (including anything
dead-lettered, which matters on a project whose point is demonstrating
DLQs); `docker compose down -v` wipes it.

### 3. Install dependencies and run migrations

```bash
pnpm install
pnpm --filter @app/api db:migrate
```

### 4. Run the tests

```bash
pnpm test          # vitest run
pnpm lint           # eslint . && prettier --check .
```

`vitest.config.ts` aliases `@app/shared` to its TypeScript source, so tests
run against current source without a build step first. Six test files
connect to a real Postgres instance (`db/schema.test.ts`, `db/seed.test.ts`,
`db/migration-0004.test.ts`, `ingest/ingestJobs.test.ts`,
`demo-match.test.ts`, `worker/fetchSourceWorker.test.ts` — the last of
those also needs a real RabbitMQ connection), so step 2 has to have
happened first.

### 5. Run the end-to-end pipeline

`ANTHROPIC_API_KEY` must be set in `.env` before this step. The script
constructs its Anthropic client unconditionally and doesn't check for a
key up front, so without one it still runs the entire live fetch across
every configured source — SmartRecruiters alone can be 500+ HTTP
requests — and only then fails, on the first scoring call.

```bash
mkdir -p prep
[ -f prep/resume.txt ] || echo "paste your resume text here" > prep/resume.txt
# then edit prep/resume.txt to hold your actual resume text
npx tsx apps/api/src/demo-match.ts
```

The guard on that `echo` matters for the same reason as the `.env` one
above: `prep/` is gitignored, so overwriting `prep/resume.txt` by accident
has no undo.

It searches every source configured in `.env` (Greenhouse, Lever, Ashby,
SmartRecruiters — whichever have their env var set), filters to
software-engineering roles, scores each new posting against
`prep/resume.txt`, and persists jobs/resumes/scores to Postgres so a
second run doesn't re-score anything it already has.

### 6. Start the API and web dev servers

```bash
pnpm dev
```

That's the whole command — `pnpm dev` (root `package.json`: `pnpm --parallel
-r --if-present run dev`) starts `apps/api`'s Fastify server
(`http://localhost:3000`) and `apps/web`'s Vite dev server
(`http://localhost:5173`) together, in one terminal, each rebuilding on save.
No `.env`-loading cwd caveat: `apps/api/src/load-env.ts`'s `loadEnvFile()`
used to resolve `.env` relative to `process.cwd()`, which broke this exact
command (and `pnpm --filter @app/api dev`, and `cd apps/api && pnpm dev`)
with `error: role "dev" does not exist` — Postgres falling back to the OS
username once `POSTGRES_USER`/`PASSWORD`/`DB` silently never loaded. Fixed
(ticket `2fd6706`): it now resolves `.env` from the repo root via
`import.meta.url`, independent of the caller's working directory, so any of
those invocation forms loads the same `.env` correctly.

That fix is scoped to `.env` loading only — one separate, still-open
cwd-dependence remains. `POST /searches/estimate`'s pre-search cost figure
reads `prep/scoring-usage-stats.json` (also cwd-relative, unrelated
mechanism) to use real historical per-call averages instead of the
bootstrap estimate; started via `pnpm dev` (cwd `apps/api`), that read
misses and the estimate silently falls back to the less-accurate bootstrap
basis. Same underlying issue step 7 below warns about for the scoring
worker — not yet fixed for the route that reads it at estimate time.

Open `http://localhost:5173` and the app is live against whatever
Postgres/RabbitMQ instance step 2 started.

### 7. Run the queue workers

Both workers are long-lived processes, meant to be started manually
(each in its own terminal, in the same dev-container shell step 4's tests
and step 5's pipeline already run in) — there is no docker-compose service
for either (see [Architecture](#architecture) for why the queue exists,
and the worker source files themselves for the retry/DLQ/idempotency
design). `RABBITMQ_*`/`POSTGRES_*` must be set (step 1); the scoring
worker additionally needs `ANTHROPIC_API_KEY`, same as step 5.

```bash
npx tsx apps/api/src/worker/run-fetch-source-worker.ts   # consumes fetch.source
npx tsx apps/api/src/worker/run-score-job-worker.ts      # consumes score.job
```

Run from the repo root, like step 5's `demo-match.ts` above -- **not**
`pnpm --filter @app/api worker:*`, which runs with `apps/api` as the
working directory. The scoring worker's usage-stats file
(`USAGE_STATS_PATH`, `scoreJobWorker.ts`) is a cwd-relative `prep/...`
path, matching every other `prep/`-touching entry point in this repo
(`demo-match.ts`, `rescore-existing-matches.ts`) -- running it from
`apps/api/` instead silently writes to `apps/api/prep/...`, a second,
disconnected usage-stats file the spend guard's cost estimate never sees
(opus review, ticket b53c422, F1). The `package.json` `worker:*` scripts
still exist for the built `:start` form, but the same cwd rule applies to
THEM too: `pnpm --filter @app/api worker:score-job:start` runs with
`apps/api/` as cwd exactly like the dev form does and reintroduces the
identical bug (re-review note, ticket b53c422) -- only invoking
`node dist/worker/run-score-job-worker.js` directly, from the repo root,
is safe. Nothing in this repo deploys via `pnpm --filter ...:start` today,
but don't assume it would be safe if that changes.

The scoring worker enforces a lifetime-per-process spend ceiling
(`ScoringSpendGuard`, `apps/api/src/worker/scoreJobWorker.ts`, ticket
b53c422) — once tripped, restart the process to reset it. `POST /searches`
does publish to the queue (tickets `4f88339`, `45ea34c`, `c9c676d`): both
workers above pick up real work from a real search, not just from a
hand-crafted test message — see the next step.

### 8. Run a real, queue-driven search end to end

The exact flow: Postgres/RabbitMQ up, both workers running, API+web dev
servers running, then a search from either the UI or `curl`.

```bash
# Terminal 1
docker compose up -d
# Terminal 2 (repo root)
npx tsx apps/api/src/worker/run-fetch-source-worker.ts
# Terminal 3 (repo root)
npx tsx apps/api/src/worker/run-score-job-worker.ts
# Terminal 4 (repo root)
pnpm dev
```

**Web UI**: open `http://localhost:5173`, paste a resume, toggle on the
sources you want, and submit. The frontend polls the search until results
land, scored by the workers above as they come in.

**Or `curl` directly**, if you'd rather watch the API/worker logs than the
UI:

```bash
# 1. Create a resume, capture its id
curl -s -X POST http://localhost:3000/resumes \
  -H 'Content-Type: application/json' \
  -d '{"resumeText": "paste your resume text here"}'
# -> { "id": "<resumeId>", ... }

# 2. See which source ids are configured
curl -s http://localhost:3000/sources

# 3. Kick off a search — publishes one fetch.source message per sourceId
curl -s -X POST http://localhost:3000/searches \
  -H 'Content-Type: application/json' \
  -d '{"resumeId": "<resumeId>", "sourceIds": ["greenhouse", "lever"]}'
# -> 202, { "searchId": "<searchId>", "status": "pending", "skippedSources": [] }
# (no top-level "id" field -- it's "searchId")

# 4. Poll for results as the workers fetch, score, and persist
curl -s http://localhost:3000/searches/<searchId>
```

Watch the two worker terminals: the fetch-source worker logs each source it
queries and how many jobs it normalized, then the score-job worker logs
each one it scores against the resume via a real Anthropic call. This is
the same flow this session's own live smoke tests ran for hours against a
real Postgres, a real hand-built RabbitMQ broker, and real Claude calls.

### Verified

```
$ pnpm lint
> job-search-app@0.0.0 lint
> eslint . && prettier --check .

Checking formatting...
All matched files use Prettier code style!

$ pnpm test
> job-search-app@0.0.0 test
> vitest run

 RUN  v4.1.10

 Test Files  20 passed (20)
      Tests  297 passed (297)
   Duration  7.31s (transform 1.99s, setup 0ms, import 7.64s, tests 7.44s, environment 1ms)
```

## Project layout

```
apps/
  api/     Fastify backend — source adapters, RabbitMQ worker, Drizzle schema/migrations
  web/     React + Vite frontend (placeholder scaffold, not the real app)
packages/
  shared/  Domain types (Job, Resume, JobMatch, Search, SourceDescriptor) used by both apps
```

Deliberately **not** Next.js: a separate frontend and backend force a real
REST contract boundary between them rather than hiding it behind a
framework.

See `CLAUDE.md` for the development process this project runs on — every
change lives on its own branch, goes through the adversarial review
described above, and is merged only once that review and the test suite
both pass.
