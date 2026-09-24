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

The real path today runs end to end through the queue-driven architecture
diagrammed below: the React frontend calls the Fastify REST API, which
publishes to RabbitMQ, and two long-lived worker processes fetch/normalize/
filter postings and score them against a resume via Claude.
`apps/api/src/demo-match.ts` is a separate, CLI-only entry point into the
same underlying pipeline (`apps/api/src/matching/pipeline.ts`) — useful for
running a search from a terminal without starting the queue workers, not
the only way to run this any more. See [Current state](#current-state) for
exactly what's real.

- Eight job-board sources (USAJOBS, Greenhouse, Lever, Ashby,
  SmartRecruiters, Workable, Recruitee, Rippling), covering a U.S.
  federal-jobs API and several dozen configured ATS employers, selectable
  per search via source toggles.
- Postings are normalized into one `Job` shape, filtered down to
  software-engineering roles matching a caller's criteria, deduplicated, and
  scored against a resume by Claude — each score comes back as a 0-100
  number plus a rationale, strengths, gaps, and a separate leveling-fit
  judgment, not free text.
- Jobs, resumes, and match scores are persisted, so re-running a search
  never re-pays for a score it already has; a user's saved/applied/
  dismissed status on a job is tracked too.

## Current state

Built, tested, and what `POST /searches` actually runs in production today:

- Eight source adapters (USAJOBS, Greenhouse, Lever, Ashby,
  SmartRecruiters, Workable, Recruitee, Rippling) behind one `JobSource`
  interface, each with its own idiosyncrasies handled — see
  [Source adapters](#source-adapters).
- A Postgres schema (Drizzle) with idempotent upserts on jobs, resumes,
  match scores, and per-search scoring-failure records.
- A RabbitMQ topology with per-queue dead-letter exchanges and a
  tiered-backoff retry path (see
  [Retries, dead letters, and idempotency](#retries-dead-letters-and-idempotency)),
  plus `fetch.source` and `score.job` workers that consume it as real,
  long-lived processes (`apps/api/src/worker/`) — not just designed, both
  running end to end against real search traffic.
- A full REST API (`apps/api/src/routes/`) — resumes, sources, starting and
  polling a search, per-job status, and the resume-tailoring-app handoff —
  see [Running it locally](#running-it-locally) for the exact routes this
  README exercises.
- A React frontend (`apps/web`) — source toggles, resume input with
  AI-suggested title chips, a search-criteria form, a polling results view,
  per-job status controls, and the "Optimize Resume" handoff.
- The shortlist-truncation bug this section used to describe as open (a
  fixed `slice(0, 12)` silently dropping most of the ranked list once the
  candidate pool grew) is fixed: every survivor is a scoring candidate, a
  shared per-search cap (`DEFAULT_SCORE_THRESHOLD = 200`) bounds spend
  instead of coverage, and when it binds it's reported, never silent — see
  [What "adversarial review" actually catches](#what-adversarial-review-actually-catches).

Known limitation:

- **One seeded source, Washington state's own job board (`wa-state`), has
  no adapter yet** (the ninth seeded id, alongside the eight real
  adapters above). It shows up everywhere as "no adapter implemented"
  rather than a misconfiguration — see `apps/api/src/sources/registry.ts`.

## Architecture

```mermaid
flowchart LR
    UI["React frontend"] -->|"POST /searches"| API["Fastify API"]
    API -->|"1 fetch.source msg\nper selected source"| FQ["fetch.source queue"]
    FQ --> FW["fetch.source worker"]
    FW -->|filter + normalize + upsert| DB[(Postgres)]
    FW -->|"1 score.job msg\nper newly-linked job\n(budget permitting)"| SQ["score.job queue"]
    SQ --> SW["score.job worker"]
    SW -->|resume + description| Claude["Claude\n(match score)"]
    Claude --> SW
    SW --> DB
    UI -.->|poll / render ranked list| API
```

Two work queues, `fetch.source` and `score.job`, each with its own
dead-letter exchange. A search publishes one `fetch.source` message per
selected job source; each source that successfully ingests a job (subject
to the search's criteria filter and a shared per-search scoring cap)
publishes one `score.job` message for it. Both sides of this — topology,
workers, retry, DLQ — are built and run as real, long-lived processes; this
is the actual path `POST /searches` uses today, not a design still being
wired in. `apps/api/src/demo-match.ts` runs the same underlying pipeline
synchronously instead, for local iteration without the queue workers
running.

### Why a queue, not a direct fan-out

A search can hit up to eight independent job-board APIs that are unequal and
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
(`search(criteria) -> { jobs, skipped }`) but the seven ATS APIs in this
table disagree about almost everything else. USAJOBS is an eighth adapter
behind the same interface — its access method, auth, and terms are covered
in [ADR 001](docs/adr/001-job-sources.md) instead of here, since it's a
government API with different characteristics than an ATS vendor's, not
the same shape of "awkward."

| Source              | What makes it awkward                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Greenhouse**      | No server-side location/keyword query support — every search downloads a whole board and filters client-side. No public directory maps a company name to its board token, so candidates have to be checked individually (`check-greenhouse-board.ts`) before being added; of 25 hand-guessed tokens in this project's own history, 7 (28%) weren't on Greenhouse at all, and 13 more (about half) resolved to real, sizeable boards that still contributed zero postings after filtering. |
| **Lever**           | Posting content is split across a plain-text summary field and a separate `lists` field that actually holds the requirements — reading only the summary field discards the majority of a posting's real content. Location is similarly split between one canonical field and an `allLocations` array that doesn't always agree with it; reading only one silently drops real matches, and it took three review rounds to land on reading the union of both correctly.                     |
| **Ashby**           | Location data is spread across a primary field, a `secondaryLocations` array, and a structured `address.postalAddress` block that's absent from the API response unless you read it — missing any one of the three silently zeroes out entire cities' worth of results. Compensation data only exists at all behind an undocumented query parameter.                                                                                                                                      |
| **SmartRecruiters** | Returns HTTP `200` with `totalFound: 0` for both a real employer with no current openings and a completely nonexistent company identifier — byte-identical responses. Distinguishing the two required an independent liveness check against the company's own careers-site redirect behavior. Descriptions live behind a separate per-posting detail endpoint, so a large employer can cost thousands of extra HTTP requests for one search.                                              |
| **Workable**        | The documented Accounts API endpoint 302-redirects to a widget host before it's usable at all — an invalid subdomain and a real one both look identical until that redirect is followed, at which point a real account resolves `200` (`jobs: []` for a genuinely quiet employer) and an unrecognized one resolves a clean, distinct `404`. No compensation field exists anywhere in the API.                                                                                             |
| **Recruitee**       | No pagination on the offers endpoint at all — a whole company's board comes back as one request, unlike SmartRecruiters' paginated list. `remote`/`hybrid`/`on_site` booleans, assumed mutually exclusive, aren't in real data — two real bunq postings assert both `hybrid` and `on_site` simultaneously, so the adapter requires exactly one true and maps zero-or-multiple to `undefined` rather than guessing a winner.                                                               |
| **Rippling**        | The list endpoint carries no description, company name, employment type, or pay data at all — every posting requires a mandatory per-posting detail fetch, same as SmartRecruiters. Worse, a job posted to multiple locations appears once PER LOCATION as separate rows sharing an identical `uuid`; failing to dedupe by `uuid` would insert the same posting into `jobs` multiple times under the same `(source, external_id)` key.                                                    |

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
  rather than the best twelve — filed as a bug rather than silently shipped
  (`cc793ee`, ticket `16c824a`), and since fixed: every survivor is now a
  scoring candidate, bounded by a reported per-search cap instead of a
  silent truncation (see [Current state](#current-state)).

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
  `pnpm test`/`pnpm lint`, but required before step 5 (`demo-match.ts`; see
  that step for why it can't be skipped silently), and again once `pnpm
dev`'s scoring worker (step 6) actually scores something — real
  (non-`estimateOnly`) `POST /searches` calls in step 8 are what triggers
  that.

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
run against current source without a build step first. 16 test files
connect to a real Postgres instance — every `db/migration-*.test.ts` except
`migration-0006.test.ts` (deliberately connection-free, see its own header),
plus `db/schema.test.ts`, `db/seed.test.ts`, `db/user-job-statuses.test.ts`,
`demo-match.test.ts`, `ingest/ingestJobs.test.ts`, every `routes/*.test.ts`
except `sources.test.ts` (uses a fake db), `scripts/rescore-existing-matches.test.ts`,
and both `worker/*.test.ts` files — with `worker/fetchSourceWorker.test.ts` and
`worker/scoreJobWorker.test.ts` also needing a real RabbitMQ connection —
so step 2 has to have happened first. (Stale here before this audit: this
paragraph still described the pre-epic file count — REST routes,
`scoreJobWorker`, and most of the migration tests were added by the same
work this whole README was rewritten to reflect, ticket 7472002.)

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

### 6. Start everything — API, web, and both queue workers

```bash
pnpm dev
```

**This one command is now the whole dev-startup story** (ticket `47407f7`).
Root `package.json`'s `dev` script no longer just fans out to each
workspace package's own `dev` script (the old `pnpm --parallel -r
--if-present run dev`, which silently covered only `apps/api` and
`apps/web` — neither queue worker has a package-level `dev` script, so it
never started them). It now runs all four dev-time processes through
[`concurrently`](https://github.com/open-cli-tools/concurrently), each with
its own colored, labeled output prefix so a crash or a stray log line is
attributable at a glance:

```
[api]           apps/api's Fastify server (predev runs drizzle-kit migrate first)
[web]           apps/web's Vite dev server
[fetch-worker]  npx tsx apps/api/src/worker/run-fetch-source-worker.ts
[score-worker]  npx tsx apps/api/src/worker/run-score-job-worker.ts
```

This closes a real gap Nicole hit live: a search that only had `pnpm dev`
running (not the workers) sat at "pending" on every source for 6+ minutes,
with no error anywhere pointing at the cause — the fetch-source and
score-job queues just had nobody consuming them. `pnpm dev` starting all
four processes from one command in one terminal means that specific
failure mode can't happen again from a missed manual step.

Only the two `npx tsx` worker invocations run with the repo root as their
working directory (`concurrently`'s default `cwd`, since neither is wrapped
in a `pnpm --filter` call); `api` and `web` each run from their own package
directory, because `pnpm --filter @app/<x> run dev` changes into that
package before running its script. That distinction matters for two
cwd-relative reads that predate this ticket and are unchanged by it:

- `apps/api/src/load-env.ts`'s `loadEnvFile()` resolves `.env` from the repo
  root via `import.meta.url` regardless of caller cwd (ticket `2fd6706`), so
  this isn't actually cwd-sensitive any more — noted here only because the
  next point is.
- The scoring worker's usage-stats read (`USAGE_STATS_PATH`,
  `scoreJobWorker.ts:209` — a bare `"prep/scoring-usage-stats.json"`
  string) is **genuinely, still, cwd-relative** — a separate constant from,
  and NOT fixed by, ticket `2b93534` (that ticket fixed only
  `POST /searches/estimate`'s OWN read, `pipeline.ts`'s
  `DEFAULT_USAGE_STATS_PATH`, to an absolute `import.meta.url`-derived
  path — already cwd-independent regardless of this ticket). Because
  `pnpm dev` now runs the scoring worker from the repo root (not
  `apps/api/`), its bare relative path happens to resolve to the same real
  file the estimate route already reads absolutely — so the two now agree
  in practice, but only the estimate route's own read is actually fixed;
  the worker's remains a real, unfixed cwd-relative constant that would
  break again under a different invocation cwd (e.g. the worker's old
  `pnpm --filter @app/api worker:score-job` form). That form isn't
  documented below any more for exactly this reason.

Open `http://localhost:5173` and the app is live against whatever
Postgres/RabbitMQ instance step 2 started.

**Postgres/RabbitMQ must already be up before you run `pnpm dev`** — step 2
(`docker compose up -d`), confirmed with `docker compose ps` showing both
`healthy`. `pnpm dev` does not wait for them and cannot detect "still
starting" versus "not started." Verified live (ticket `47407f7`) what
actually happens if you jump the gun:

- **Both workers crash immediately and loudly**, not silently and not by
  hanging — `run-fetch-source-worker.ts`/`run-score-job-worker.ts` fail
  their initial RabbitMQ connection with a plain `Error: connect ECONNREFUSED
127.0.0.1:5672` and exit with code 1. `concurrently` prints this under the
  `[fetch-worker]`/`[score-worker]` prefix and moves on — it does not kill
  the other three processes, so `web` and (once Postgres answers) `api` keep
  running with two workers down.
- **`apps/api`'s `predev` (`drizzle-kit migrate`) fails FAST and SILENTLY**
  if nothing is listening on Postgres's port yet (the actual case you hit
  by starting `pnpm dev` before `docker compose up -d` has finished) --
  measured: it exits in about 1 second, with exit code 1 and **no error
  text printed at all**. `concurrently` shows this as
  `[api] pnpm --filter @app/api run dev exited with code 1` and nothing
  else -- there is no visible cause to point at. (An earlier version of
  this note claimed `drizzle-kit` hangs and self-heals here -- that is
  only true for a different, rarer failure shape, a host that accepts the
  TCP connection but never responds at all; it is not what "Postgres isn't
  up yet" actually looks like on a normal `docker compose` localhost bind,
  which just refuses the connection outright and exits immediately. See
  ticket `47407f7`'s review for the measurements behind this correction.)
- **`web` is unaffected** either way — Vite's dev server doesn't touch
  Postgres or RabbitMQ at all, so it comes up normally even when both
  workers are dead and `api` never started.

Net effect of starting too early: the browser loads, but `[api]` printed a
bare "exited with code 1" with no cause shown, and/or `[fetch-worker]`/
`[score-worker]` printed a real `ECONNREFUSED` and exited too — so searches
never move off "pending" because nothing is listening on either end. If you
see any of the four labeled processes report an early exit, that is the
signal, not a hang. Either way, the fix is the same: Ctrl-C the whole thing,
confirm `docker compose ps` shows both containers `healthy`, and run
`pnpm dev` again — restarting is cheap and there's no partial-startup state
to clean up first.

**Shutdown**: Ctrl-C (SIGINT) on the `pnpm dev` terminal stops all four
processes — `concurrently` forwards the signal to every child, and none of
them lingers as an orphan. Verified live by inspecting the full process
tree before and after a SIGINT: zero descendants remained afterward and
ports 3000/5173 were both free.

**Running `pnpm dev` a second time while one is already up** (e.g. a second
terminal, or forgetting the first is still running) does not fail the same
way on all four processes — not independently measured live, but expected
from how each one binds:

- **`web`** now fails loudly and immediately: `--strictPort` (added by this
  ticket) makes the second Vite refuse to silently fall back to 5174 — it
  exits with a port-in-use error you'll see in the `[web]` pane.
- **`api`** runs under `tsx watch`, which wraps the actual Fastify process.
  If the inner server can't bind port 3000 because the first `api` already
  holds it, that failure happens inside the wrapped process — `tsx watch`
  itself doesn't necessarily exit, so `concurrently`'s `[api]` pane may not
  show a labeled "exited with code N" line the way a real crash does. The
  only visible sign can be an address-in-use error buried in the log output.
- **The two workers bind no port at all**, so a second copy of either starts
  up cleanly and just becomes a second consumer competing for the same
  RabbitMQ queue — no crash, no error, just messages silently split between
  two processes instead of one.

If searches behave strangely with no process reporting an exit, check for a
second `pnpm dev` before assuming something else is wrong.

### 7. Restarting just one process

`pnpm dev`'s single command is the primary path, but killing all four just
to restart one (e.g. iterating on the scoring worker without bouncing the
API/web servers too) is real friction. The old manual, one-process-per-
terminal approach from before this ticket still works for that case: stop
`pnpm dev` first (two consumers on the same queue just compete for
messages, they don't cooperate), then run whichever single process you need
standalone from the repo root:

```bash
pnpm --filter @app/api run dev                           # apps/api only
pnpm --filter @app/web run dev                            # apps/web only
npx tsx apps/api/src/worker/run-fetch-source-worker.ts    # fetch.source worker only
npx tsx apps/api/src/worker/run-score-job-worker.ts       # score.job worker only
```

The scoring worker enforces a lifetime-per-process spend ceiling
(`ScoringSpendGuard`, `apps/api/src/worker/scoreJobWorker.ts`, ticket
b53c422) — once tripped, restart the process (or all of `pnpm dev`) to
reset it.

### 8. Run a real, queue-driven search end to end

The exact flow: Postgres/RabbitMQ up and healthy, then one command.

```bash
# Terminal 1
docker compose up -d
docker compose ps    # wait for both healthy
# Terminal 2 (repo root)
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

Watch the `[fetch-worker]`/`[score-worker]`-prefixed lines in the same
`pnpm dev` terminal: the fetch-source worker logs each source it queries and
how many jobs passed the search's quality filter, then the score-job worker
logs each one it scores against the resume via a real Anthropic call, plus a
non-fatal warning if it can't find a `prep/` directory to record usage stats
in (harmless — the score itself is already persisted; see the cwd note
above). Re-verified live for ticket `47407f7` itself, against a real
Postgres and a real hand-built RabbitMQ broker in the environment this
ticket was finished in (no Docker CLI there, so no `docker compose`, but
the broker and database it would have started were both already up):
`POST /searches` with `sourceIds: ["lever"]` published one `fetch.source`
message, `[fetch-worker]` picked it up, queried Lever's real API, and
linked 15 of 401 postings; `[score-worker]` consumed the resulting 15
`score.job` messages one at a time (`prefetch(1)`) and produced 15 real
match scores via the Anthropic API; and `GET /searches/<searchId>` moved
from `pending` to `complete` with `scored: 15` — all without starting
anything by hand beyond `pnpm dev` and the two `curl` calls above. (Torn
down afterward by killing the process tree directly rather than a
terminal Ctrl-C, so this run doesn't re-confirm the SIGINT behavior the
Shutdown section describes separately — only that the queue-driven path
itself still works end to end under `pnpm dev`.) This is the same flow
this session's own earlier live smoke tests ran for hours before this
ticket folded both workers into `pnpm dev`; this run confirms the fold
didn't change that.

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

 Test Files  62 passed (62)
      Tests  1176 passed (1176)
   Duration  41.93s (transform 3.07s, setup 0ms, import 39.49s, tests 87.04s, environment 61.69s)
```

Captured with a real RabbitMQ broker and Postgres both reachable (`.env`
populated, both services up) — the documented, expected clean state
following steps 1-2. Without a broker (`RABBITMQ_DEFAULT_USER`/`_PASS`/
`_HOST`/`_PORT` unset, or nothing listening), exactly one file fails —
`worker/fetchSourceWorker.test.ts` — and its 19 tests show as "skipped"
because its top-level `beforeAll` throws before any of them run; every
other file, including every other queue/worker/route test, is unaffected.

## Project layout

```
apps/
  api/     Fastify backend — REST routes, source adapters, RabbitMQ workers, Drizzle schema/migrations
  web/     React + Vite frontend — resume input, source toggles, and the polling results view
packages/
  shared/  Domain types and the full REST wire contract (Job, Resume, SearchStatusResponse, ...) used by both apps
```

Deliberately **not** Next.js: a separate frontend and backend force a real
REST contract boundary between them rather than hiding it behind a
framework.

See `CLAUDE.md` for the development process this project runs on — every
change lives on its own branch, goes through the adversarial review
described above, and is merged only once that review and the test suite
both pass.
