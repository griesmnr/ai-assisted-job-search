import { useState } from "react";

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

  function addChip() {
    const trimmed = newChipText.trim();
    if (trimmed.length === 0) return;
    // Case-insensitive de-dupe: adding "Software Engineer" when it's
    // already there (from suggestions or a prior add) should not produce
    // two visually-identical chips.
    if (titleChips.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      setNewChipText("");
      return;
    }
    onTitleChipsChange([...titleChips, trimmed]);
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
  // `anyLocationOk` opt-in.
  const hasLocationSignal = nearLocations.trim().length > 0 || remoteOk || anyLocationOk;

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
      <label className="search-criteria-field">
        Locations you'd commute to (comma-separated)
        <input
          type="text"
          value={nearLocations}
          placeholder="e.g. seattle, bellevue"
          onChange={(e) => set({ nearLocations: e.target.value })}
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
      <label className="search-criteria-checkbox">
        <input
          type="checkbox"
          checked={anyLocationOk}
          onChange={(e) => set({ anyLocationOk: e.target.checked })}
        />
        Any location — I'm open to relocating or working anywhere
      </label>
      {!hasLocationSignal && (
        <p className="search-criteria-location-warning" role="alert">
          No location restriction is set. Leaving this blank means every real posting could match
          regardless of where it is — check "Any location" above if that's genuinely what you want,
          or add a commute location / remote above. Estimating is disabled until one of these is
          set.
        </p>
      )}
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
