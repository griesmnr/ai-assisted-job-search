/**
 * Local, zero-cost ROLE-WORD SYNONYM EXPANSION for caller-supplied title
 * phrases (ticket 0298b20).
 *
 * Consumed by `criteria.ts`'s `compileFilter`, and ONLY on the
 * explicit-criteria path (`titleInclude` / `titleExclude`). The
 * no-criteria default (`criteria === undefined` -> `filterSoftwareEngineeringJobs`)
 * and every non-title axis (`nearLocations`, `remoteOk`, `commitmentIn`)
 * are untouched by this module.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS TO SOLVE
 * ---------------------------------------------------------------------------
 *
 * `makePhraseMatcher` is literal, word-boundary-anchored substring matching.
 * That is the right primitive (it is not a user-supplied regex, and it is
 * predictable), but it has no idea that a human reading a job board treats
 * "Software Engineer" and "Software Developer" as the same role. Live
 * investigation, 2026-09-23, against all 8 configured sources: a real
 * posting titled "Senior Software Developer" scored zero matches against a
 * search whose title list contained "software engineer" but not
 * "developer". Dozens of comparable near-misses across the same run
 * (Analytics / Data / Security / Mobile / Systems / Backend Engineer vs.
 * Developer variants).
 *
 * The naive fix -- paste the owner's own missing titles into a hardcoded
 * list -- was explicitly rejected by the product owner (ticket 0298b20,
 * verbatim: "I just hope that that learning gets, like, generically applied
 * enough that it would happen with other professions as well and not just
 * me and my own use case"). So this is a table of ROLE WORDS, not a table
 * of titles, and the groups below deliberately span professions that have
 * nothing to do with this repo's owner.
 *
 * ---------------------------------------------------------------------------
 * WHY A CURATED TABLE AND NOT EMBEDDINGS
 * ---------------------------------------------------------------------------
 *
 * Same cost discipline as `ingest/textSimilarity.ts` (ticket 78d31b7): this
 * runs inside the title filter, which is evaluated against EVERY posting of
 * EVERY source on EVERY search -- thousands of comparisons per run. A
 * per-title (or even per-phrase) model call would be real, recurring money
 * for a question that a fifty-line lookup table answers correctly for the
 * overwhelmingly common cases. Pure, synchronous, allocation-light,
 * network-free. Semantic/embedding matching is explicitly a FUTURE ticket
 * if this table proves insufficient, not this one.
 *
 * Cost, measured 2026-09-23 on this worktree (see
 * `titleSynonyms.test.ts`'s perf note): expansion happens once per
 * `compileFilter` call, not per job -- it produces a handful of extra
 * compiled `RegExp`s up front, and the per-job cost is only the extra
 * `Array.prototype.some` iterations, which short-circuit on the first hit.
 * The owner's own real 10-phrase criteria from the 2026-09-23 run expands
 * to 22 matchers (pinned in `titleSynonyms.test.ts`), i.e. roughly 2.2x the
 * regex tests per title in the worst case where nothing matches, on an
 * operation that was already microseconds.
 *
 * ---------------------------------------------------------------------------
 * THE SUBSTITUTION MODEL: ONE WORD AT A TIME, QUALIFIER REQUIRED
 * ---------------------------------------------------------------------------
 *
 * Expansion replaces exactly ONE whitespace-separated token per generated
 * variant -- "software engineer" yields "software developer" and "software
 * programmer", never the cross-product of every token's synonyms. Two
 * reasons:
 *
 *  1. The cross-product is exponential in phrase length for no benefit;
 *     real titles differ from a user's phrasing by one role word, not by
 *     all of them simultaneously.
 *  2. Each additional simultaneous substitution moves the phrase further
 *     from what the user actually typed, and the whole safety argument
 *     below rests on the phrase keeping its domain qualifier.
 *
 * **The qualifier rule.** A phrase is expanded ONLY if it contains at least
 * one token that is not itself a member of any synonym group. This is the
 * single most important safety property in this file, and it is a linguistic
 * fact, not a hack: these words are interchangeable IN CONTEXT, not in
 * isolation. Unqualified, "engineer" ranges over civil, mechanical, sales
 * and solutions engineering; unqualified, "developer" also means a real
 * estate developer and a business developer. Substituting one for the other
 * with no qualifier present drags in entire unrelated professions --
 * a bare `titleInclude: ["developer"]` would start returning "Sales
 * Engineer" and "Mechanical Engineer". Requiring a qualifier BOUNDS
 * cross-domain drift to titles sharing the caller's own qualifier token --
 * NOT "structurally impossible" (fable review, ticket 0298b20, corrected
 * an earlier overclaim here): the qualifier can be ANY token absent from
 * the table, not necessarily a real domain word, so a punctuation or
 * grammatical qualifier still satisfies the rule while pinning nothing.
 * Confirmed live against this table: `titleInclude: ["engineer -"]`
 * expands to `"developer -"` and matches "Real Estate Developer - Seattle"
 * (the trailing hyphen is the "qualifier"); `titleInclude: ["engineer
 * ii"]` -- a common civil/mechanical ordinal form -- matches "Developer
 * II" and "Software Developer II". The qualifier survives every
 * substitution, so "software engineer" can only ever expand to other
 * phrases sharing the word "software" specifically -- that part holds --
 * but "the qualifier survives" is a narrower, true claim than "cross-domain
 * drift is impossible". The tests in `criteria.test.ts` pin the cases that
 * ARE safe; the ones below are the honest list of what isn't.
 *
 * Accepted weaknesses of the rule, recorded honestly (widened after fable
 * review found the seniority case wasn't the only one):
 *  - A seniority-only qualifier ("senior engineer" -> "senior developer")
 *    satisfies the rule without pinning a domain. Real-world "Senior
 *    Developer" postings are overwhelmingly software, so this is low-risk
 *    in practice, but it is not prevented by the rule itself.
 *  - An ordinal-suffix qualifier ("engineer ii" -> "developer ii") is the
 *    same shape and hits real civil/mechanical postings ("Developer II" as
 *    a real-estate title).
 *  - A punctuation or filler-word qualifier ("engineer -", "remote
 *    engineer", "engineer, remote") technically satisfies the rule while
 *    pinning nothing semantic at all.
 * A stop-list (senior/junior/lead/staff/principal/ii/iii/remote and a
 * handful of others) would only ever be a partial mitigation, since the
 * qualifier space is open-ended (any punctuation counts) -- not attempted
 * here. If this produces a real complaint, the honest fix is tightening
 * the qualifier check to require a WORD token specifically (not
 * punctuation) as a first pass, still leaving the ordinal/seniority cases
 * open, not a claim that this becomes airtight.
 * Two adjacent-role drifts within the software/IT group specifically, also
 * accepted rather than fixed: `"computer programmer"` -> `"Computer
 * Engineer"` (a distinct hardware/EE role -- federal job series GS-0854 --
 * reachable since USAJOBS is a live source here), and `"audio engineer"`
 * (studio/live sound) <-> `"Audio Developer"` (game-studio DSP/audio
 * programming) -- close enough in practice that most postings using either
 * phrasing are the same underlying work, but not guaranteed.
 *
 * **Nonsense expansions are free.** A generated phrase that corresponds to
 * no real job title ("civil developer", "technician lead") simply never
 * matches anything, costing one inert regex test. The danger is never a
 * nonsensical expansion; it is an expansion that DOES match real titles
 * belonging to a different role. Every group below is justified against
 * that specific bar, and the "NOT GROUPED" section records the candidates
 * that failed it.
 *
 * **Expansion can only widen `titleInclude` and only tighten
 * `titleExclude`** -- it adds matchers, never removes or alters the
 * original one. So every job that matched before still matches, which is
 * why the pre-existing word-boundary guarantees (C++/.NET and friends, see
 * `makePhraseMatcher`) are preserved by construction: each expanded phrase
 * is compiled through that exact same function, with no special-casing.
 *
 * ---------------------------------------------------------------------------
 * MEASURED AGAINST REAL CAPTURED POSTINGS, 2026-09-23
 * ---------------------------------------------------------------------------
 *
 * Before/after diff over 68 distinct real job titles, extracted from
 * `sources/__fixtures__/` (genuine captured Greenhouse / Lever / Ashby /
 * Recruitee / Rippling / SmartRecruiters / USAJOBS / Workable responses) by
 * pulling each source's actual title field (`jobs[].title` for Greenhouse/
 * Ashby/Workable, `[].text` for Lever, `offers[].title` for Recruitee,
 * `name` for Rippling, `content[].name` for SmartRecruiters,
 * `PositionTitle` for USAJOBS) -- corrected after fable review found the
 * original count (151) included non-title strings from a naive key-walk
 * ("Berlin, Germany", "Responsibilities", people's names) that weren't
 * actually job titles. 33 probe phrases spanning all five surviving
 * domains:
 *
 *  - LOST: 0, on every probe. Nothing that matched before stops matching.
 *  - `"software developer"`: 0 -> 9 matches, and all nine are genuine
 *    Software Engineer reqs ("Backend Software Engineer - Defense",
 *    "Senior Software Engineer, Infrastructure Foundations", ...). This is
 *    the ticket's headline miss, fixed, with zero false positives in the
 *    gained set.
 *  - `"systems engineer"`: 1 -> 2, gaining "Business Systems Developer" --
 *    a correct catch a human would make and the literal matcher could not.
 *  - `"sales engineer"`, `"solutions engineer"`, `"security engineer"`,
 *    `"data engineer"`, `"machine learning engineer"`: unchanged. No
 *    software search pulled in a sales or customer-facing role, and no
 *    sales search pulled in an engineering one.
 *  - BARE `"engineer"` (18 matches) and bare `"developer"` (1 match):
 *    BOTH completely unchanged, and the two sets stay disjoint. The corpus
 *    contains "Civil Engineer (Structural)" and "Calibration Engineer -
 *    Brake Controls"; without the qualifier rule a bare "developer" search
 *    would have swept both in. That is the ticket's named false-positive
 *    class, demonstrated as prevented on real data rather than argued.
 */

