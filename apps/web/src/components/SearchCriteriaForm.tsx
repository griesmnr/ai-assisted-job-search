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
export function SearchCriteriaForm({
  titleChips,
  nearLocations,
  remoteOk,
  onTitleChipsChange,
  onChange,
}: {
  titleChips: string[];
  nearLocations: string;
  remoteOk: boolean;
  onTitleChipsChange: (next: string[]) => void;
  onChange: (next: { nearLocations: string; remoteOk: boolean }) => void;
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

  function set(patch: Partial<{ nearLocations: string; remoteOk: boolean }>) {
    onChange({ nearLocations, remoteOk, ...patch });
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
    </div>
  );
}
