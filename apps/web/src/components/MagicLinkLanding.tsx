import { useEffect, useRef, useState } from "react";
import type { MagicLinkRejectionReason } from "@app/shared";
import { magicLinkRejectionReason, neverLanded, verifyMagicLink } from "../api/client";
import { setUserId, setVerifiedEmail } from "../identity";
import { reloadCurrent, reloadTo } from "../navigation";
import { clearAppState } from "../session";

/**
 * The page the emailed sign-in link opens to (ticket 9f06f8f, epic 2b9e9dd
 * child 4).
 *
 * This app has no router (single page, ticket 484889d), so "a landing page"
 * is a full-page takeover: `App` renders THIS instead of the normal three-tab
 * UI whenever `#magicLinkToken=` is present in the URL, and nothing else.
 * That is deliberate rather than a shortcut -- the one thing this view must
 * not do is render the ordinary app underneath while an identity switch is
 * mid-flight, which would show one user's cached results while the browser is
 * becoming a different user.
 *
 * WHY THE TOKEN ARRIVES IN THE URL FRAGMENT rather than a query parameter
 * (review round 4, F2): a fragment is never sent to any server. A
 * `?magicLinkToken=...` would be written, in full and still live, into the
 * access log of whatever static host serves this bundle -- before a single
 * line of this component runs, and regardless of how carefully the API side
 * keeps the token out of ITS logs. The API builds the link (apps/api/src/
 * routes/auth.ts); this is the other half of the same decision.
 *
 * WHAT HAPPENS, IN ORDER:
 *
 *  1. On mount, POST the token exactly once (see `startedRef` -- StrictMode
 *     makes this non-negotiable, not defensive).
 *  2. On a real response, strip `magicLinkToken` from the URL fragment with
 *     `history.replaceState`, so the credential stops living in the address
 *     bar and in browser history.
 *  3. On success, adopt the returned identity (`setUserId`), remember the
 *     verified email, and -- only if the id actually CHANGED -- clear the
 *     persisted app state, because a `resumeId` cached for the previous
 *     anonymous user names a row the newly-adopted user does not own.
 *  4. Reload when the user clicks Continue. See navigation.ts for why a
 *     reload rather than an in-place re-render, and (ticket a90095b) why
 *     success reloads the CURRENT url in place while failure navigates to a
 *     token-stripped one.
 *
 * WHY THE TOKEN IS REDEEMED AUTOMATICALLY rather than behind a "click to
 * sign in" button: the usual argument for a confirm button is that mail link
 * scanners burn one-shot tokens by following URLs. That does not apply here,
 * because redemption requires executing this component and issuing a POST --
 * a scanner that GETs the page does not consume anything (see
 * apps/api/src/routes/auth.ts's own note on this). So the button would cost
 * every real user a click and buy nothing.
 */

/** The token's name in the URL fragment. One constant, used by both the read
 * and the strip below, so they can never disagree. */
const TOKEN_PARAM = "magicLinkToken";

/** The fragment parsed as `key=value` pairs. `location.hash` includes the
 * leading `#`, which `URLSearchParams` would otherwise treat as part of the
 * first key's name. */
function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** Reads the token out of the current URL's FRAGMENT. Exported so `App` can
 * decide whether to render this view at all without duplicating the parameter
 * name. */
export function readMagicLinkTokenFromUrl(): string | undefined {
  try {
    const token = hashParams(window.location.hash).get(TOKEN_PARAM);
    return token !== null && token.length > 0 ? token : undefined;
  } catch {
    // Unparseable location (never expected in a browser) must not take the
    // whole app down -- fall through to the normal UI.
    return undefined;
  }
}

/** The current URL with the token removed -- where this flow always ends up,
 * whether it succeeded or failed. Any OTHER fragment parameter is preserved
 * (there are none today, but silently eating one would be a nasty surprise
 * for whoever adds the first), and an emptied fragment drops the `#` itself
 * rather than leaving a bare one in the address bar. */
