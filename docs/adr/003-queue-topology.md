# ADR 003: RabbitMQ Topology — Retry, DLQ, and Idempotency

**Status**: Accepted (retroactively documented — see Notes)
**Ticket**: git-bug 568cc5f

## Context

The JD this project targets names message-driven workflows, retries, DLQs,
and idempotency explicitly, and the topology exists to make those real
architecture rather than a demo. Ticket 568cc5f asked for the exchange/
queue/binding declarations, per-queue dead-letter config, backoff retry,
and a written explanation of the design — everything except the workers
that actually consume the queues (568cc5f's own Scope: "Out: the workers
themselves").

The design itself was built and tested in isolation early in the
project's life; this document was written later, once a full backlog
audit found the actual END-TO-END wiring — workers running as real
processes, `POST /searches` publishing instead of scoring synchronously —
was a separate, much larger piece of work (epic `aa75e82`, closed
2026-09-22). This ADR describes the topology as it exists now that both
halves are done and connected.

## Why a queue at all

A search fans out to several job sources that are unequal and unreliable —
some rate-limit, some time out, one being down should never take the
others with it. That is exactly what a queue is for, not decoration:

1. `POST /searches` records the search, publishes one `fetch.source`
   message per selected source.
2. **Source workers** (`fetchSourceWorker.ts`) fetch from that source,
   normalize the response into `Job` records, publish one `score.job`
   message per posting linked to the search so far (capped per source —
   see the Idempotency and Consequences sections below).
3. **Scoring workers** (`scoreJobWorker.ts`) send the resume and job
   description to Claude, persist the match score.
4. The frontend polls `GET /searches/:id`, whose completion state is
   derived from Postgres alone (design `c54b9e0`, ticket `4f88339`) —
   correct across a worker crash, a message redelivery, or an API process
   restart.

## Topology

One direct exchange (`jobs`) that every producer publishes to, one
dead-letter exchange (`jobs.dlx`) that every permanently-failed message
lands on, and two independent work-queue/DLQ/retry-ladder trios bound to
it — declared idempotently on every `setupTopology()` call
(`apps/api/src/queue/topology.ts`), via `assertExchange`/`assertQueue`,
which is itself an idempotent operation in RabbitMQ.

```
jobs (direct exchange) — every producer publishes here
 │
 ├─ routing key "fetch.source" ──► fetch.source (work queue)
 │                                    │
 │                    permanent failure, or an unroutable
 │                    retry-tier publish (see "Retry", below)
 │                                    ▼
 │                              jobs.dlx (direct exchange — ONE, shared)
 │                                    │  routing key "fetch.source"
 │                                    ▼
 │                              fetch.source.dlq
 │
 └─ routing key "score.job" ──────► score.job (work queue)
                                        │
                        permanent failure, or an unroutable
                        retry-tier publish (see "Retry", below)
                                        ▼
                                  jobs.dlx (the SAME exchange as above)
                                        │  routing key "score.job"
                                        ▼
                                  score.job.dlq
```

Each work queue's `deadLetterExchange`/`deadLetterRoutingKey` points back
at `jobs.dlx` under its own routing key, which is in turn bound to that
queue's own `.dlq`. RabbitMQ's own queue-level TTL expiry is never what
sends a message to a DLQ in this design — TTL expiry is what returns a
message from a _retry tier_ back to the real work queue (see "Retry",
below). A message reaches its DLQ one of three ways:

1. An explicit `nack(msg, false, false)` once `maxAttempts` retries are
   exhausted.
2. A non-retryable classification deciding immediately that retrying is
   pointless (a malformed message body, an unknown source id, a deleted
   resume) — same `nack`, on the first attempt.
3. **A retry publish that comes back unroutable** — the tier queue it
   was addressed to doesn't exist (deleted, renamed, a topology drift
   between what the worker expects and what's actually declared).
   Both work queues publish retries with `mandatory: true`; an
   unroutable publish fires RabbitMQ's `return` event, and both
   workers' `return` handlers (`FETCH_SOURCE_DLQ`/`SCORE_JOB_DLQ`,
   `fetchSourceWorker.ts`/`scoreJobWorker.ts`) republish that bounced
   message straight into the DLQ rather than losing it silently —
   `topology.ts`'s own doc comment on `FETCH_SOURCE_DLQ` names this
   case explicitly ("permanently-failed (or unroutable-retry)").

## Retry: per-tier queues, not per-message TTL

