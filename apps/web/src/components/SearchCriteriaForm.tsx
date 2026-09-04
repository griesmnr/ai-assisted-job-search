/**
 * Raw-text editing for the four `SearchCriteria` fields (ticket 957bc22).
 * Deliberately "dumb": this component owns no state and computes nothing
 * itself — it just renders controlled inputs and reports every keystroke
 * up to App.tsx, which owns the raw text and derives the actual
 * `SearchCriteria | undefined` (see App.tsx's `buildSearchCriteria`).
 * Keeping the undefined-vs-empty-object judgment call in ONE place
 * (App.tsx) rather than duplicating it here is deliberate — see that
 * function's own doc comment for why it matters.
 *
 * Each of titleInclude/titleExclude/nearLocations is edited as one plain
 * comma-separated text field rather than a tag-input widget — simplest
 * thing that could work, and `apps/api/src/sources/criteria.ts`'s
 * `compileFilter` already expects `string[]`, so splitting happens once,
 * in App.tsx, not per-keystroke here.
 */
export function SearchCriteriaForm({
  titleInclude,
  titleExclude,
  nearLocations,
  remoteOk,
  onChange,
}: {
  titleInclude: string;
  titleExclude: string;
  nearLocations: string;
  remoteOk: boolean;
  onChange: (next: {
    titleInclude: string;
    titleExclude: string;
    nearLocations: string;
    remoteOk: boolean;
  }) => void;
}) {
  function set(patch: Partial<Parameters<typeof onChange>[0]>) {
    onChange({ titleInclude, titleExclude, nearLocations, remoteOk, ...patch });
  }

  return (
    <div className="search-criteria-form">
      <p className="search-criteria-hint">
        Leave everything blank to use the default software-engineering filter. Fill in anything
        below to narrow it your way instead.
      </p>
      <label className="search-criteria-field">
        Job titles to include (comma-separated)
        <input
          type="text"
          value={titleInclude}
          placeholder="e.g. backend, platform engineer"
          onChange={(e) => set({ titleInclude: e.target.value })}
        />
      </label>
      <label className="search-criteria-field">
        Job titles to exclude (comma-separated)
        <input
          type="text"
          value={titleExclude}
          placeholder="e.g. staff, principal"
          onChange={(e) => set({ titleExclude: e.target.value })}
        />
      </label>
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
