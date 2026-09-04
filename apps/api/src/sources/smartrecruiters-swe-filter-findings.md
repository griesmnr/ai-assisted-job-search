# SmartRecruiters zero-survivor investigation — findings (git-bug 84b879e)

## Conclusion

**Case (b): an honest finding, not a filter bug.** SmartRecruiters'
configured employer list (`SMARTRECRUITERS_COMPANIES=Nike,Starbucks,
Nordstrom,TMobile,PACCAR,Visa,Expeditors`) survives zero postings through
`filterSoftwareEngineeringJobs` because six of the seven currently have no
open postings on SmartRecruiters at all, and the seventh (Expeditors) posts
almost exclusively logistics/operations roles — real postings that the
title filter correctly excludes, and the two title-ambiguous exceptions are
independently excluded by location (onsite, non-PNW, not remote) even before
the title question matters. No location-format gap like Ashby's `PLACE`
hyphen bug (ticket 4450f39) was found. **No source code was changed.**

## What was checked live (2026-09-04)

Ran `apps/api/src/scripts/check-smartrecruiters-board.ts` — the existing
survivor-level checker (it already runs the real `filterSoftwareEngineeringJobs`
against every summary on a company's board, not just a liveness ping) —
against all seven configured identifiers:

```
$ npx tsx src/scripts/check-smartrecruiters-board.ts \
    Nike Starbucks Nordstrom TMobile PACCAR Visa Expeditors

Nike                      0 posting(s), 0 would survive filtering
Starbucks                 0 posting(s), 0 would survive filtering
Nordstrom                 0 posting(s), 0 would survive filtering
TMobile                   0 posting(s), 0 would survive filtering
PACCAR                    0 posting(s), 0 would survive filtering
Visa                      0 posting(s), 0 would survive filtering
Expeditors               519 posting(s), 0 would survive filtering
```

A `0 posting(s)` line (as opposed to `INVALID`) means the script's own
Finding-1 disambiguation (`checkCareersSiteValidity`, reused from
`smartrecruiters.ts`) got a direct HTTP 200 from
`careers.smartrecruiters.com/{company}` rather than the 3xx-to-`jobs.
smartrecruiters.com` redirect Finding 1 documents for an unrecognized/
typo'd identifier:

```
Nike        | totalFound: 0 | careers status: 200 | location: null
Starbucks   | totalFound: 0 | careers status: 200 | location: null
Nordstrom   | totalFound: 0 | careers status: 200 | location: null
TMobile     | totalFound: 0 | careers status: 200 | location: null
PACCAR      | totalFound: 0 | careers status: 200 | location: null
Visa        | totalFound: 0 | careers status: 200 | location: null
```

**Correction from adversarial review (2026-09-04):** a bare `careers status:
200` is weaker evidence than the first draft of this doc claimed —
SmartRecruiters issues a distinct tenant page (200) for essentially any
plausible-looking slug, including invented ones (`Nike1`, `NikeInc`,
`VisaInc` all return 200 as separate tenants from the real accounts). A 200
proves a tenant exists, not that it's the specific real employer intended.
What actually rules out "this is a typo'd/wrong identifier" is a broader
sweep: the review checked ~20 plausible identifier variants per company
(`paccar`, `PACCAR_US`, `tmobile`, `TMobileUS`, etc.) and every variant
returns `totalFound: 0` too — consistent with "this employer's SmartRecruiters
presence is genuinely empty right now" and inconsistent with "the configured
slug just happens to be wrong while some other slug for the same employer
has real postings." Combined with each configured identifier matching the
employer's own public branding exactly (not a guess), this is not a config
typo: these six are being asked correctly and simply aren't posting
anything on the platform right now. Nothing for the filter to evaluate —
it isn't misbehaving, there's no input.

## Why Expeditors' 519 postings don't survive

Expeditors is the only one of the seven with a live board, and the only one
worth digging into. Fetched all 519 postings (paginated, `limit=100`) and
inspected every title.

**The board is overwhelmingly logistics/freight-forwarding operations, not
software engineering** — a representative sample of real titles:

```
Warehouse Lead Agent
Accounts Payable Agent
Ocean Export Agent
Air Export Agent
Transcon Manager
Customs Brokerage Agent
Distribution Supervisor
Logistics Coordinator - Customs Brokerage
Brokerage Agent, Imports & Exports
Warehouse Distribution Agent
```

A keyword scan of all 519 titles for anything tech-adjacent
(`engineer|entwickl|developer|programmer|coder|.net|java|python|salesforce|
sap|cloud|api|devops|architect`) found exactly **2 unique titles**, out of
356 unique titles on the board:

- `Data Engineer III/Senior (Analytics)` — 4 open reqs, real captured
  locations: `"Edison, NJ, United States"`, `"Irving, TX, United States"`,
  `"Ellenwood, GA, United States"`, `"Romulus, MI, United States"`. Every
  one has structured `location.remote: false, location.hybrid: false` —
  onsite, none in the PNW. **Correction from adversarial review
  (2026-09-04):** the first draft of this doc said `classifyGeography`
  resolves these to `"unknown"` — wrong. The "United States" text matches
  the US-wide geography regex, so `classifyGeography` actually returns
  `"us-wide"`, not `"unknown"`. The outcome is unchanged (`us-wide` +
  onsite/non-remote still fails `passesLocationFilter`, same as
  `"unknown"` would), but the stated mechanism was wrong and is corrected
  here. The title also
  genuinely doesn't match `SOFTWARE` — "Data Engineer" is a data-engineering
  title, and this project's filter already deliberately treats adjacent
  roles (e.g. `data scientist` in `NOT`) as out of scope, consistent with
  swe-filter.ts's own stated design ("actual software engineering roles,
  not adjacent ones").
- `Global Technology Engineer III (Java)` — the one title on the whole
  board that a human would plausibly call a real software engineering
  role. Its real captured location: `{"city":"Europe","country":"xx",
"address":"Can be based anywhere in Europe","remote":false,"hybrid":
false,"fullLocation":"Europe, , OTHER"}`. Structured `remote`/`hybrid`
  are both `false` — onsite, and "Europe, , OTHER" matches neither the PNW
  nor the US-wide geography regex, so `classifyGeography` returns
  "unknown" and it fails location regardless of title. Its title also
  doesn't literally match `SOFTWARE` (no "software engineer" /
  "full-stack" / "senior engineer" / "staff engineer" substring) — a real,
  narrow title-regex gap, but a provably inconsequential one: fixing it
  would change this one posting's title-filter outcome from fail to pass,
  and it would still fail location, so survivor count is unaffected. Per
  this ticket's own instruction not to guess-tune regexes without real
  usage data, and since there is no other real posting anywhere in this
  519-record set to validate a widened regex against, this is left
  unchanged and simply recorded here.

