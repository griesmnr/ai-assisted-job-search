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

/**
 * Ticket 09b8e4d, follow-up from d1fc9e2's Scope section: d1fc9e2 fixed
 * USAJOBS to actually search on whatever title chips exist, which made the
 * real gap concrete -- a private-sector resume's inferred titles ("Software
 * Engineer", "Backend Engineer", ticket 39b4a48) will never contain OPM
 * job-series names, so a user relying on resume-inferred chips alone misses
 * federal postings entirely even though the fetch itself is correct. This
 * is a fixed list, not resume-derived guessing (explicitly out of scope --
 * inferring federal-equivalent titles from arbitrary resume content is
 * speculative NLP the ticket doesn't ask for).
 */
export const FEDERAL_TITLE_SUGGESTIONS = ["Program Analyst", "IT Specialist", "Computer Scientist"];

export function SearchCriteriaForm({
  titleChips,
  nearLocations,
  remoteOk,
  anyLocationOk,
  commitmentIn,
  showFederalTitleSuggestions,
  locationSectionRef,
  onTitleChipsChange,
  onChange,
}: {
  titleChips: string[];
  nearLocations: string;
  remoteOk: boolean;
  /** Ticket b9e6251: the explicit "I'll work anywhere" opt-in -- see this
   * component's own `search-criteria-location-warning` paragraph below for
   * why this exists as a real, separate field rather than just letting
   * `nearLocations`/`remoteOk` both being empty silently mean the same
   * thing. */
  anyLocationOk: boolean;
  commitmentIn: ("full-time" | "part-time" | "contract")[];
  /** Ticket 09b8e4d: whether USAJOBS is among the currently-selected
   * sources. This component stays "dumb" about source IDs -- App.tsx is the
   * one place that knows `"usajobs"` is a source ID, this just gets told
   * yes/no whether to show the federal suggestions. */
  showFederalTitleSuggestions: boolean;
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
  onTitleChipsChange: (next: string[]) => void;
  onChange: (next: {
    nearLocations: string;
    remoteOk: boolean;
    anyLocationOk: boolean;
    commitmentIn: ("full-time" | "part-time" | "contract")[];
  }) => void;
}) {
  const [newChipText, setNewChipText] = useState("");

  function removeChip(chip: string) {
    onTitleChipsChange(titleChips.filter((c) => c !== chip));
  }

  // Shared by the manual "Add a job title keyword" input and the federal
  // suggestion buttons below -- both are just "put this exact string into
  // titleChips", so both get the same case-insensitive de-dupe rather than
  // risking the two paths drifting apart.
  function addTitle(title: string) {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    // Case-insensitive de-dupe: adding "Software Engineer" when it's
    // already there (from suggestions or a prior add) should not produce
    // two visually-identical chips.
    if (titleChips.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
    onTitleChipsChange([...titleChips, trimmed]);
  }

  function addChip() {
    addTitle(newChipText);
    setNewChipText("");
  }

  function hasChip(title: string) {
    return titleChips.some((c) => c.toLowerCase() === title.toLowerCase());
  }

  function set(
    patch: Partial<{
      nearLocations: string;
      remoteOk: boolean;
      anyLocationOk: boolean;
      commitmentIn: ("full-time" | "part-time" | "contract")[];
    }>,
  ) {
    onChange({ nearLocations, remoteOk, anyLocationOk, commitmentIn, ...patch });
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
      {showFederalTitleSuggestions && (
        // Ticket 09b8e4d: distinct from the resume-inferred chips above --
        // these are never auto-added to titleChips (same "suggest, don't
        // silently default" principle ticket 39b4a48 already established),
        // they only appear while USAJOBS is selected, and clicking one goes
        // through the exact same `addTitle` de-dupe path as the manual
        // input, so re-clicking an already-added suggestion is a no-op
        // rather than a duplicate chip. Buttons for already-added titles
        // are disabled rather than removed, so the row doesn't reflow and a
        // user can see at a glance which of the three they've already
        // taken.
        <div className="federal-title-suggestions">
          <p className="search-criteria-hint">
            USAJOBS uses federal job-series titles that don't overlap much with private-sector
            phrasing — click to add any that fit:
          </p>
          <ul className="federal-title-suggestion-list" aria-label="Suggested federal job titles">
            {FEDERAL_TITLE_SUGGESTIONS.map((title) => (
              <li key={title}>
                <button
                  type="button"
                  className="federal-title-suggestion"
                  onClick={() => addTitle(title)}
                  disabled={hasChip(title)}
                >
                  + {title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Ticket 371713d: this whole block is what "Estimate search cost"
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
            want, or add a commute location / remote above. Estimating is disabled until one of
            these is set.
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