function urlWithoutToken(): string {
  const url = new URL(window.location.href);
  const params = hashParams(url.hash);
  params.delete(TOKEN_PARAM);
  const rest = params.toString();
  url.hash = rest.length > 0 ? rest : "";
  return url.toString();
}

/**
 * Ticket bb2f275, Nicole (live): after a SUCCESSFUL verification, the
 * reload should land on "Already Scored Jobs" rather than defaulting to
 * "New Job Search" -- the more meaningful destination once results are
 * tied to a real account, and the ONLY meaningful one on a second-device
 * "adopt" login, where `clearAppState()` has already wiped any single-resume
 * session state by the time this marker is written (see the effect below).
 *
 * A URL fragment param, not sessionStorage: a value baked into the URL is
 * simpler to reason about than a side table that has to be remembered and
 * cleaned up independently of the navigation itself. `JobSearchApp`
 * (App.tsx) reads and consumes it once.
 *
 * Ticket a90095b: the reload this marker survives is
 * `window.location.reload()` (navigation.ts's `reloadCurrent`), NOT the
 * `window.location.replace` this comment originally named. Putting the
 * marker in the fragment is exactly what made a `replace` to that same URL
 * a silent no-op and left the "Continue" button dead -- see that button's
 * own comment below. The marker being in the URL is still right; what
 * changed is that the URL is now reloaded in place rather than navigated
 * to.
 */
const LAND_ON_SCORED_TAB_PARAM = "landOnScoredTab";

/** Reads whether the CURRENT url carries the "land on Already Scored Jobs"
 * marker -- a pure read, safe to call from anywhere (including, if it were
 * ever needed, a React render body) since it has no side effect. Exported
 * for `App.tsx`. */
export function hasLandOnScoredTabMarker(): boolean {
  try {
    return hashParams(window.location.hash).get(LAND_ON_SCORED_TAB_PARAM) !== null;
  } catch {
    return false;
  }
}

/** Removes the marker from the current URL in place (no reload), so a LATER,
 * unrelated page reload does not keep forcing "Already Scored Jobs" forever.
 * Exported for `App.tsx`, meant to be called once, right after
 * `hasLandOnScoredTabMarker()` is consumed. */
export function clearLandOnScoredTabMarker(): void {
  try {
    const url = new URL(window.location.href);
    const params = hashParams(url.hash);
    params.delete(LAND_ON_SCORED_TAB_PARAM);
    const rest = params.toString();
    url.hash = rest.length > 0 ? rest : "";
    window.history.replaceState(null, "", url.toString());
  } catch {
    // Same posture as the marker functions around this one: a real browser
    // is never expected to land here, and if it somehow does, failing to
    // strip the marker is a minor inconvenience (one extra "land on scored
    // tab" reload), never a reason to break anything else on the page.
  }
}

/** `urlWithoutToken()` plus the "land on Already Scored Jobs" marker --
 * used ONLY by the successful-verification path's own `history.replaceState`
 * call below, so the marker is baked into the URL the SAME moment the token
 * is stripped out of it (one history entry, not two). The failure path
 * keeps calling plain `urlWithoutToken()`, unchanged -- landing on "Already
 * Scored Jobs" only makes sense once there IS a verified identity to show
 * results for. */
function urlWithoutTokenLandingOnScoredTab(): string {
  const url = new URL(urlWithoutToken());
  const params = hashParams(url.hash);
  params.set(LAND_ON_SCORED_TAB_PARAM, "1");
  url.hash = params.toString();
  return url.toString();
}

