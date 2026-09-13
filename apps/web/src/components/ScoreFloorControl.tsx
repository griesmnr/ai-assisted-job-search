/**
 * User-configurable match-score floor (git-bug ffbf9fb).
 *
 * Nicole, dogfooding (2026-09-08): "should users be able to choose their
 * percentage ceiling? Just an idea. Something like don't show jobs less
 * than 25% and it can move." Before this ticket, `MATCH_SCORE_FLOOR`
 * (`@app/shared`) was a fixed constant baked into `useResults.ts` -- every
 * fetch of `GET /resumes/:id/results` always passed exactly that value as
 * `?minScore=`. That endpoint already accepted an arbitrary numeric floor
 * (see apps/api/src/routes/resumes.ts's `minScoreNum` parsing -- verified
 * against that file directly before starting this ticket, not assumed);
 * this control is the only piece that was actually missing.
 *
 * Rendered in BOTH "New Job Search" and "Already Scored Jobs" (App.tsx
 * owns the single shared `scoreFloor` value and passes it here plus a
 * setter -- see App.tsx's own comment on why one shared value, not two
 * independent ones). A caller moving this slider changes `App.tsx`'s
 * `scoreFloor` state, which flows into `useResults`'s `minScore` argument
 * and re-fetches (see that hook's doc comment) -- a REAL server-side
 * re-filter, not a client-side hide like the "Hide roles above my level"
 * checkbox or the source toggles: a lower floor can surface jobs that were
 * never sent to the client at all under the old floor.
 *
 * Bounds are 0-90, not 0-100: `matchScore` is a 0-100 percentage, but a
 * floor anywhere near 100 would hide nearly everything a real resume ever
 * scores (see demo-match.ts's scoring distribution) -- 90 is already a
 * stricter floor than any real corpus needs, and reserving the last 10
 * points of slider travel for a floor nobody would practically want just
 * makes the other 90 harder to land on precisely. Step 5 mirrors
 * `MATCH_SCORE_FLOOR`'s own round-number convention (55) rather than
 * forcing single-percent precision nobody asked for.
 */
export function ScoreFloorControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="score-floor-control">
      <label htmlFor="score-floor-slider">Minimum match score to show</label>
      <input
        id="score-floor-slider"
        type="range"
        min={0}
        max={90}
        step={5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {/* `htmlFor` on `<output>` associates it with the control it reflects
          without making it a second interactive element for a screen
          reader to tab to. */}
      <output htmlFor="score-floor-slider" className="score-floor-value">
        {value}%
      </output>
    </div>
  );
}
