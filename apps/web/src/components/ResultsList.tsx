import { Fragment, useState } from "react";
import type { GetResumeResultsResponse, UserJobStatus } from "@app/shared";
import { ResultCard } from "./ResultCard";

/**
 * Renders the curated (score-floor-applied) result set, filtered by the
 * currently toggled-on sources — client-side, per decision #3: source
 * toggles filter an already-fetched corpus instantly, they never trigger a
 * new fetch. `data` is always the FULL floor-applied set for the resume
 * (see hooks/useResults.ts); `selectedSourceIds` narrows it here.
 *
 * "Short curated list, not an unbounded ranked table" (decision #1,
 * 2026-08-22/29): `hiddenBelowFloor` is always shown when present, even at
 * 0, so an empty-looking short list never reads as a broken run — it says
 * outright how many real, scored jobs are sitting below the floor.
 */
export function ResultsList({
  data,
  selectedSourceIds,
  onSetStatus,
  onClearStatus,
  onViewResume,
  onFirstResultAnchorChange,
}: {
  data: GetResumeResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  // Ticket 3f0883f review fix: passthrough to ResultCard, which now
  // supplies `resumeId` itself (from `result.resumeId`) -- see that
  // component's own doc comment on this prop.
  onSetStatus: (jobId: string, status: UserJobStatus, resumeId: string) => Promise<void>;
  onClearStatus: (jobId: string) => Promise<void>;
  /** Ticket 1e183a4: passthrough to ResultCard -- see its own doc comment. */
  onViewResume: (resumeId: string) => void;
  /**
   * Ticket 931df8a: App.tsx's single hoisted `MagicLinkPrompt` instance is
   * `createPortal`-ed into the DOM node this ref callback hands back, which
   * sits right after the first visible `ResultCard` (see the marker `<li>`
   * below). That gets the card out of `position: fixed` and into document
   * flow, adjacent to results, WITHOUT giving it a second mount point --
   * `createPortal` relocates only the rendered DOM, not the component's
   * position in the React tree, so the portaled component's local state
   * (`dismissed`/`email`/`phase`) survives exactly as it did when the host
   * was a fixed sibling of `.app` (ticket d0a7074's whole reason for one
   * instance). Optional because every other caller of this list (its own
   * test file included) has no such anchor to offer.
   */
  onFirstResultAnchorChange?: (node: HTMLLIElement | null) => void;
}) {
  // Ticket b182bde: opt-in, DEFAULT-OFF client-side filter on already-
  // fetched results, same pattern as `selectedSourceIds` above -- never a
  // silent server-side drop (both of Nicole's real applied-to postings are
  // in the "overqualified" bucket; hiding them by default would have hidden
  // her own real choices). Local state, not lifted to a caller prop:
  // nothing else in the app needs to know this filter is on, unlike
  // `selectedSourceIds`, which is also scoped by the search flow.
  const [hideOverqualified, setHideOverqualified] = useState(false);
  // Ticket a340074: symmetric opt-in filter for the OTHER levelFit value --
  // same DEFAULT-OFF reasoning as hideOverqualified (never silently drop a
  // job the resume's own scoring flagged, only hide on explicit request).
  // Nicole, live, once the overqualified toggle's wording was fixed: "why
  // doesn't that also exist" -- there was no principled reason it shouldn't,
  // just that only one direction had been asked for originally.
  const [hideUnderqualified, setHideUnderqualified] = useState(false);
  // Ticket 8f5a79c: second, independent opt-in client-side filter, same
  // pattern as `hideOverqualified` above. DEFAULT-OFF/unchecked, per
  // Nicole's explicit "just another job to apply for" framing (git-bug
  // 8f5a79c correction) -- contract/temp postings are shown by default,
  // this checkbox is for hiding them if she wants to, never an opt-in gate.
  const [hideContractOrTemp, setHideContractOrTemp] = useState(false);

  const bySource = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const overqualifiedCount = bySource.filter((r) => r.levelFit === "overqualified").length;
  const underqualifiedCount = bySource.filter((r) => r.levelFit === "underqualified").length;
  const contractOrTempCount = bySource.filter((r) => r.isContractOrTemp).length;
  // Ticket a340074: filters applied SEQUENTIALLY (source -> overqualified ->
  // underqualified -> contract/temp), each producing its own "hidden by this
  // step" count as the delta from the PREVIOUS step, not from `bySource`
  // independently of the other filters -- extends ticket 8f5a79c's same
  // telescoping design to a fourth stage. This is what keeps every
  // simultaneously-active filter honest in the summary text below:
  // `hiddenBySourceToggle + hiddenByOverqualifiedFilter +
  // hiddenByUnderqualifiedFilter + hiddenByContractFilter` telescopes
  // exactly to `data.results.length - visible.length`, so a job hidden by
  // MULTIPLE filters is never counted twice (it's "claimed" by whichever
  // stage actually removed it). The CHECKBOX LABEL counts
  // (`overqualifiedCount`/`underqualifiedCount`/`contractOrTempCount` above)
  // deliberately do NOT use this same post-other-filter set — each is
  // computed straight off `bySource`, independent of every OTHER checkbox's
  // state, so checking one filter's box never makes a DIFFERENT box's own
  // displayed count jump around. The two kinds of number answer different
  // questions on purpose: the label says "how many roles like this exist in
  // your source-filtered results," the summary sentence says "how many did
  // this specific filter actually just hide."
  const afterOverLevel = hideOverqualified
    ? bySource.filter((r) => r.levelFit !== "overqualified")
    : bySource;
  const afterUnderLevel = hideUnderqualified
    ? afterOverLevel.filter((r) => r.levelFit !== "underqualified")
    : afterOverLevel;
  const visible = hideContractOrTemp
    ? afterUnderLevel.filter((r) => !r.isContractOrTemp)
    : afterUnderLevel;
  const hiddenBySourceToggle = data.results.length - bySource.length;
  const hiddenByOverqualifiedFilter = bySource.length - afterOverLevel.length;
  const hiddenByUnderqualifiedFilter = afterOverLevel.length - afterUnderLevel.length;
  const hiddenByContractFilter = afterUnderLevel.length - visible.length;

  // Ticket a340074: extends ticket 8f5a79c's (itself extending b182bde's
  // F1b) empty-state fix to a FOURTH filter. `bySource.length === 0` is the
  // only case that's genuinely about source selection; everything else with
  // `visible.length === 0` means one or more of the three hide-toggles
  // emptied an otherwise non-empty source-filtered set, and the message must
  // name the toggle(s) actually responsible rather than falling back to the
  // source-selection message (which would be false — the jobs DO match the
  // selected sources).
  let emptyStateMessage: string | null = null;
  if (bySource.length === 0) {
    emptyStateMessage = "No jobs match the current source selection.";
  } else if (visible.length === 0) {
    if (afterOverLevel.length === 0) {
      // The overqualified filter alone already emptied the source-filtered
      // set — true regardless of whether the other filters are ALSO
      // checked, since their own marginal contribution here is necessarily
      // 0 (there was nothing left for them to remove).
      emptyStateMessage =
        'Every job from the selected sources is one you may be overqualified for — uncheck "Hide roles I\'m overqualified for" to see them.';
    } else if (afterUnderLevel.length === 0) {
      // afterOverLevel.length > 0 here, so the underqualified filter is what
      // emptied the remainder. Names the overqualified filter too when it
      // already narrowed the set on the way there.
      emptyStateMessage = hideOverqualified
        ? 'Every remaining job (after hiding roles you may be overqualified for) is one you may be underqualified for — uncheck "Hide roles I\'m underqualified for" to see them.'
        : 'Every job from the selected sources is one you may be underqualified for — uncheck "Hide roles I\'m underqualified for" to see them.';
    } else if (hideContractOrTemp) {
      // afterUnderLevel.length > 0 here, so the contract filter is what
      // emptied the remainder. Names whichever of the two level filters
      // already narrowed the set on the way there, so the message doesn't
      // imply they did nothing when one or both may have removed jobs
      // upstream.
      const leveledClauses = [
        hideOverqualified ? "overqualified" : null,
        hideUnderqualified ? "underqualified" : null,
      ].filter((c): c is string => c !== null);
      emptyStateMessage =
        leveledClauses.length > 0
          ? `Every remaining job (after hiding roles you may be ${leveledClauses.join(" or ")} for) is contract/temp — uncheck "Hide contract/temp roles" to see them.`
          : 'Every job from the selected sources is contract/temp — uncheck "Hide contract/temp roles" to see them.';
    }
  }

  return (
    <div className="results-list">
      <p className="results-summary">
        {emptyStateMessage ??
          `Showing ${visible.length} of ${data.results.length} scored jobs from the sources you've selected` +
            // Ticket d90d7dd (Jay's 2nd round of testing, relayed by
            // Nicole): the below-floor count used to live in its OWN
            // paragraph below this one. A real run of his ("Showing 5 of
            // 5... [separate paragraph] 201 more scored below the
            // floor...") read as two unrelated facts, not cause and
            // effect -- there was nothing on the "5 of 5" line to tell him
            // that's WHY he only saw 5 out of a 206-job search. Folded in
            // here as a semicolon-joined independent clause of the SAME
            // sentence, placed BEFORE the toggle/level/contract clauses
            // below, and deliberately NOT one of their trailing "(N hidden
            // by ...)" parentheses -- the judgement call the ticket asks
            // for an explicit argument on:
            //
            // Those parenthetical clauses explain a PARTIAL gap between
            // two numbers already stated in the sentence -- a handful of
            // an otherwise-meaningful "N of N" quietly peeled off by a
            // minor, reversible, opt-in filter ("(2 hidden by source
            // toggles.)"). The floor is a different kind of gap: in Jay's
            // report BOTH numbers in "Showing 5 of 5" were tiny next to
            // what was actually scored (206), and neither number hints at
            // that -- 201 of 206 were never in play for either count. A
            // footnote-weight parenthetical after three OTHER possible
            // footnotes would still bury the one fact that explains the
            // whole sentence, so it reads as a first-class clause instead,
            // ahead of the lesser clauses.
            //
            // Guarded on `> 0`, NOT `!== undefined`. This DEPARTS from ticket
            // 484889d's "always shown, even at 0" decision, deliberately, and
            // the departure is the point: that decision was made when this
            // was a STANDALONE PARAGRAPH, where "0 more jobs scored below the
            // match-quality floor and are not shown" is a slightly odd but
            // self-contained statement, and where staying silent really was
            // indistinguishable from the field being absent.
            //
            // Merging it into the summary sentence changes that. At 0 the
            // sentence becomes "Showing 2 of 2 scored jobs from the sources
            // you've selected; 0 more jobs scored below the match-quality
            // floor and are not shown." -- which spends the most-read
            // sentence on the page explaining the absence of a gap, in the
            // exact slot ticket d90d7dd added to explain a gap. Nicole's
            // instruction was to make the 201 explain the 5; there is nothing
            // to explain when the number is 0.
            //
            // And 484889d's own justification does not survive the move: the
            // distinction it protects -- field-absent versus field-is-zero --
            // is visible only to someone reading the API response. To a
            // reader of this sentence both mean "nothing was hidden", so
            // saying it adds a clause and no information. The standalone
            // paragraph in the empty-state branch below is untouched, so the
            // all-hidden case still states its count point-blank.
            (data.hiddenBelowFloor !== undefined && data.hiddenBelowFloor > 0
              ? `; ${data.hiddenBelowFloor} more job${
                  data.hiddenBelowFloor === 1 ? "" : "s"
                } scored below the match-quality floor and ${
                  data.hiddenBelowFloor === 1 ? "is" : "are"
                } not shown.`
              : ".") +
            // Only worth stating when it's a PARTIAL hide — if visible.length
            // is already 0, `emptyStateMessage` above already says
            // everything is hidden; repeating the count here would be
            // redundant, not additionally informative.
            (hiddenBySourceToggle > 0
              ? ` (${hiddenBySourceToggle} hidden by source toggles.)`
              : "") +
            // Ticket b182bde review (F1a): the level filters are a SEPARATE
            // hiding mechanism from source toggles and need their own
            // clauses, or a partial level-filter hide reads as fully
            // unexplained (e.g. 20 of 25, checkbox on, 5 overqualified --
            // old text blamed source toggles for zero of the missing 5).
            (hiddenByOverqualifiedFilter > 0
              ? ` (${hiddenByOverqualifiedFilter} hidden as maybe overqualified.)`
              : "") +
            // Ticket a340074: symmetric clause for the new underqualified
            // filter, telescoped off `afterOverLevel` so a job already
            // claimed by the overqualified filter is never double-counted.
            (hiddenByUnderqualifiedFilter > 0
              ? ` (${hiddenByUnderqualifiedFilter} hidden as maybe underqualified.)`
              : "") +
            // Ticket 8f5a79c: independent clause, same reasoning —
            // `hiddenByContractFilter` is telescoped off `afterUnderLevel`,
            // not `bySource`, so this never double-counts a job either level
            // filter already removed.
            (hiddenByContractFilter > 0
              ? ` (${hiddenByContractFilter} contract/temp hidden.)`
              : "")}
      </p>
      {/* Ticket b182bde: the count is shown regardless of whether the
          checkbox is checked -- same pattern as the "(N hidden by source
          toggles.)" text above.
          Ticket 8c252ff: label reworded from "Hide roles above my level" --
          that phrasing was backwards, not just ambiguous. This checkbox
          filters `levelFit === "overqualified"` -- the CANDIDATE exceeds
          what the job needs, so the JOB is below the candidate's level, not
          above it. "Hide roles I'm overqualified for" states what the
          checkbox actually does without relying on "above/below" at all. */}
      <label className="hide-overqualified-toggle">
        <input
          type="checkbox"
          checked={hideOverqualified}
          onChange={() => setHideOverqualified((v) => !v)}
        />
        Hide roles I'm overqualified for ({overqualifiedCount})
      </label>
      {/* Ticket a340074: symmetric toggle for the other `levelFit` value --
          same "count always shown" convention. Nicole asked for this
          directly once the overqualified toggle's wording was fixed, for
          consistency: there was no principled reason only one direction of
          level mismatch had a hide option. */}
      <label className="hide-underqualified-toggle">
        <input
          type="checkbox"
          checked={hideUnderqualified}
          onChange={() => setHideUnderqualified((v) => !v)}
        />
        Hide roles I'm underqualified for ({underqualifiedCount})
      </label>
      {/* Ticket 8f5a79c: same "count always shown" convention as the level
          filters above. */}
      <label className="hide-contract-toggle">
        <input
          type="checkbox"
          checked={hideContractOrTemp}
          onChange={() => setHideContractOrTemp((v) => !v)}
        />
        Hide contract/temp roles ({contractOrTempCount})
      </label>
      {/* Ticket d90d7dd: this standalone paragraph now renders ONLY in the
          `emptyStateMessage` branch above -- the normal (non-empty)
          branch folds this same count into the `results-summary` sentence
          instead (see that comment for why). When `emptyStateMessage` is
          set, it has already REPLACED the "Showing N of N" sentence
          entirely, so there is no sentence left to fold this into -- but
          `hiddenBelowFloor` is still real, independent information (it
          was excluded from `data.results` before source toggles or any
          of the three hide-filters ever ran), so it still needs to render
          somewhere rather than silently disappearing just because some
          OTHER mechanism also emptied `visible`. This is also exactly
          what keeps the all-hidden case from producing "Showing 0 of 0 …
          and 201 more" alongside `emptyStateMessage` -- that malformed
          sentence simply never gets constructed, because the "Showing"
          template literal above is never the branch taken here. */}
      {emptyStateMessage !== null && data.hiddenBelowFloor !== undefined && (
        <p className="results-hidden-floor">
          {data.hiddenBelowFloor} more job{data.hiddenBelowFloor === 1 ? "" : "s"} scored below the
          match-quality floor and {data.hiddenBelowFloor === 1 ? "is" : "are"} not shown.
        </p>
      )}
      {/* Ticket e9a82f3 (opus review fix): only rendered when the server's
          LIMIT actually truncated the matching rows -- untruncated
          responses never carry `totalMatchingCount`, so this never appears
          when everything that matched is already in `data.results`.
          Deliberately NOT worded "Showing X of Y" -- the `results-summary`
          paragraph above already uses "Showing" to mean "rendered after
          client-side source/level/contract filters", and reusing the verb
          here (for "fetched from the server" instead) produced two
          adjacent sentences with contradictory numbers for the same word. */}
      {data.totalMatchingCount !== undefined && (
        <p className="results-truncated">
          Only the top {data.results.length} of {data.totalMatchingCount} matching jobs were loaded.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="result-cards">
          {visible.map((result, index) => (
            <Fragment key={result.jobId}>
              <ResultCard
                result={result}
                onSetStatus={onSetStatus}
                onClearStatus={onClearStatus}
                onViewResume={onViewResume}
              />
              {/* Ticket 931df8a: the portal target, immediately after the
                  TOPMOST result -- never above it, and never pushed all the
                  way to the end of a list that (per ticket d3a95d1) can run
                  long enough that "inline at the end" was "never reached in
                  practice". `role="presentation"` strips the implicit
                  `listitem` role so a screen reader doesn't count the
                  sign-in prompt as one of the N results in this list -- the
                  form inside keeps its own real semantics (heading, inputs)
                  regardless. Only rendered when a caller actually wants the
                  anchor (App.tsx); every other caller, including this
                  component's own test file, renders nothing extra here.

                  MUST stay self-closing -- no React children. App.tsx's
                  `appendChild` effect attaches `magicLinkPortalRoot` to
                  this exact DOM node OUTSIDE React, which is only
                  invisible to React because React itself renders nothing
                  inside this `<li>` to reconcile. Give it real children
                  here and the next render's reconciliation diffs this
                  node's children against what THIS component rendered --
                  which won't include the portal root -- and can drop it. */}
              {index === 0 && onFirstResultAnchorChange && (
                <li
                  className="magic-link-prompt-anchor"
                  role="presentation"
                  ref={onFirstResultAnchorChange}
                />
              )}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
