import { useState, type RefObject } from "react";
import { splitPhrases } from "../criteriaText";

/**
 * Editable title-keyword chips + the two remaining plain-text criteria
 * fields (ticket 39b4a48, superseding ticket 957bc22's title-include/
 * title-exclude text fields).
 *
 * Nicole, live: "I don't want any default software engineering role text
 * there... Based on your resume, we think these job titles would be good.
 * And then it can be kind of like keywords where they can click to X them
 * off, or they can add their own. And then we don't have to have the
 * include and exclude button." `titleChips` arrives pre-populated from
 * `POST /resumes`'s real, resume-grounded `suggestedTitles` (App.tsx) —
 * this component only ever edits the set (remove a chip, add a new one),
 * it never invents a default of its own. There is deliberately no
 * title-EXCLUDE control anymore; `SearchCriteria.titleExclude` stays
 * supported by the backend, just unused by this form.
 *
 * Deliberately "dumb" like its predecessor: owns no criteria-shaping
 * logic, just reports the current chip set up to App.tsx, which is the
 * one place that decides what becomes the actual `SearchCriteria` sent to
 * the API (see App.tsx's `buildSearchCriteria` — and its critical
 * "titleChips.length === 0 still sends a REAL empty criteria object,
 * never falls back to a hidden default" rule).
 */
const COMMITMENT_OPTIONS: { value: "full-time" | "part-time" | "contract"; label: string }[] = [
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "contract", label: "Contract" },
];

