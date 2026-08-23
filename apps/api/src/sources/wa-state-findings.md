# Washington State source adapter — feasibility findings (RTK-d6c778e)

## Conclusion

**No adapter was implemented.** Washington State does not publish job
listings through any legitimate machine-readable channel. Building against
the only thing that returns WA job data (governmentjobs.com's underlying
web app) would mean scraping a site whose terms of use explicitly forbid
exactly that. Per this ticket's own instructions, that's a stop condition,
not a workaround to engineer around.

This document is the entire deliverable for this ticket: the investigation,
the evidence, and a recommended substitute for a future ticket to pick up.

## What was checked

1. **careers.wa.gov** — Washington's state careers portal. Fetched the page
   directly. It carries no API, RSS, JSON feed, or developer documentation
   links. Its search UI and all job data are served from
   `governmentjobs.com/careers/washington` — careers.wa.gov is a skin over
   NEOGOV's platform, not a separate system with its own data surface.

2. **governmentjobs.com/careers/washington** — the actual system of record.
   Fetched the page and looked for XHR/fetch targets, `/api/`, `.json`,
   `/rss`, `/feed` references, or linked developer docs. Found none. The
   page is built for browser interaction only.

3. **NEOGOV's public API** — NEOGOV (the vendor behind both careers.wa.gov
   and governmentjobs.com) does advertise a REST API supporting JSON/XML.
   That API is for NEOGOV _customers_ (the agencies themselves, e.g. WA's
   HR system) to integrate with their own NEOGOV instance — it authenticates
   as the customer and manages their postings/applicants. It is not a public
   read endpoint a third party can query for another agency's listings, and
   nothing in NEOGOV's materials suggests otherwise.

4. **NEOGOV's Terms of Use**
   (`governmentjobs.com/careers/washington/termsofuse`, and NEOGOV's
   corporate ToU) — checked directly, since "is there technically a JSON
   response the frontend calls" and "is it legitimate to use" are different
   questions. The terms are explicit and apply regardless of whether the
   content requires a login:

   > "To use any 'page-scrape', 'robot', 'spider' or other automatic device,
   > program, algorithm or methodology, or any similar process, to access,
   > acquire, copy or monitor any portion of the Services or any NEOGOV
   > Content"

   > "[restrictions apply to] any access, use, reproduction, scraping, or
   > distribution of Customer content hosted by NEOGOV or its affiliates
   > through public-facing websites, subdomains or portals ... regardless of
   > whether such content is public or viewable without a login."

   > "[Uses for] competitive analysis, data harvesting or to build or
   > enhance a competing product or service is strictly prohibited."

   This closes off both "hit whatever JSON endpoint the page itself calls"
   and "parse the rendered HTML" as options — both are exactly what this
   clause names.

5. **data.wa.gov (Washington's open data portal)** — checked for a job
   postings dataset alongside careers.wa.gov. It carries labor-market
   _statistics_ (employment estimates, wage reports from the Employment
   Security Department) but no dataset of open positions. Nothing to build
   an adapter against here either.

## Why this isn't a scraping problem to solve cleverly

The ticket is explicit that finding no legitimate source is a valid, useful
outcome, and that scraping HTML or building against something that violates
a site's terms is not an acceptable substitute regardless of feasibility.
That's the situation here: the data is _technically_ reachable (it's a
public website), but reachable and legitimate to build a recurring
automated integration against are different things, and NEOGOV's terms
close that gap explicitly for exactly this use case ("data harvesting",
"build ... a competing product").

## Recommended substitute

Of the candidates suggested in the ticket, **Adzuna** is the best fit if a
"Washington jobs" source is still wanted, with caveats below.

- **Adzuna** (`api.adzuna.com/v1/api/jobs/us/search/{page}`) — free
  `app_id`/`app_key` via `developer.adzuna.com` (same shape as USAJOBS:
  credentials in config, never hardcoded). Supports a `where` query param
  for location (e.g. `where=Washington`), and per-listing fields
  `contract_type` (`permanent`/`contract`) and `contract_time`
  (`full_time`/`part_time`) that map onto `commitment` with the same
  "match the reliable machine field, don't guess" approach USAJOBS uses for
  `PositionSchedule.Code`. `salary_min`/`salary_max` exist but there is
  **no documented `payType` equivalent** (hourly vs. salary) in Adzuna's
  search response — that would need the same "surface as unmappable rather
  than guess" treatment USAJOBS applies, and could plausibly skip a large
  fraction of records depending on real response shape. **Not yet verified
  against a live captured response** — that's the required first step for
  whoever picks this up (per this ticket's own instruction: capture a real
  response before writing a single field mapping).

Why not the others:

- **Remotive** — keyless and well-documented, but it's a remote-only board
  with no state/location filtering that means anything for "Washington" —
  a "remote" posting isn't tied to a state. Wrong shape for a _Washington_
  source specifically, though it would be a reasonable general "remote
  jobs" source for a different ticket.
- **The Muse** — free key, and does support location filtering, but by a
  fixed list of metro areas rather than a state (would only capture
  Seattle-area postings, not the state), and job-type/commitment fields are
  thinner than Adzuna's from initial review. Second choice.
- **USAJOBS filtered to WA** (`LocationName=Washington`) — technically the
  easiest (zero new code, already implemented, already tested against a
  real response), but it only returns _federal_ jobs located in WA, not WA
  state government or private-sector jobs, which likely isn't what a
  "Washington source" is meant to mean here. Worth naming as an option
  since it requires no new adapter, but recommend against treating it as
  satisfying this ticket's intent.
- **HN "Who's Hiring" (Algolia API)** — keyless and JSON, but the data is
  freeform comment text, not structured fields. `payType`, `commitment`,
  and `location` would all have to be regex/heuristic-guessed out of prose,
  which is exactly the kind of guessing this ticket's mapping rules forbid.
  Real risk of a ~1.0 skip rate, which the ticket treats as a mapper bug
  signal, not a usable source.

## What would need to happen before Adzuna (or any substitute) gets built

Per this ticket's own instructions for step 2, whoever picks this up should:

1. Register a free Adzuna key and capture one real `where=Washington`
   response to `__fixtures__/`.
2. Read `payType`/`commitment`/`locationType` mappings off that real JSON,
   not off the docs — the docs above already turned out to have no
   `payType` field at all, which is the kind of surprise USAJOBS' fixtures
   got wrong the first time.
3. Decide, with real data in hand, whether `dataSource: "wa-state"` is
   still the right tag for "Adzuna listings located in Washington" (it
   isn't literally Washington's own listings) — that's a product call, not
   an engineering one, and is called out here rather than decided
   unilaterally.

## Verification performed

This is a research-only ticket outcome — no source code was added, so there
is nothing to run `vitest`/`tsc` against. `apps/api/src/sources/types.ts`
was read but not modified, per the instruction to stop rather than edit it
if the interface didn't fit; the interface itself is fine, there's simply no
WA-state data to feed it.