Both retry ladders (`FETCH_SOURCE_RETRY_TIERS`, `SCORE_JOB_RETRY_TIERS`)
are implemented as one durable queue per delay, each with a queue-level
`x-message-ttl`, rather than one shared retry queue with a per-message
`expiration`. This is the one non-obvious design decision in the whole
topology, and it exists for a concrete, previously-learned reason: RabbitMQ
(classic queues) only evaluates TTL expiry at the _head_ of a queue. If
one shared queue held messages carrying different per-message TTLs, a
message with a long TTL sitting at the head would block every
shorter-TTL message queued behind it from expiring — "back off and retry
gradually" would turn into "wait for the slowest message, then release
everything as a thundering herd against a source that was already
struggling." An earlier version of the topology used exactly the
shared-queue/per-message-TTL shape and a comment confidently described it
as working; it was reproduced not to work. A uniform _queue-level_ TTL
sidesteps this: every message in a given tier shares the same TTL, so
head-of-queue expiry order matches publish order, and nothing blocks
anything else.

None of the retry-tier queues are bound to the `jobs` exchange — they are
never delivered by a normal `consume`, only ever reached by the worker
explicitly publishing into one, and left only via TTL expiry
dead-lettering back to the real work queue (`fetch.source` or
`score.job`) for another delivery attempt. The worker tracks the attempt
number itself, via an `x-attempt` message header (RabbitMQ has no
built-in counter), and picks a tier via `pickRetryTier` — by attempt
number by default, or by a real `Retry-After` value when the failure
carries one (a source's 429, or an Anthropic `RateLimitError`) — giving
up (`nack(msg, false, false)` straight to the DLQ) once `maxAttempts` is
reached.

**The two ladders use different delays, deliberately, not by oversight:**

|           | `fetch.source`                                                                                                                      | `score.job`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tiers     | 1s / 2s / 4s / 8s / 60s                                                                                                             | 5s / 15s / 45s / 120s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Reasoning | `JobSource#search` either succeeds or throws on the first real attempt — no inner retry layer — so a 1s first backoff is reasonable | The Anthropic SDK already retries internally (default `maxRetries: 2`, covering 408/409/429/5xx) before ever rejecting into this worker's own retry logic. A failure this worker's `classifyScoringError` sees has already survived that inner budget — a 1s requeue would, in the common case, just re-hit the same still-active condition a few seconds sooner. The ladder starts at 5s to reflect that there is no version of "the SDK just failed twice in the last few seconds" that a 1s wait plausibly resolves. |

The `score.job` ladder is a **reasoned, not measured**, starting point —
this project has made no live Claude calls against real production
traffic as of this writing (the scoring worker was built and wired to
run, ticket `4065511`/`b53c422`, but `POST /searches` publishing to it in
practice, ticket `4f88339`, is new). Revisit both ladders once there is a
real corpus of observed `Retry-After` values and sustained-failure
durations to size against.

Both ladders' top tier (60s / 120s) exists for the same reason: so a real
`Retry-After` header (from a source's 429, or Anthropic's) has somewhere
to land other than clamping down to the ladder's normal maximum and
burning an attempt on a near-certain repeat failure. Plain
attempt-number escalation under the default `maxAttempts` (4, both
workers) never reaches the top tier on its own — only an explicit
`Retry-After` value routes there.

## DLQ: a message dead-letters, the rest of the system keeps going

Reaching a DLQ is product behavior, not a demo artifact. For
`fetch.source`: one source repeatedly failing (down, misconfigured,
rate-limited past its retry budget) dead-letters that source's message,
and — because `POST /searches` fans out one independent message per
source — every other selected source's message is entirely unaffected;
the search still returns results from whichever sources succeeded. This
is the literal shape of "the UI shows that source as unavailable, and the
other sources still return," now reachable end to end since ticket
`4f88339` gave dead-lettered sources a durable, per-source record
(`search_sources.status = 'failed'`) instead of only a transient message
sitting in a queue.

For `score.job`: a permanently-failed scoring attempt (an exhausted
retry budget, a resume that no longer exists, a spend-guard refusal that
never got a chance to succeed before the guard tripped) dead-letters
that one job/resume pair without blocking any other job in the same
search from being scored — and, since the same ticket, is durably
recorded (`job_match_failures`, one row per permanently-unscoreable
`(searchId, resumeId, jobId)` triple — per `(resumeId, jobId)` pair
until ticket `9a53485` re-scoped it, see below) so the search can still
resolve as "complete,
with some failures noted" instead of waiting on a message that will
never resolve. The DLQ keeps the _message_ (inspectable, replayable);
Postgres keeps the _fact_.

**A test proves a repeatedly-failing message actually reaches the DLQ and
does not spin forever**, for both queues, though the two tests prove it
differently. `scoreJobWorker.test.ts`'s "retries exhausted,
dead-letters" test drives a handler through its full `maxAttempts`
budget against a consistently-failing mock and asserts the terminal
`nack(msg, false, false)` with no further retry publish.
`fetchSourceWorker.test.ts`'s equivalent runs against a real, live
broker (not a mock) and asserts the DLQ's actual message depth reaches 1
after exactly `maxAttempts` calls, then re-asserts after a quiet period
that the work queue and every retry tier are empty — a stronger, more
direct proof for that worker.

## Idempotency

At-least-once delivery is the default assumption throughout — a worker
can die mid-message, and RabbitMQ redelivers. Nothing in this topology
relies on a message being delivered exactly once; every write a worker
makes on redelivery is either a natural-key upsert or explicitly checked
before it happens:

- **`jobs`**: unique on `(dataSource, externalId)` — the same posting
  arriving from a redelivered `fetch.source` message (or, in principle,
  from two different sources reporting the same underlying listing)
  upserts rather than duplicates.
- **`search_results`**: unique on `(searchId, jobId)` — a redelivered
  fetch republishes `score.job` for every job linked to the search so
  far (not just the ones that specific call newly inserted — see
  `fetchSourceWorker.ts`'s own doc comment on `linkedJobIds` vs.
  `newlyInsertedJobIds` for why that's deliberate), but the link itself
  can't duplicate.
- **`job_matches`**: unique on `(resumeId, jobId)`. `scoreJobWorker.ts`
  checks for an existing row _before_ ever calling Claude — not relying
  on the unique constraint alone — specifically so a redelivered message
  never re-spends a real, billed API call on a pair it already scored;
  the constraint (`onConflictDoNothing`) is defense-in-depth for the
  race between that check and the write, not the primary mechanism.
- **`search_sources`** (a bare join table since early in the project;
  extended by ticket `4f88339` with a `status`/`linkedJobCount`/
  `errorKind` ledger and its `(searchId, sourceDescriptorId)` unique key
  for durable completion tracking) is written with `SET`, never
  incremented — a redelivered message writes the same, or a superset,
  `linkedJobCount`, so at-least-once delivery cannot inflate it.
- **`job_match_failures`** (new in ticket `4f88339`, same reason),
  unique on `(searchId, resumeId, jobId)`, is written via
  `insert(...).onConflictDoNothing(...)` rather than a `SET` — the same
  no-counter property (a redelivered message tries to insert the
  identical row and no-ops), just expressed as an idempotent insert
  instead of an idempotent update, since a failure record either exists
  or doesn't rather than accumulating a value.

  Both were a deliberate rejection of a counter-based design during
  ticket `4f88339`'s own design phase (`c54b9e0`): a counter cannot be
  made idempotent under redelivery without becoming, in effect, the same
  natural-keyed ledger this topology already uses everywhere else.

## Consequences

- Two independent queue/DLQ/retry-ladder trios sharing one exchange
  pair, not a single generic "jobs" queue with type-switching — keeps a
  `fetch.source` retry storm from ever affecting `score.job` throughput
  or vice versa.
- The per-tier-queue retry mechanism costs N extra durable queues per
  ladder (5 for `fetch.source`, 4 for `score.job`) in exchange for
  correct backoff ordering under RabbitMQ's head-of-queue-only TTL
  semantics — a small, fixed cost, paid once at topology setup.
- Every worker write this topology's idempotency guarantees depend on is
  a natural-key upsert or an explicit pre-check, never a counter — this
  is what makes "redeliver this message five times" and "deliver it
  once" produce identical durable state, verified directly in both
  workers' test suites and in `ticket 4f88339`'s completion-detection
  design.
- The gap this bullet used to describe — the queue path having no
  equivalent of the synchronous CLI path's quality filter or a true
  per-search scoring cap — is closed. Both landed the day after this ADR
  was first written: ticket `45ea34c` wired the quality filter into
  `fetchSourceWorker`, and ticket `c9c676d` made the scoring cap
  genuinely per-search (see `DEFAULT_SCORE_THRESHOLD`, `matching/
scoring.ts`) with capped-vs-failed jobs reported honestly rather than
  conflated. Neither changed this document's own retry/DLQ/idempotency
  design.

## Notes

This ADR was written 2026-09-22, after the RabbitMQ epic (`aa75e82`)
that connected the already-built topology and workers to the live app
end to end. The two halves of the topology weren't built on the same
timeline: the `fetch.source` side (ticket `568cc5f`'s own code) dates to
2026-08-11–15, well before the epic; the `score.job` retry tiers landed
2026-09-21, mere hours before the epic that connected everything was
opened the same day. Either way, this document — the ticket's one
remaining unmet acceptance criterion — was deferred until the full
design was actually exercised against real request flow, not just
fixtures, so it could describe the topology
as it actually behaves rather than as originally speculated.