**Expeditors does have a genuine PNW footprint** — its HQ is Bellevue/
Federal Way, WA, and 19 of its 519 live postings are physically located in
the Seattle area, correctly classifying as `"pnw"`. None of them are
software engineering roles:

```
Payroll Specialist                                    | Seattle, WA
Manager - Document Management                         | Bellevue, WA
Corporate Counsel – Transactions – Business Enablement | Bellevue, WA
Real Estate Global Operations Manager                  | Bellevue, WA
Pricing Analyst, The Americas                          | Seattle, WA
Logistics Security Analyst                             | Seattle, WA
Customer Service Representative - Customs Brokerage    | Federal Way, WA
```

**Correction from adversarial review (2026-09-04):** the first draft of
this doc claimed all 19 "correctly" classify as `pnw`, presented as
evidence the filter is working right. That's not quite true — one of the
19 is `"Manager - Project Cargo Services, AU/NZ" | Jandakot, WA,
Australia`, which classifies `pnw` too, because `PNW`'s `,\s*wa\b`
alternation matches "WA" as a bare 2-letter code without checking the
country — it can't distinguish Washington State from Western Australia.
This posting only fails to appear in results because of the unrelated
`manager` title exclusion, not because the location filter correctly
identified it as non-PNW. That's a real, separate latent bug, filed as its
own ticket (7ab1b57) rather than fixed here, since fixing it isn't in this
ticket's scope and deserves its own real-data-first treatment like the DC
guard and Ashby PLACE fixes. The other 18 of the 19 are genuinely
Seattle/Bellevue/Federal-Way US postings and do correctly classify `pnw`.