/**
 * One synonym group: words that name the SAME role when a domain qualifier
 * is present.
 *
 * Entries are lowercase, single whitespace-free tokens. A multi-word
 * equivalence ("site reliability" ~ "sre", "registered nurse" ~ "rn")
 * cannot be expressed here on purpose -- the substitution model is 1 token
 * for 1 token, and pretending otherwise would silently half-work.
 */
export interface TitleSynonymGroup {
  /** Short label naming the profession/domain this group serves. */
  readonly domain: string;
  /** Interchangeable role words, lowercase, single-token. */
  readonly words: readonly string[];
  /** Why these specific words are safe to swap for one another. */
  readonly why: string;
}

/**
 * The table. Deliberately small and heavily justified rather than large and
 * plausible: every entry here is a claim that a real job board uses these
 * words for one role, and a wrong claim silently changes what a user sees.
 *
 * Five groups spanning five professional domains -- software, skilled
 * technical trades, sales & customer service, writing, and education --
 * which is the ticket's "demonstrate at least 3 distinct professions" bar
 * with margin. (An earlier draft also grouped administrative/healthcare
 * support ("assistant" ~ "aide"); removed after fable review found a real
 * false positive -- see the "assistant ~ aide" entry in NOT GROUPED below
 * for why that one doesn't survive contact with real healthcare job
 * titles.)
 */