export function SearchCriteriaForm({
  titleChips,
  nearLocations,
  expandMetroAreas,
  remoteOk,
  anyLocationOk,
  commitmentIn,
  locationSectionRef,
  locationWarnings,
  onTitleChipsChange,
  onChange,
}: {
  titleChips: string[];
  nearLocations: string;
  /** Ticket 410e1a2: the explicit "also count nearby cities in the same
   * metro area" opt-in. Off by default and deliberately NOT part of the
   * `hasLocationSignal` check below -- it widens the locations typed above
   * rather than being a location signal of its own, so checking it with an
   * empty location box must not unlock the estimate. */
  expandMetroAreas: boolean;
  remoteOk: boolean;
  /** Ticket b9e6251: the explicit "I'll work anywhere" opt-in -- see this
   * component's own `search-criteria-location-warning` paragraph below for
   * why this exists as a real, separate field rather than just letting
   * `nearLocations`/`remoteOk` both being empty silently mean the same
   * thing. */
  anyLocationOk: boolean;
  commitmentIn: ("full-time" | "part-time" | "contract")[];
  /** Ticket 371713d: a plain ref object, lifted to and owned by App.tsx
   * (the coordinator between this component and its SIBLING `SearchFlow`),
   * attached to the DOM node wrapping the location input/checkboxes below.
   * App.tsx hands the SAME ref object to `SearchFlow` indirectly, via an
   * `onInvalidEstimateAttempt` callback that calls
   * `locationSectionRef.current?.scrollIntoView(...)` -- that is the "some
   * cross-component mechanism" this ticket's Notes flagged as needed,
   * chosen over e.g. a global DOM id/querySelector because it keeps the
   * link typed and keeps App.tsx (which already coordinates every other
   * cross-sibling interaction in this file -- onEstimateStart,
   * onSearchComplete, etc.) as the one place that knows about it. Optional
   * so every other existing caller/test (none of which care about
   * scrolling) keeps working unchanged. */
  locationSectionRef?: RefObject<HTMLDivElement | null>;
  /** Ticket e5e1aa1 review round 2 (D8/Required 4): the reasons the most
   * recent estimate's "include nearby cities" expansion could not resolve
   * one or more typed locations -- e.g. "Boston" exists in GA, IN and MA
   * and needs a state added. Comes from
   * `EstimateSearchResponse.locationWarnings` via App.tsx's
   * `onEstimateReady` (SearchFlow.tsx) -- a plain string array, not a prop
   * this component derives itself, same as every other value here.
   * Optional/defaulted to `[]` so every existing caller/test keeps working
   * unchanged. Rendered directly under the checkbox that produced it,
   * rather than only logged server-side, which is the actual fix for this
   * ticket's acceptance criterion ("reported to the user", not to an
   * operator's terminal). */
  locationWarnings?: string[];
  onTitleChipsChange: (next: string[]) => void;
  onChange: (next: {
    nearLocations: string;
    expandMetroAreas: boolean;
    remoteOk: boolean;
    anyLocationOk: boolean;
    commitmentIn: ("full-time" | "part-time" | "contract")[];
  }) => void;
}) {
  const [newChipText, setNewChipText] = useState("");

  function removeChip(chip: string) {
    onTitleChipsChange(titleChips.filter((c) => c !== chip));
  }

  // Ticket 8a403ee: used to also back a row of federal-title suggestion
  // buttons (removed -- those titles are folded into `titleChips`
  // directly now, at resume-submission time, App.tsx). Still the one
  // place a title gets added, case-insensitively de-duped against
  // whatever's already there, so a manual add can never produce a
  // visually-identical duplicate chip.
  function addTitle(title: string) {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    if (titleChips.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
    onTitleChipsChange([...titleChips, trimmed]);
  }

  function addChip() {
    addTitle(newChipText);
    setNewChipText("");
  }

  function set(
    patch: Partial<{
      nearLocations: string;
      expandMetroAreas: boolean;
      remoteOk: boolean;
      anyLocationOk: boolean;
      commitmentIn: ("full-time" | "part-time" | "contract")[];
    }>,
  ) {
    onChange({ nearLocations, expandMetroAreas, remoteOk, anyLocationOk, commitmentIn, ...patch });
  }

  // Ticket b9e6251: leaving BOTH `nearLocations` and `remoteOk` empty used
  // to mean "no location restriction, search anywhere" -- exactly the
  // kind of silent, never-explicitly-chosen default Nicole's own principle
  // already rejected for title keywords and the staff-level exclusion:
  // "I'd rather have it be a really expensive search offered than a blind
  // default." A real location restriction is present the instant EITHER
  // field has content; only the fully-empty case needs the explicit
  // `anyLocationOk` opt-in. Uses the shared `splitPhrases` (opus review
  // F3), same as App.tsx's identical `hasLocationSignal` check -- a plain
  // `.trim().length > 0` test would treat a lone "," as a real signal.
  const hasLocationSignal = splitPhrases(nearLocations).length > 0 || remoteOk || anyLocationOk;

  function toggleCommitment(value: "full-time" | "part-time" | "contract", checked: boolean) {
    set({
      commitmentIn: checked ? [...commitmentIn, value] : commitmentIn.filter((c) => c !== value),
    });
  }

  return (
    <div className="search-criteria-form">
      <p className="search-criteria-hint">
        {titleChips.length > 0
          ? "Based on your resume, we think these job titles would be good. Remove any that don't fit, or add your own."
          : "No title keywords yet — add your own, or leave this empty to search every title."}
      </p>
      {/* Ticket 8a403ee (Nicole, dogfooding: the old separate "click to add"
          federal-title row risked someone missing it entirely -- "you
          never know if somebody's going to zone out"), then ticket 5c4242d:
          8a403ee originally folded a FIXED trio ("Program Analyst"/"IT
          Specialist"/"Computer Scientist") into `titleChips` at
          resume-submission time regardless of the resume's field --
          5c4242d deleted that frontend mechanism entirely (App.tsx no
          longer appends anything). `titleChips` is now exactly
          `suggestedTitles`, so any federal job-series title present here
          was derived by resume-title-inference.ts FOR this resume's own
          field (ticket 17a5c8f) -- this note just explains why an
          unfamiliar-looking title might be sitting in the list below, same
          as it did before, for a different underlying reason. Rendered
          unconditionally (not gated on titleChips actually containing a
          federal title, or on which sources are selected) -- it's a
          general explanation of why a chip might look unfamiliar, not a
          per-resume guarantee that one is present; narrower gating (e.g. on
          USAJOBS being configured at all) is ticket 99b6b25's question, not
          this one's. Wording is a starting point, not final copy --
          Nicole's own words: "we can work on the language together." */}
      <p className="search-criteria-hint">
        A few title variations some employers use — like USAJOBS' federal job titles — are included
        automatically.
      </p>
      <ul className="title-chip-list" aria-label="Job title keywords">
        {titleChips.map((chip) => (
          <li key={chip} className="title-chip">
            <span>{chip}</span>
            <button
              type="button"
              className="title-chip-remove"
              aria-label={`Remove "${chip}"`}
              onClick={() => removeChip(chip)}
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
      <div className="title-chip-add">
        <label htmlFor="add-title-chip">Add a job title keyword</label>
        <div className="title-chip-add-row">
          <input
            id="add-title-chip"
            type="text"
            value={newChipText}
            placeholder="e.g. backend engineer"
            onChange={(e) => setNewChipText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addChip();
              }
            }}
          />
          <button type="button" onClick={addChip} disabled={newChipText.trim().length === 0}>
            Add
          </button>
        </div>
      </div>
      {/* Ticket 371713d: this whole block is what "Get estimate"
          (SearchFlow, a SIBLING component) scrolls into view when clicked
          with no location signal set -- see `locationSectionRef`'s own doc
          comment above. Grouping the text input, both location checkboxes,
          AND the text warning under one ref means a single scroll always
          brings every red-highlighted field on screen together, rather
          than picking just one of them and risking the other still being
          off-screen. */}
      <div ref={locationSectionRef} className="search-criteria-location-section">
        <label className="search-criteria-field">
          Locations you'd commute to (comma-separated)
          <input
            type="text"
            value={nearLocations}
            placeholder="e.g. seattle, bellevue"
            onChange={(e) => set({ nearLocations: e.target.value })}
            // Ticket 371713d, Nicole: "I really want to force the issue
            // because I don't read text on sites" -- a strong, hard-to-miss
            // visual cue instead of (not in addition to needing) the text
            // warning below. Reactive to the exact same `hasLocationSignal`
            // the warning already uses, so it clears the instant either
            // this field or "Any location" below gains a real signal.
            className={hasLocationSignal ? undefined : "search-criteria-input-invalid"}
            aria-invalid={!hasLocationSignal}
          />
        </label>
        {/* Ticket 410e1a2, redesigned by ticket e5e1aa1. Sits directly under
            the location box because it only ever modifies what is typed
            there. Nicole raised both sides of this herself -- some
            searchers want "Seattle" to also mean nearby cities, others
            would be annoyed by an unrequested Kirkland commute -- and
            settled it as a visible opt-in: "I think it'll just be a check,
            a checkbox or something like that... I want it given that it
            meets both users' needs as long as it can be seen." So: off by
            default, and the label says what it will actually do.
            Ticket e5e1aa1 replaced the original curated-metro-table version
            of this label (which named Seattle's own siblings by name, and
            silently did nothing for any other city -- the bug that ticket
            fixes) with the generic distance claim every typed city now
            actually gets: see apps/api/src/sources/metroAreas.ts for the
            60-mile radius, why 60 and not 50, and the straight-line-is-not-
            driving caveat this text deliberately echoes rather than hides.
            Review round 2 (Required 5): the first version of this text
            promised the 60-mile match UNCONDITIONALLY, which is false for a
            location that can't resolve -- a bare city whose name exists in
            more than one state ("Austin", "Boston", "Denver", "Portland" --
            four of the eight cities the ticket's own bug report names) does
            NOT get expanded, same as one absent from the dataset entirely.
            "that resolves" below is the honest qualifier; `locationWarnings`
            just under the checkbox is where a non-resolving location is
            actually named, so this label does not have to enumerate every
            failure mode itself. */}
        <label className="search-criteria-checkbox">
          <input
            type="checkbox"
            checked={expandMetroAreas}
            onChange={(e) => set({ expandMetroAreas: e.target.checked })}
          />
          Also include nearby cities — matches postings within 60 miles (straight-line, not driving
          distance) of each location above that resolves; some place names need a state added to
          resolve (we'll say so below if so)
        </label>
        {locationWarnings && locationWarnings.length > 0 && (
          <ul className="search-criteria-location-expansion-warnings" role="alert">
            {locationWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <label className="search-criteria-checkbox">
          <input
            type="checkbox"
            checked={remoteOk}
            onChange={(e) => set({ remoteOk: e.target.checked })}
          />
          Also show fully remote roles
        </label>
        <label
          className={
            hasLocationSignal
              ? "search-criteria-checkbox"
              : "search-criteria-checkbox search-criteria-checkbox-invalid"
          }
        >
          <input
            type="checkbox"
            checked={anyLocationOk}
            onChange={(e) => set({ anyLocationOk: e.target.checked })}
            aria-invalid={!hasLocationSignal}
          />
          Any location — I'm open to relocating or working anywhere
        </label>
        {!hasLocationSignal && (
          <p className="search-criteria-location-warning" role="alert">
            No location restriction is set. Leaving this blank means every real posting could match
            regardless of where it is — check "Any location" above if that's genuinely what you
            want, or add a commute location / remote above. Estimating won't work until one of these
            is set.
          </p>
        )}
      </div>
      <fieldset className="search-criteria-commitment">
        <legend>
          {commitmentIn.length > 0
            ? "Only show these commitment types"
            : "Commitment type (leave unchecked for no restriction)"}
        </legend>
        {COMMITMENT_OPTIONS.map(({ value, label }) => (
          <label key={value} className="search-criteria-checkbox">
            <input
              type="checkbox"
              checked={commitmentIn.includes(value)}
              onChange={(e) => toggleCommitment(value, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
