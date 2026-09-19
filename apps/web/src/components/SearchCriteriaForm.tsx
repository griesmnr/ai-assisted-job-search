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
  remoteOk,
  anyLocationOk,
  commitmentIn,
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
      {/* Ticket 8a403ee (Nicole, dogfooding: the old separate "click to add"
          federal-title row risked someone missing it entirely -- "you
          never know if somebody's going to zone out"). A few title
          variations some employers phrase differently (USAJOBS' federal
          job-series names among them) are now folded directly into
          `titleChips` at resume-submission time (App.tsx), same as any
          resume-inferred chip -- this is just the explanatory note for why
          an unfamiliar-looking title might be sitting in the list below.
          Deliberately unconditional (not gated on which sources are
          selected): the chips themselves no longer are either, per
          Nicole's explicit "I don't want to build all the functionality
          for" toggle-state tracking. Wording is a starting point, not
          final copy -- her own words: "we can work on the language
          together." */}
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
