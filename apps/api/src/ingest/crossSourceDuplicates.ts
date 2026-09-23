/**
 * Cross-source duplicate detection (ticket 78d31b7, design 98844f1).
 *
 * THE PROBLEM. `jobs`' uniqueness constraint is `(data_source,
 * external_id)`. That dedupes a posting reappearing from the SAME source (a
 * RabbitMQ redelivery, or the same source returning the same posting across
 * two searches) and nothing else. If one employer lists the same req on
 * both Greenhouse and Workable, the two arrive as two different
 * `(data_source, external_id)` pairs, become two `jobs` rows, get scored
 * twice (two real Claude calls), and both surface in the ranked list.
 *
 * Measured baseline, so nobody mistakes this for a bug report: on
 * 2026-09-23 a live check across all 8 configured sources found ZERO
 * cross-source collisions — 0 companies and 0 (company, title) pairs
 * appearing under more than one source, across 2,304 real jobs and 32
 * companies (98844f1 comment #1). This is protection built ahead of need,
 * deliberately (98844f1 comment #2), because a single edit to an employer
 * list can introduce a collision at any time.
 *
 * ---------------------------------------------------------------------------
 * TWO GATES, IN ORDER, AND WHY IT IS NOT ONE FUZZY MATCH
 * ---------------------------------------------------------------------------
 *
 * GATE 1 — EXACT, after normalization: an existing row from a DIFFERENT
 * data source whose company AND title AND location all match. Exact, not
 * fuzzy, and that is the whole point. A real company routinely has several
 * genuinely distinct openings sharing a title and a city (two "Software
 * Engineer" reqs, different teams). Matching those on company + title +
 * location alone would merge two real jobs into one and silently hide one
 * of them from the user forever.
 *
 * GATE 2 — description similarity (`textSimilarity.ts`), and ONLY on pairs
 * that already cleared gate 1. Local, no API call, no scoring budget. This
 * is what tells "the same req on two platforms" apart from "two different
 * reqs that happen to share a title".
 *
 * The ordering is a hard invariant, not an optimization: gate 2 must never
 * run on a pair that failed gate 1. `crossSourceDedup.test.ts` asserts that
 * by counting calls into the similarity module, not by checking that the
 * outcome happened to be "not merged".
 *
 * ---------------------------------------------------------------------------
 * WHAT "MATCHING" MEANS IN GATE 1, PRECISELY
 * ---------------------------------------------------------------------------
 *
 * `normalizeMatchField`: Unicode NFKC, lowercase, collapse all whitespace
 * runs to one space, trim. Equality of the resulting strings. Nothing else.
 *
 * What that deliberately does NOT do, and why:
 *
 *   - NO punctuation stripping. It would let "Acme, Inc." match "Acme Inc",
 *     which is nice, but it also collapses "C++ Engineer" and "C# Engineer"
 *     to the same string — two genuinely different roles at the same
 *     company, exactly the pair this design exists to keep apart. A gate
 *     whose failure mode is "misses a merge" is fine; one whose failure
 *     mode is "invents a merge" is not.
 *   - NO legal-suffix or company-alias handling ("Acme" vs "Acme Inc"
 *     stays a non-match). Same reasoning, and it is the first thing to
 *     revisit if a real collision is ever observed and missed.
 *   - NO fuzzy/edit-distance matching of any of the three fields. Out of
 *     scope by the ticket, and it would reintroduce exactly the
 *     over-matching risk gate 1 exists to remove.
 *
 * A NULL location matches another NULL location (both normalize to ""), so
 * two sources that simply do not publish a location can still be compared —
 * with gate 2 still standing between them and a merge.
 *
 * ---------------------------------------------------------------------------
 * SCOPE BOUNDARIES WORTH NAMING
 * ---------------------------------------------------------------------------
 *
 * WITHIN ONE BATCH, NOTHING MERGES. Every posting in a single
 * `ingestJobsForSearch` call shares one `dataSource`, and gate 1 requires a
 * DIFFERENT source, so two postings in the same response are never compared
 * to each other. Two distinct reqs in one source's own response stay two
 * rows, which is correct.
 *
 * ONE EXISTING ROW IS CLAIMED AT MOST ONCE PER BATCH. If two postings in
 * this batch both match the same existing row, only the first takes it; the
 * second is inserted normally. Two distinct postings in one response are
 * two jobs by definition, so collapsing both onto one row would lose one —
 * and it would also put the same id in `linkedJobIds` twice.
 *
 * CONCURRENT INGESTS OF THE TWO SOURCES CAN BOTH INSERT. This runs inside
 * `ingestJobsForSearch`'s transaction, so it cannot see another
 * transaction's uncommitted rows. Two sources ingesting the same req at the
 * same instant therefore produce two rows, exactly as they do today. That
 * is a deliberate non-fix: the alternative is a lock or a unique index over
 * a fuzzy key, and the failure mode here is "the feature didn't fire",
 * which is the behavior this whole ticket is an improvement on, not a
 * regression from.
 *
 * NO RETROACTIVE DEDUP. Rows ingested before this shipped are untouched.
 *
 * ---------------------------------------------------------------------------
 * MEASURED COST (2026-09-23, dev container, `crossSourceDedup.perf.test.ts`,
 * median of 3 runs after a warm-up — that test regenerates these numbers)
 * ---------------------------------------------------------------------------
 *
 * Ingesting a 1,200-posting batch (above the largest real single-source
 * response this repo has seen, 4,771 aside — ticket 3067e2c), against a
 * corpus of 2,400 jobs from another source, which is the live scale
 * (2,304 jobs across 8 sources, 98844f1):
 *
 *   check OFF (the pre-ticket code path)          151 ms
 *   check ON, no candidates (today's real state)  163 ms   (+11 ms, +7.6%)
 *   check ON, EVERY posting has a candidate       369 ms  (+218 ms, +144%)
 *
 * The middle row is the one that describes production today: 0 collisions
 * across 2,304 live jobs, so the check is one extra SELECT that returns
 * nothing plus three short string normalizations per posting. ~11 ms on a
 * 1,200-job ingest is noise next to the RabbitMQ round trip and the Claude
 * scoring calls that follow it.
 *
 * The bottom row is a scenario that cannot occur today (it needs all 1,200
 * postings to match existing rows exactly on company + title + location)
 * and is reported anyway, because it is the honest ceiling: ~0.18 ms per
 * full description comparison, all of it local CPU, no API call, no
 * scoring-budget impact.
 *
 * HOW IT SCALES, AND WHEN TO ADD AN INDEX. The candidate lookup has no
 * index to use — the match key is an expression over three columns — so it
 * is a sequential scan, linear in the size of `jobs`. Re-measured at a
 * 20,000-job corpus, the "no candidates" case costs +58 ms instead of
 * +11 ms, i.e. roughly 3 ms per 1,000 rows, per ingest call. Left unindexed
 * deliberately: at today's 2,304 rows an index would be a migration and a
 * write-path cost buying ~10 ms. REVISIT WHEN `jobs` PASSES ~50,000 ROWS
 * (projected ~150 ms per call, which starts to be worth paying for), and
 * the fix is a plain expression index matching `SQL_MATCH_KEY` below.
 */
