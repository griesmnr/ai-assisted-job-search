import type { SourceHealth } from "@app/shared";

/**
 * The airline-style toggle set (ticket 484889d). Two, deliberately
 * different, uses of the same list:
 *
 *  - Which sources' already-scored jobs show in the results list below
 *    (decision #3, 2026-08-29: filtering an existing corpus — free,
 *    instant, client-side; see hooks/useResults.ts and ResultsList.tsx).
 *  - Which sources a NEW search (the explicit, cost-previewed action —
 *    see SearchFlow.tsx) is scoped to.
 *
 * A source with `configured: false` (GET /sources — no adapter, or missing
 * env config; see apps/api/src/sources/registry.ts's `checkSourceHealth`)
 * renders disabled and visibly "unavailable" rather than just vanishing —
 * decision #5: "a dead source reads as unavailable rather than silently
 * absent." It cannot be toggled on, but it also doesn't break the rest of
 * the list.
 */
export function SourceToggles({
  sources,
  selected,
  onToggle,
}: {
  sources: SourceHealth[];
  selected: ReadonlySet<string>;
  onToggle: (sourceId: string) => void;
}) {
  return (
    <ul className="source-toggles" aria-label="Job sources">
      {sources.map((source) => {
        const isSelected = selected.has(source.id);
        const isUnavailable = !source.configured;
        return (
          <li key={source.id} className="source-toggle">
            <label
              className={isUnavailable ? "source-toggle-label unavailable" : "source-toggle-label"}
            >
              <input
                type="checkbox"
                checked={isSelected && !isUnavailable}
                disabled={isUnavailable}
                // The `disabled` attribute alone should be enough to stop a
                // real browser from ever firing this handler for an
                // unavailable source, but jsdom (unlike real browsers)
                // still dispatches a synthetic click's change event on a
                // disabled input — caught live by this component's own test
                // suite. Guarding here too means correctness doesn't depend
                // on which environment is running it.
                onChange={() => {
                  if (!isUnavailable) onToggle(source.id);
                }}
                aria-label={source.displayName}
              />
              <span className="source-name">{source.displayName}</span>
              {isUnavailable && (
                <span className="source-status" role="status">
                  unavailable{source.error ? ` — ${source.error}` : ""}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