export const TITLE_SYNONYM_GROUPS: readonly TitleSynonymGroup[] = [
  {
    domain: "software / IT",
    words: ["engineer", "developer", "programmer"],
    why:
      "The canonical case, and the one with live evidence: a real posting " +
      "titled 'Senior Software Developer' failed a 'software engineer' " +
      "search on 2026-09-23. Qualified by any software-domain word " +
      "(software, backend, frontend, platform, mobile, systems, data, " +
      "security), all three name the person who writes the code -- " +
      "'Backend Engineer' and 'Backend Developer' are the same req at two " +
      "companies, not two roles. 'programmer' is included because it is " +
      "still the standard word in US federal and state job families " +
      "('Computer Programmer', 'Programmer Analyst'), which this app " +
      "queries via USAJOBS and the WA state source -- leaving it out would " +
      "have made the table quietly tech-industry-only.",
  },
  {
    domain: "skilled technical (healthcare, automotive, lab, IT support)",
    words: ["technician", "tech"],
    why:
      "A pure abbreviation pair, and one of the most common in hourly and " +
      "licensed work: 'Pharmacy Technician'/'Pharmacy Tech', 'Surgical " +
      "Technician'/'Surgical Tech', 'Veterinary Technician'/'Vet Tech', " +
      "'Desktop Support Technician'/'Desktop Support Tech'. Employers " +
      "alternate between them within a single careers page, so a literal " +
      "matcher misses roughly half of a real search. Abbreviation pairs " +
      "are the safest possible entries here: there is no semantic claim to " +
      "get wrong, only an orthographic one. Note the qualifier rule does " +
      "the heavy lifting on the reverse direction -- 'tech lead' expands " +
      "to 'technician lead', which matches nothing and costs nothing.",
  },
  {
    domain: "sales & customer service",
    words: ["representative", "rep"],
    why:
      "The same abbreviation argument, in a profession with no overlap " +
      "with this repo's owner: 'Sales Representative'/'Sales Rep', 'Sales " +
      "Development Representative'/'Sales Development Rep', 'Customer " +
      "Service Representative'/'Customer Service Rep' (the last is a real " +
      "captured title from this repo's own live SmartRecruiters " +
      "investigation, see sources/smartrecruiters-swe-filter-findings.md). " +
      "Note this group is a strict abbreviation and is NOT grouped with " +
      "'agent' -- see NOT GROUPED below.",
  },
  {
    domain: "writing & content",
    words: ["writer", "author"],
    why:
      "'Technical Writer' and 'Technical Author' are the standard US and " +
      "UK names for one job, and both appear on US boards of companies " +
      "with UK engineering offices. The swap is narrow on purpose -- see " +
      "the rejected 'editor'/'creator'/'copywriter' candidates in NOT " +
      "GROUPED, which are where the real risk in this domain lives.",
  },
  {
    domain: "education & training",
    words: ["teacher", "instructor"],
    why:
      "For a qualified subject or activity these name one role and one " +
      "pay band: 'Math Teacher'/'Math Instructor', 'Yoga Teacher'/'Yoga " +
      "Instructor', 'ESL Teacher'/'ESL Instructor'. 'professor' is " +
      "deliberately excluded -- see NOT GROUPED.",
  },
];

