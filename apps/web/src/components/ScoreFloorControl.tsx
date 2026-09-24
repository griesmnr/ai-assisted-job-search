import { useEffect, useId, useState } from "react";

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
 * re-filter, not a client-side hide like the "Hide roles I'm overqualified
 * for" checkbox (ticket 8c252ff) or the source toggles: a lower floor can
 * surface jobs that were
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
 *
 * `id`/`htmlFor` use `useId()`, NOT a hardcoded literal (opus review,
 * ticket ffbf9fb: BLOCKING). App.tsx mounts this component twice at once
 * -- once inside the "New Job Search" tab, once inside "Already Scored
 * Jobs" -- and BOTH tabs stay mounted simultaneously (`hidden`, not
 * conditional rendering; see App.tsx's own comment on that). Once a
 * search completes with a resume loaded, both instances are in the DOM at
 * the same time. A hardcoded `id="score-floor-slider"` would then be
 * duplicated: invalid HTML, and `getElementById`/`getByLabelText` resolve
 * to the FIRST match only, so the visible tab's label/output would end up
 * pointing at the OTHER (hidden) tab's slider instead of its own --
 * breaking label-click-to-focus and leaving the visible slider with no
 * accessible name at all. `useId()` gives each rendered instance its own
 * unique id, so label association is always correct regardless of which
 * tab is currently visible.
 *
 * No debouncing on the SLIDER itself (opus review, should-fix): dragging
 * fires many `onChange` events in quick succession (up to ~19 across the
 * 0-90 range at step 5), and forwarding every one straight to `onChange`
 * (which flows into `useResults`'s `minScore` and triggers a real
 * server-side re-fetch) meant one wasteful API call per tick, with the
 * results list visibly churning through intermediate states while the
 * user was still dragging. `draft` is this component's own local state,
 * updated synchronously on every `onChange` so the slider position and the
 * `%` readout stay fully responsive while dragging; only the value hand-
 * ed up to the parent (via the caller's `onChange`) is delayed until 250ms
 * has passed with no further movement -- a plain `setTimeout` debounce,
 * since nothing more elaborate already existed in `apps/web/src/hooks/`.
 */
const DEBOUNCE_MS = 250;

export function ScoreFloorControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const sliderId = useId();
  const [draft, setDraft] = useState(value);

  // The parent's `value` can also change for reasons other than this
  // component's own debounced propagation -- e.g. a session restore, or
  // the OTHER mounted instance (the other tab) finishing its own debounce
  // first, since both instances share the same `value`/`onChange` from
  // App.tsx. Stay in sync with it rather than fighting it.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);

  return (
    <div className="score-floor-control">
      <label htmlFor={sliderId}>Minimum match score to show</label>
      <input
        id={sliderId}
        type="range"
        min={0}
        max={90}
        step={5}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
      />
      {/* `htmlFor` on `<output>` is NOT a labeling relationship the way
          `<label htmlFor>` is -- per the HTML spec it lists the id(s) of
          the control(s) that CONTRIBUTED TO the value being displayed
          (provenance bookkeeping), and creates no accessible-name or
          focus-association benefit. Kept here because it's an accurate,
          zero-cost statement of "this output was computed from that
          slider" -- not because it makes this `<output>` announced as
          associated with the slider for assistive tech. */}
      <output htmlFor={sliderId} className="score-floor-value">
        {draft}%
      </output>
    </div>
  );
}