type Phase =
  | { status: "verifying" }
  | { status: "verified"; email: string; switchedAccount: boolean }
  /**
   * `reason` is the server's adjudicated refusal code, present only when
   * `verifyMagicLink` itself rejected with an adjudicated 400 -- absent for
   * every other throw.
   *
   * `reason` being absent does NOT by itself mean the token survives
   * (ticket c719af2, found by opus reviewing ticket a90095b, and tightened
   * one round further by opus reviewing THIS ticket). `reason` is ALSO
   * absent for:
   *  - a throw after `verifyMagicLink` RESOLVED (the server committed the
   *    verification, 2xx, and the token is gone) -- concretely `setUserId`
   *    refusing a malformed `userId` the API sent back in a 200.
   *  - a throw from a 200 whose body never finished parsing (a raw
   *    `SyntaxError`/`TypeError` out of `response.text()`/`JSON.parse` in
   *    client.ts's `request()`) -- the 2xx status line alone proves the
   *    same transaction committed; the client just couldn't read the
   *    result. Equally gone.
   * Neither case may be told the link still works.
   *
   * `transportFailure` is the one flag that actually answers "can the
   * token still be used," and it is a real invariant, not a heuristic:
   * `client.ts`'s `neverLanded` keys on `status === 0`, which `request()`
   * assigns in exactly one place -- the `catch` around `fetch` itself,
   * when no `Response` was ever received. Every case above (adjudicated,
   * post-resolution, or unparseable-body) carries some other status or no
   * status at all, so `transportFailure` is true if and only if the POST
   * never got a response, which is the one case retrying the same link is
   * honest. See `neverLanded`'s own doc comment (client.ts) for why an
   * unreadable 200 is deliberately NOT folded into "never landed". */
  | {
      status: "failed";
      message: string;
      reason?: MagicLinkRejectionReason;
      transportFailure: boolean;
    };