/**
 * ---------------------------------------------------------------------------
 * NOT GROUPED -- candidates considered and deliberately left out
 * ---------------------------------------------------------------------------
 *
 * This section is the point of the ticket as much as the table is. Each of
 * these is tempting, several were suggested in the ticket text itself, and
 * each one would have caused a real false positive across genuinely
 * different roles. Recording the reasoning so a future contributor does not
 * re-add them from intuition.
 *
 *  - `manager` ~ `supervisor` ~ `lead`. The most tempting and the most
 *    dangerous. In hourly operations "Shift Supervisor" and "Shift Manager"
 *    really are one job, but in corporate structures they are different
 *    levels with different compensation, and "Engineering Manager" is a
 *    materially different role from "Software Engineer" (people management
 *    vs. individual contribution) -- the repo's own default filter excludes
 *    `manager` for exactly that reason (see swe-filter.ts's NOT regex).
 *    Worse, this group would fire in the EXPENSIVE direction: a user's
 *    `titleExclude: ["manager"]` would silently start dropping "Tech Lead"
 *    and "Team Supervisor" postings she may well have wanted, and a hidden
 *    job is invisible in a way an extra row is not (the same asymmetry
 *    ingest/textSimilarity.ts documents for false merges). Left out.
 *
 *  - `analyst` ~ `specialist`. Tempting because US federal/state job
 *    families genuinely do use them for the same grade and work (this
 *    repo's owner has both 'program analyst' and 'IT specialist' in her own
 *    search list). But it breaks immediately outside government: "Sales
 *    Specialist" sells and "Sales Analyst" analyses; "Product Specialist"
 *    is often a support role while "Product Analyst" is not. A synonym must
 *    survive an arbitrary qualifier, and this one does not. Left out --
 *    a user who wants both can list both, which is exactly what the owner
 *    already does.
 *
 *  - `engineer` ~ `architect`. "Software Architect" is a distinct, more
 *    senior design-owning role, and "Solutions Architect" is frequently
 *    pre-sales. Grouping them floods a mid-level search with roles the user
 *    cannot get, and an architect's search with junior roles. Left out.
 *
 *  - `engineer` ~ `scientist`. "Software Engineer" is not "Research
 *    Scientist", and this repo's default filter already treats "data
 *    scientist" as deliberately adjacent-but-out-of-scope (swe-filter.ts).
 *    Left out.
 *
 *  - `assistant` ~ `aide`. Looked like a clean cross-domain safe pick (see
 *    an earlier draft of this table, and fable review, ticket 0298b20) --
 *    but in therapy fields these are SEPARATE OCCUPATIONS, not two names
 *    for one job: the BLS lists "Physical Therapist Assistants and Aides"
 *    as distinct roles. A Physical Therapist ASSISTANT holds an associate
 *    degree and a state license and is paid roughly double a Physical
 *    Therapist AIDE, an unlicensed, on-the-job-trained role -- the same
 *    split exists for occupational therapy. Both titles are common on real
 *    healthcare boards. Confirmed live against this exact table before the
 *    fix: `titleInclude: ["physical therapy assistant"]` surfaced "Physical
 *    Therapy Aide" postings, and -- the actually damaging case -- a
 *    perfectly natural search for a licensed PTA,
 *    `titleInclude: ["physical therapy assistant"], titleExclude:
 *    ["physical therapy aide"]`, silently returned ZERO results, because
 *    the excluded phrase's expansion caught the included phrase's own
 *    expansion. Exactly the "invisible hiding" failure mode this file's own
 *    include/exclude-symmetry argument above warns is the expensive
 *    direction. An "except in healthcare" carve-out cannot be expressed in
 *    a flat one-token-for-one-token table, so the fix is leaving the group
 *    out entirely, not qualifying it. Left out.
 *
 *  - `developer` ~ `coder`. Semantically fine, but "coder" is not a word
 *    real postings use in titles -- a keyword scan of 519 live Expeditors
 *    titles for `coder` (among others) returned zero, see
 *    smartrecruiters-swe-filter-findings.md. It would be inert noise, and
 *    inert noise in a curated table erodes trust in the rest of it.
 *    Separately, in healthcare "Medical Coder" is a real and completely
 *    unrelated billing role, so the one context where the word DOES appear
 *    is the one context where the swap is wrong. Left out.
 *
 *  - `representative` ~ `agent`. Looks like a clean sales synonym until you
 *    read a real logistics board: this repo's live Expeditors capture is
 *    full of "Ocean Export Agent", "Air Export Agent", "Customs Brokerage
 *    Agent", "Warehouse Lead Agent" -- freight-operations roles, not
 *    customer-facing sales. Grouping them would make a sales search return
 *    warehouse operations. Left out.
 *
 *  - `writer` ~ `editor` / `creator` / `copywriter`. An editor revises
 *    other people's work and is a separate req at a separate rate; "Content
 *    Creator" is typically multimedia/social-first, so the swap would turn
 *    a technical-writing search into an influencer-marketing search. And
 *    `copywriter` is a compound, not a synonym -- `\bwriter\b` does not
 *    match "Copywriter" anyway, so grouping them would be a deliberate
 *    decision to pull marketing copy roles into every writing search. All
 *    three left out; this is the domain the ticket text specifically
 *    floated, and it is the domain where the naive grouping is worst.
 *
 *  - `teacher` ~ `professor`. A professor is an academic rank with a
 *    credential requirement (usually a doctorate) and a different hiring
 *    process entirely. Left out.
 *
 *  - Orthographic variants of compound domain words ("backend" ~
 *    "back-end" ~ "back end", "frontend" ~ "front-end", "fullstack" ~
 *    "full-stack"). These are a REAL and probably larger source of misses
 *    than synonyms -- `\bbackend\b` genuinely does not match "Back-End
 *    Developer" -- but they are a different mechanism: some variants change
 *    the token count ("front end" is two tokens), so a 1-token-for-1-token
 *    table would fix half the cases and silently miss the other half, which
 *    is worse than not trying. Recorded here as the recommended follow-up
 *    ticket rather than half-implemented.
 *
 *  - Phrase SHORTENING ("AI application developer" -> "AI Engineer",
 *    "backend software engineer" -> "Backend Engineer"). Two of the misses
 *    in ticket 0298b20's own context are of this shape, and this module
 *    does not fix them: dropping a word from a phrase is a strictly
 *    looser operation than swapping one, with no qualifier guarantee left
 *    to bound it. Stated plainly so nobody reads this module as having
 *    closed that gap. Same for topical relatedness ("cloud microservices"
 *    ~ "Senior Cloud Engineer"), which no synonym table can express.
 */