import { and, inArray, ne, sql, type AnyColumn } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobs } from "../db/schema.js";
import type { NormalizedJob } from "../sources/types.js";
import { descriptionSimilarity, DESCRIPTION_SIMILARITY_THRESHOLD } from "./textSimilarity.js";

/**
 * How many normalized match keys go into one candidate-lookup statement.
 *
 * Same bound-parameter reasoning as `JOBS_INSERT_CHUNK` in ingestJobs.ts:
 * Postgres caps a statement at 65,535 bound parameters, and this query
 * binds one per key plus one for `dataSource`. 2,000 is far inside that
 * while keeping the number of round trips low — a 6,000-posting response
 * (the largest this repo has actually seen is 4,771, ticket 3067e2c) costs
 * at most three statements, and the realistic single-source response of a
 * few hundred costs exactly one.
 */
const MATCH_KEY_LOOKUP_CHUNK = 2000;

/**
 * Most existing rows to compare against for a single match key.
 *
 * A bound on pathological work, not a tuning knob. Gate 1 is exact, so
 * reaching this at all means some other source genuinely holds 25+ rows
 * with byte-identical (normalized) company, title and location — which
 * would be a data-quality problem in that source, not a duplicate to
 * resolve. Capping means one such key costs 25 similarity computations
 * instead of thousands. Candidates are ordered by id so the subset
 * considered is deterministic across redeliveries; anything past the cap is
 * simply not merged, which is the safe direction.
 */
const MAX_CANDIDATES_PER_KEY = 25;

/** Separator between the three fields of a match key. A control character
 * so it can never occur inside a normalized company/title/location (all
 * whitespace has already been collapsed to U+0020 and control characters
 * are not word characters). Without it, ("Acme Corp", "Engineer") and
 * ("Acme", "Corp Engineer") would produce the same key. */
const KEY_SEPARATOR = "\u001f";

/**
 * Gate 1's normalization. See the "WHAT MATCHING MEANS" section above for
 * what it deliberately leaves alone.
 */
