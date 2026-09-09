/**
 * Splits a comma-separated text field into trimmed, non-empty phrases —
 * the one place this happens, shared by every `SearchCriteria` text field.
 *
 * Extracted out of App.tsx (ticket b9e6251, opus review F3): a lone ","
 * (or any whitespace/comma-only string) is a non-empty string but splits
 * to ZERO real phrases — `nearLocations.trim().length > 0` alone would
 * treat it as a real location signal, silently letting exactly the kind
 * of punctuation-only input through that this ticket exists to stop
 * (an unrestricted, "search anywhere" criteria reached without a genuine
 * explicit choice). App.tsx's `hasLocationSignal` gate and
 * SearchCriteriaForm.tsx's own identical warning-display check both call
 * this function now, rather than each keeping an independent `.trim()`
 * check that could silently drift out of sync with each other.
 */
export function splitPhrases(text: string): string[] {
  return text
    .split(",")
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
}
