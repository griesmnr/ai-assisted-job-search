# ADR 001: Job Source Policy

**Status**: Accepted (retroactively documented — see Notes)
**Ticket**: git-bug 4cbfe25

## Context

The product depends entirely on which job sources it can legally and
technically query. Ticket 4cbfe25 asked for a written decision before any
implementation: per candidate source, access method, auth requirement, rate
limits, terms status — and a defensible position on LinkedIn/Indeed.

The ticket anticipated a milestone-1 scope of USAJOBS + Washington state.
That is not what got built. Five sources are live today, arrived at through
implementation rather than up-front research, and this ADR is the deferred
paper trail for that decision.

## Sources in use

| Source              | Access method                                                                   | Auth                                                                    | Rate limiting                                                                                                  | Terms                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **USAJOBS**         | REST API, `data.usajobs.gov/api/search`                                         | `USAJOBS_API_KEY` + `User-Agent`, sent as an `Authorization-Key` header | Real, enforced: a 429 with `Retry-After` is a documented, handled response (`apps/api/src/sources/usajobs.ts`) | Public federal jobs API, published for exactly this use                                                           |
| **Greenhouse**      | Public Job Board API, `boards-api.greenhouse.io/v1/boards/{token}/jobs`         | None — public, per-company board token                                  | Not documented by Greenhouse; adapter treats a 429 the same as USAJOBS's                                       | [Public API docs](https://developers.greenhouse.io/job-board.html), explicitly published for external consumption |
| **Lever**           | Public Postings API, `api.lever.co/v0/postings/{company}`                       | None — public, per-company slug                                         | Not documented                                                                                                 | [Public API](https://github.com/lever/postings-api), explicitly published                                         |
| **Ashby**           | Public Job Board API, `api.ashbyhq.com/posting-api/job-board/{boardName}`       | None — public, per-company board name                                   | Not documented                                                                                                 | [Public API docs](https://developers.ashbyhq.com/docs/public-job-posting-api)                                     |
| **SmartRecruiters** | Public Posting API, `api.smartrecruiters.com/v1/companies/{companyId}/postings` | None — public, per-company id                                           | Not documented                                                                                                 | [Public API docs](https://developers.smartrecruiters.com/docs/job-postings)                                       |

Four of the five (Greenhouse, Lever, Ashby, SmartRecruiters) are ATS vendors
whose customers' public postings are exposed through a documented, unauthenticated,
company-scoped API — meant to be read by exactly this kind of tool. USAJOBS is
a real government API requiring registration for a key, also explicitly meant
for external consumption. Every response in every adapter (`apps/api/src/sources/`)
was written against real, captured API responses, not assumed shapes.

## LinkedIn / Indeed

**Not used, and not planned.** Neither offers a general job-search API for
this use case; both prohibit scraping in their terms of service. That
position hasn't changed since the ticket was opened — it's the reason this
project reaches for ATS vendor APIs and a government API instead, all of
which are built for exactly this kind of external read.

## Consequences

- Milestone-1 scope grew from "USAJOBS + Washington state" to five real
  sources covering both a federal-jobs API and four ATS ecosystems (startup/
  mid-market via Greenhouse/Lever/Ashby, large-enterprise skew via
  SmartRecruiters).
- No source in use requires anything beyond a free API key (USAJOBS) or a
  public, unauthenticated endpoint (the four ATS vendors) — there is no
  source in this list whose legality or terms status is ambiguous.
- Adding a sixth source is a new `JobSource` adapter (`apps/api/src/sources/`)
  plus a row in `SOURCE_DESCRIPTOR_NAMES` (`apps/api/src/db/seed.ts`) — the
  interface (`JobSource.search(criteria)`) doesn't change per source.

## Notes

This ADR was written 2026-09-19, after the fact, once an audit of the
open ticket backlog found the decision had been made in practice (five
sources shipped, working, tested against real captured responses) but never
recorded. The research this ticket originally asked for effectively already
happened — one adapter at a time, against real API responses — it just never
got written up as a single document until now.