/**
 * Lowercase word -> the group it belongs to. Built once at module load.
 *
 * A word appearing in two groups would make expansion order-dependent and
 * the table unreviewable; `titleSynonyms.test.ts` asserts it never happens.
 */
const GROUP_BY_WORD: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const group of TITLE_SYNONYM_GROUPS) {
    for (const word of group.words) {
      map.set(word, group.words);
    }
  }
  return map;
})();

/**
 * Expands one caller-supplied title phrase into the phrase itself plus every
 * single-word synonym substitution the table licenses.
 *
 * The original phrase is ALWAYS first in the returned array and always
 * present, so a caller that compiles all of them gets today's behavior plus
 * additions -- never less.
 *
 * Returns `[phrase]` unchanged when the phrase has no expandable token, or
 * when it fails the qualifier rule (no token outside the synonym table --
 * see this module's header). Internal whitespace and the case of every
 * untouched token are preserved exactly, because the phrase is fed straight
 * back into `makePhraseMatcher`, whose boundary behavior depends on the
 * literal characters at each end. The substituted token itself arrives from
 * the table in lowercase; that is safe because `makePhraseMatcher` compiles
 * case-insensitively, and pinned by a test so it stays a decision.
 */
export function expandTitlePhrase(phrase: string): string[] {
  // Capturing split keeps the separators, so rejoining reproduces the
  // caller's exact spacing: even indices are tokens, odd are whitespace.
  const parts = phrase.split(/(\s+)/);
  const tokenIndices: number[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].length > 0) tokenIndices.push(i);
  }

  // The qualifier rule: at least one token must sit OUTSIDE the table, so
  // the substituted phrase stays pinned to the domain the caller named.
  const hasQualifier = tokenIndices.some((i) => !GROUP_BY_WORD.has(parts[i].toLowerCase()));
  if (!hasQualifier) return [phrase];

  const expansions = [phrase];
  const seen = new Set<string>([phrase.toLowerCase()]);

  for (const i of tokenIndices) {
    const token = parts[i];
    const group = GROUP_BY_WORD.get(token.toLowerCase());
    if (group === undefined) continue;
    for (const synonym of group) {
      if (synonym === token.toLowerCase()) continue;
      const variantParts = parts.slice();
      variantParts[i] = synonym;
      const variant = variantParts.join("");
      const key = variant.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      expansions.push(variant);
    }
  }

  return expansions;
}
