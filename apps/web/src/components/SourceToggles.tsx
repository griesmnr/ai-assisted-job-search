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
 * is dropped before rendering, not shown as a disabled/"unavailable" row —
 * ticket d480357 supersedes decision #5 ("a dead source reads as
 * unavailable rather than silently absent") per Nicole, 2026-09-04: "for
 * the product, i def want all adapters either working or not showing."
 * `checkSourceHealth` itself is unchanged and still reports every seeded
 * source (a future admin/debug view may still want that); this component
 * filters its own `sources` prop rather than trust every caller to
 * pre-filter, so "an unconfigured source never renders here" holds even if
 * a future caller forgets to.
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
  const configuredSources = sources.filter((source) => source.configured);
  return (
    <ul className="source-toggles" aria-label="Job sources">
      {configuredSources.map((source) => {
        const isSelected = selected.has(source.id);
        return (
          <li key={source.id} className="source-toggle">
            <label className="source-toggle-label">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(source.id)}
                aria-label={source.displayName}
              />
              <span className="source-toggle-text">
                <span className="source-name">{source.displayName}</span>
                {source.description && (
                  <span className="source-description">{source.description}</span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