export function normalizeMatchField(value: string | null | undefined): string {
  if (!value) return "";
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The exact-match key for gate 1: normalized company, title and location.
 *
 * `location` is `string | null | undefined` because both shapes are fed to
 * this function and they mean the same thing: a `NormalizedJob` off a source
 * adapter has `location?: string` (undefined when the source published
 * none), while the same posting read back out of Postgres has
 * `location: string | null`. Both normalize to `""`, so a posting round-
 * tripping through the database keeps the same key it had on the way in —
 * which is exactly what makes the merge check work at all.
 */
export function crossSourceMatchKey(job: {
  company: string;
  title: string;
  location?: string | null;
}): string {
  return [
    normalizeMatchField(job.company),
    normalizeMatchField(job.title),
    normalizeMatchField(job.location),
  ].join(KEY_SEPARATOR);
}

/**
 * The SQL twin of `normalizeMatchField`, used ONLY to narrow the rows
 * Postgres sends back.
 *
 * It does not have to agree with the TypeScript version exactly, and it
 * deliberately isn't asked to: NFKC has no cheap SQL equivalent, and
 * `lower()`/`[[:space:]]` have their own locale and Unicode edge cases. The
 * TS key is recomputed on every returned row and is the ONLY thing that
 * decides a match (see `findCrossSourceDuplicates`), so this expression can
 * only ever over-fetch (harmless — the TS check rejects it) or under-fetch
 * (a missed merge, the cheap failure). It can never cause a merge the
 * canonical normalizer would not.
 */
function normalizedColumn(column: AnyColumn) {
  return sql`btrim(regexp_replace(lower(coalesce(${column}, '')), '[[:space:]]+', ' ', 'g'))`;
}

const SQL_MATCH_KEY = sql`${normalizedColumn(jobs.company)} || chr(31) || ${normalizedColumn(
  jobs.title,
)} || chr(31) || ${normalizedColumn(jobs.location)}`;

/** What `findCrossSourceDuplicates` concluded about one incoming posting. */
export type CrossSourceMatch = {
  /** The existing `jobs.id` this posting is the same job as. */
  existingJobId: string;
  /** Which source already had it — for logging and for tests that want to
   * assert the merge went the direction they expect. */
  existingDataSource: string;
  /** The measured description similarity that cleared the threshold. */
  similarity: number;
};

/**
 * Finds, for each posting in `candidates`, an existing job from a different
 * source that is the same real posting.
 *
 * Returns a map keyed by `externalId` (the same key
 * `ingestJobsForSearch` has already deduped its batch by). A posting absent
 * from the map has no cross-source duplicate and must be inserted normally.
 *
 * `dataSource` is the source being ingested under, i.e. the same argument
 * `ingestJobsForSearch` received; rows from it are excluded, as are rows
 * from a posting's OWN `dataSource` when the two disagree (which is itself
 * a caller bug — see `ingestJobsForSearch`'s "should be impossible" throw,
 * which must keep firing rather than being masked by a merge).
 */
export async function findCrossSourceDuplicates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: NodePgDatabase<any>,
  dataSource: string,
  candidates: NormalizedJob[],
): Promise<Map<string, CrossSourceMatch>> {
  const matches = new Map<string, CrossSourceMatch>();
  if (candidates.length === 0) return matches;

  const keyByExternalId = new Map<string, string>();
  for (const job of candidates) {
    keyByExternalId.set(job.externalId, crossSourceMatchKey(job));
  }
  const distinctKeys = [...new Set(keyByExternalId.values())];

  type CandidateRow = {
    id: string;
    dataSource: string;
    company: string;
    title: string;
    location: string | null;
    description: string;
  };
  const rows: CandidateRow[] = [];
  for (let i = 0; i < distinctKeys.length; i += MATCH_KEY_LOOKUP_CHUNK) {
    const chunk = distinctKeys.slice(i, i + MATCH_KEY_LOOKUP_CHUNK);
    const found = await tx
      .select({
        id: jobs.id,
        dataSource: jobs.dataSource,
        company: jobs.company,
        title: jobs.title,
        location: jobs.location,
        description: jobs.description,
      })
      .from(jobs)
      .where(and(ne(jobs.dataSource, dataSource), inArray(SQL_MATCH_KEY, chunk)));
    rows.push(...found);
  }
  if (rows.length === 0) return matches;

  // Re-key every returned row with the CANONICAL (TypeScript) normalizer,
  // so the SQL expression above is only ever a prefilter. Anything whose
  // real key doesn't match drops out here.
  const candidatesByKey = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const key = crossSourceMatchKey(row);
    const list = candidatesByKey.get(key);
    if (list) list.push(row);
    else candidatesByKey.set(key, [row]);
  }
  // Deterministic order across redeliveries: which existing row a posting
  // merges into must not depend on Postgres's row order.
  for (const list of candidatesByKey.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // An existing row can absorb at most one posting from this batch.
  const claimed = new Set<string>();

  for (const job of candidates) {
    const key = keyByExternalId.get(job.externalId);
    if (key === undefined) continue;
    const pool = candidatesByKey.get(key);
    if (!pool) continue;

    let considered = 0;
    for (const row of pool) {
      if (considered >= MAX_CANDIDATES_PER_KEY) break;
      if (claimed.has(row.id)) continue;
      // Never compare a posting against its own source's rows. The
      // `ne(dataSource)` above already excludes the source being ingested
      // under; this also covers the case where the posting's own
      // `dataSource` disagrees with that argument.
      if (row.dataSource === job.dataSource) continue;
      considered++;

      // GATE 2. Reached only for a pair that already matched exactly on
      // company + title + location.
      const similarity = descriptionSimilarity(job.description, row.description);
      if (similarity >= DESCRIPTION_SIMILARITY_THRESHOLD) {
        claimed.add(row.id);
        matches.set(job.externalId, {
          existingJobId: row.id,
          existingDataSource: row.dataSource,
          similarity,
        });
        break;
      }
    }
  }

  return matches;
}