So, setting the Australia false-positive aside, the location filter is not
silently discarding a real Seattle-area SWE posting — there simply isn't
one on this board right now.

## Ruling out case (a) — no location-format gap found

The specific failure mode ticket 4450f39 found for Ashby (a single combined
regex requiring a literal `remote - us` hyphen, silently dropping every
SmartRecruiters-shaped posting since SmartRecruiters never writes that
string at all — it carries a structured `location.remote` boolean instead)
was the first thing checked here, since `swe-filter.ts`'s own top-of-file
comment names SmartRecruiters explicitly as a historical victim of that bug.
It is fixed and stayed fixed: this ticket's real data confirms the
structured-boolean path works correctly both directions — the 18 genuine
Bellevue/Seattle/Federal-Way postings correctly classify as `"pnw"`, and
genuine non-PNW onsite postings (Data Engineer, Global Technology
Engineer) correctly classify as excluded/failing. (A different, unrelated
bug — the `,\s*wa\b` PNW regex also matching Western Australia, ticket
7ab1b57 — surfaced in this same 19-posting set; that's a false-positive-
geography bug, not a recurrence of Ashby's hyphen-format bug, which was a
false-negative on genuinely-PNW text.) Nothing in this investigation
reproduces Ashby's specific location-string-format failure mode.

## Recommendation for Nicole

This employer list (Nike, Starbucks, Nordstrom, TMobile, PACCAR, Visa,
Expeditors) skews retail/logistics — exactly the sectors ticket 84b879e's
own framing flagged as a plausible honest-zero cause — and the live data
now confirms it: six have no open reqs on SmartRecruiters at all right now,
and the one that does is a freight-forwarding operations board with a real
but small PNW presence that happens to carry zero engineering roles today.
That's a property of _which employers are configured_, not a defect in the
adapter or the filter. Two options, both product/config decisions rather
than engineering ones, left for Nicole rather than decided here:

1. **Swap the employer list** for SmartRecruiters customers more likely to
   post PNW/remote-US software engineering roles (larger tech-adjacent
   enterprises are the better fit for this ATS's customer base than
   retail/logistics).
2. **Leave SmartRecruiters toggleable but not part of the default-selected
   set** — it's a real, working adapter (`skipRate 0.00`, confirmed live
   here), just currently starved of relevant postings under this specific
   employer list. This is a distinct situation from ticket d480357's
   "hide unconfigured sources" (SmartRecruiters _is_ configured and
   working) — deliberately not conflated with that ticket's scope here.

## Verification performed

- **Live**: `check-smartrecruiters-board.ts` run 2026-09-04 against all 7
  `SMARTRECRUITERS_COMPANIES` entries (results above).
- **Live**: direct fetch confirming all 6 empty-board companies'
  `careers.smartrecruiters.com/{company}` page returns HTTP 200 directly
  (not Finding 1's "unrecognized identifier" redirect to
  `jobs.smartrecruiters.com`).
- **Live**: full paginated fetch of Expeditors' 519-posting board (2026-09-04),
  every title inspected, both tech-adjacent titles' real location payloads
  captured and checked against `classifyGeography`/`resolveWorkArrangement`
  by hand.
- **No source code changed** — `swe-filter.ts` and `smartrecruiters.ts` are
  untouched. The only new file besides this one is the trimmed real fixture
  named above. `rtk vitest` and `rtk pnpm lint` were run anyway as a
  baseline sanity check (not required by the Definition of Done's "if any
  source code changed" clause, since none did) — both clean; see commit
  message.