export function MagicLinkLanding({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ status: "verifying" });

  // EXACTLY ONE POST, EVER. `main.tsx` wraps the app in `StrictMode`, which
  // deliberately mounts, unmounts and re-mounts every component once in
  // development -- so an unguarded effect here would redeem the token, then
  // redeem it AGAIN, and the second attempt would come back
  // `already_used`: a working sign-in that reports itself as broken, in dev
  // only, for the one flow that is hardest to retry. The ref survives
  // StrictMode's remount (same fiber), which is what makes it the right
  // guard rather than a state flag.
  const startedRef = useRef(false);
  /**
   * Whether this component is currently mounted -- a REF, not an effect-local
   * `let cancelled = false`, and that distinction is a real bug this
   * component had and a test now pins ("redeems the token EXACTLY ONCE under
   * StrictMode's double mount").
   *
   * With an effect-local flag, StrictMode's mount -> unmount -> remount
   * sequence broke the flow completely: the first effect run fired the POST
   * and then its own cleanup set ITS `cancelled` to true, while the remounted
   * effect run did nothing (correctly -- `startedRef` had already been set).
   * The in-flight request therefore resolved into a closure that believed it
   * had been cancelled, no state was ever set, and the page sat on "Signing
   * you in..." forever. A successful sign-in, presenting as a hang, in dev
   * only, for the flow that is hardest to retry.
   *
   * A ref fixes it because it is shared across those runs: the remount sets
   * it back to true, so the single outstanding request resolves into a live
   * component. A genuine unmount still leaves it false, so no state is set
   * after teardown.
   */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (startedRef.current) {
      return () => {
        aliveRef.current = false;
      };
    }
    startedRef.current = true;

    verifyMagicLink(token)
      .then((result) => {
        // Reaching this callback AT ALL already means the POST resolved
        // 2xx -- `request()` (client.ts) throws before returning for
        // anything else, including a 200 whose body didn't parse (that
        // throw lands in `.catch` below, never here). So the token is
        // spent either way now -- take it out of the URL before anything
        // else, so a reload cannot re-submit it and it stops being
        // visible. Ticket bb2f275: also bakes in the "land on Already
        // Scored Jobs" marker `JobSearchApp` reads on its next mount (the
        // "Continue" button below reloads to `window.location.href`, which
        // now carries it) -- one history entry, not a separate step.
        window.history.replaceState(null, "", urlWithoutTokenLandingOnScoredTab());
        if (!aliveRef.current) return;
        // `setUserId` throws only on a malformed id, which would leave this
        // browser unable to talk to the API at all -- surface it as a
        // failure rather than adopting it.
        const switchedAccount = setUserId(result.userId);
        setVerifiedEmail(result.email);
        if (switchedAccount) {
          // This browser is now a DIFFERENT user. Anything session.ts
          // persisted (a resumeId, its text, its nickname) belongs to the
          // identity we just left and would 404 under the new one -- worse,
          // it would render as if it were the new user's own resume.
          clearAppState();
        }
        setPhase({ status: "verified", email: result.email, switchedAccount });
      })
      .catch((err: unknown) => {
        const reason = magicLinkRejectionReason(err);
        // See `neverLanded`'s own doc comment (client.ts) and the `Phase`
        // type's above: true only when the POST never got a response at
        // all. Everything else -- an adjudicated refusal, the
        // malformed-userId throw, or an unparseable 200 body -- means we
        // cannot say this token survived, so it is treated the same as a
        // confirmed spend below (ticket c719af2, review round 2).
        const transportFailure = reason === undefined && neverLanded(err);
        if (!transportFailure) {
          // Not confirmed safe to retry: remove the (possibly already-dead)
          // token from the URL so a reload cannot resubmit it. This used to
          // be gated on `reason !== undefined` alone, which left a token
          // that was ACTUALLY spent (malformed userId, unparseable 200)
          // sitting in the address bar -- a reload would then resubmit it
          // and come back `already_used`, reading as a second, unrelated
          // bug.
          window.history.replaceState(null, "", urlWithoutToken());
        }
        if (!aliveRef.current) return;
        setPhase({
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
          reason,
          transportFailure,
        });
      });

    return () => {
      aliveRef.current = false;
    };
    // `token` is fixed for this component's whole life (App reads it once
    // from the URL), and `startedRef` makes a re-run a no-op regardless.
    // This repo has no react-hooks lint plugin configured -- App.tsx's own
    // mount-only effects make the same note.
  }, [token]);

  return (
    <main className="app magic-link-landing">
      <h1>AI-Assisted Job Search</h1>

      {phase.status === "verifying" && (
        <section className="magic-link-panel" aria-live="polite">
          <h2>Signing you in...</h2>
          <p>Checking your sign-in link.</p>
        </section>
      )}

      {phase.status === "verified" && (
        <section className="magic-link-panel">
          <h2>You're signed in</h2>
          <p>
            Your job search is saved to <strong>{phase.email}</strong>. Open this app from any
            browser and use a sign-in link to pick up where you left off.
          </p>
          {phase.switchedAccount && (
            <p className="magic-link-note">
              This browser is now signed in to the account that already belongs to {phase.email}, so
              you'll see that account's resumes and results — not whatever this browser was working
              on anonymously before.
            </p>
          )}
          {/* Ticket a90095b: `reloadCurrent()`, NOT
              `reloadTo(urlWithoutTokenLandingOnScoredTab())`.

              This button was dead. Nicole, testing the flow end to end:
              "Continue to your results button unfortunately is not doing
              anything." The success handler above already ran
              `history.replaceState` with
              `urlWithoutTokenLandingOnScoredTab()`, so the address bar
              ALREADY reads `#landOnScoredTab=1` by the time this renders
              -- which made `reloadTo` a request to replace the current URL
              with a byte-identical one, fragment included. That is a
              same-document fragment navigation, so the browser did
              nothing at all.

              bb2f275's original comment here argued the explicit call was
              clearer for a reader tracing "why does this land on Already
              Scored Jobs", and treated the URLs being the same as
              harmless ("the function is idempotent"). The function is; the
              navigation is not. The destination is now expressed entirely
              by the marker the success handler bakes in -- see
              `urlWithoutTokenLandingOnScoredTab` and
              `LAND_ON_SCORED_TAB_PARAM` above for that half, and
              navigation.ts's `reloadCurrent` for why a reload rather than
              a navigation is what this needs.

              The FAILURE path below deliberately still uses `reloadTo`,
              because on a genuine transport failure (client.ts's
              `neverLanded`) the token IS still in the URL -- that path's
              `replaceState` is conditional on `!phase.transportFailure`,
              ticket c719af2 review round 2 -- and stripping it is part of
              that button's job.

              But note what an earlier version of this comment claimed and
              got wrong, since opus review measured it: "the token is still
              in the URL" is true of a network error and FALSE of the other
              non-adjudicated case. A 200 carrying a malformed `userId`
              makes `setUserId` throw AFTER the success `replaceState` has
              already run, so the failure panel renders with
              `#landOnScoredTab=1` still in the URL and `urlWithoutToken()`
              equal to the current href -- which made that button a no-op
              too, by exactly this ticket's mechanism. Fixed inside
              `reloadTo` itself (navigation.ts), which now reloads when
              asked to navigate to the URL already loaded, so the whole
              class is closed rather than this one instance. */}
          <button type="button" onClick={() => reloadCurrent()}>
            Continue to your results
          </button>
        </section>
      )}

      {phase.status === "failed" && (
        <section className="magic-link-panel">
          <h2>That sign-in link didn't work</h2>
          {/* The server's own message, which is already specific about
              whether the link expired, was already used, or was never
              valid (see MagicLinkRejectionReason in @app/shared) -- there
              is no reason to re-word it less accurately here. */}
          <p role="alert">{phase.message}</p>
          {phase.transportFailure ? (
            // The ONE case where retrying the SAME link is honest: the POST
            // never got a response at all (client.ts's `neverLanded`), so
            // nothing server-side ever ran and the token was never touched.
            // Gated on `transportFailure`, NOT on `phase.reason === undefined`
            // -- ticket c719af2, tightened in review round 2: `reason` is
            // ALSO undefined for a throw after `verifyMagicLink` resolved
            // (e.g. `setUserId` refusing a malformed id the API returned in
            // a 200) AND for a 200 whose body never finished parsing. Both
            // mean the server already committed the verification (or might
            // have -- an unparseable 200 still proves the status line was
            // 2xx), so both must fall through to the "ask for a new link"
            // copy below instead, same as every other case where this link
            // cannot be trusted to still work.
            <p className="magic-link-note">
              The link hasn't been used up — it's still worth trying again once you're back online.
            </p>
          ) : phase.reason === "different_browser" ? (
            // The one refusal whose recovery is NOT "ask for a new link":
            // this link was never spent (the API refuses it before consuming
            // it), so the SAME email still works — just not from here. See
            // MagicLinkRejectionReason in @app/shared for why the attach
            // step is pinned to the requesting browser at all.
            <p className="magic-link-note">
              This link hasn't been used up. Open it again from your email, in the browser where you
              asked for it — after that first time, signing in works from any browser or device.
            </p>
          ) : (
            // Ticket 5130866 (opus note N4, ticket 5a7e957 review). This
            // generic branch is reached by two different kinds of visitor --
            // someone whose magic-link request came from `MagicLinkPrompt`
            // (results on screen, which has floated near the topmost result
            // since ticket 931df8a, never "the bottom") and someone whose
            // request came from `SignInRecovery` (no results at all, and a
            // header link rather than anything near a list). The old copy
            // named a location true of neither any more. Rather than naming
            // EITHER entry point's location -- which would misdirect
            // whichever kind of visitor is not that one -- this names the
            // one thing true for both: continuing below returns to the
            // normal app, where the entry point that actually applies to
            // this browser's state (the results prompt or the header
            // recovery link) is what renders.
            <p className="magic-link-note">
              You can ask for a new link once you continue below. Nothing you've already searched
              has been lost.
            </p>
          )}
          <button type="button" onClick={() => reloadTo(urlWithoutToken())}>
            Continue without signing in
          </button>
        </section>
      )}
    </main>
  );
}
