import { useEffect, useRef, useState } from "react";
import type { MagicLinkRejectionReason } from "@app/shared";
import { magicLinkRejectionReason, verifyMagicLink } from "../api/client";
import { setUserId, setVerifiedEmail } from "../identity";
import { reloadTo } from "../navigation";
import { clearAppState } from "../session";

/**
 * The page the emailed sign-in link opens to (ticket 9f06f8f, epic 2b9e9dd
 * child 4).
 *
 * This app has no router (single page, ticket 484889d), so "a landing page"
 * is a full-page takeover: `App` renders THIS instead of the normal three-tab
 * UI whenever `?magicLinkToken=` is present in the URL, and nothing else.
 * That is deliberate rather than a shortcut -- the one thing this view must
 * not do is render the ordinary app underneath while an identity switch is
 * mid-flight, which would show one user's cached results while the browser is
 * becoming a different user.
 *
 * WHAT HAPPENS, IN ORDER:
 *
 *  1. On mount, POST the token exactly once (see `startedRef` -- StrictMode
 *     makes this non-negotiable, not defensive).
 *  2. On a real response, strip `magicLinkToken` from the URL with
 *     `history.replaceState`, so the credential stops living in the address
 *     bar, in browser history, and in the `Referer` of anything the page
 *     fetches next.
 *  3. On success, adopt the returned identity (`setUserId`), remember the
 *     verified email, and -- only if the id actually CHANGED -- clear the
 *     persisted app state, because a `resumeId` cached for the previous
 *     anonymous user names a row the newly-adopted user does not own.
 *  4. Reload to the cleaned URL when the user clicks Continue. See
 *     navigation.ts for why a reload rather than an in-place re-render.
 *
 * WHY THE TOKEN IS REDEEMED AUTOMATICALLY rather than behind a "click to
 * sign in" button: the usual argument for a confirm button is that mail link
 * scanners burn one-shot tokens by following URLs. That does not apply here,
 * because redemption requires executing this component and issuing a POST --
 * a scanner that GETs the page does not consume anything (see
 * apps/api/src/routes/auth.ts's own note on this). So the button would cost
 * every real user a click and buy nothing.
 */

/** Reads the token out of the current URL. Exported so `App` can decide
 * whether to render this view at all without duplicating the parameter
 * name. */
export function readMagicLinkTokenFromUrl(): string | undefined {
  try {
    const token = new URLSearchParams(window.location.search).get("magicLinkToken");
    return token !== null && token.length > 0 ? token : undefined;
  } catch {
    // Unparseable location (never expected in a browser) must not take the
    // whole app down -- fall through to the normal UI.
    return undefined;
  }
}

/** The current URL with the token removed -- where this flow always ends up,
 * whether it succeeded or failed. */
function urlWithoutToken(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("magicLinkToken");
  return url.toString();
}

type Phase =
  | { status: "verifying" }
  | { status: "verified"; email: string; switchedAccount: boolean }
  /** `reason` is absent for a transport-level failure (API unreachable),
   * which is the one failure worth distinguishing: the token has NOT been
   * consumed, so retrying the same link is a real option. */
  | { status: "failed"; message: string; reason?: MagicLinkRejectionReason };

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
        // The token is spent either way now -- take it out of the URL before
        // anything else, so a reload cannot re-submit it and it stops being
        // visible.
        window.history.replaceState(null, "", urlWithoutToken());
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
        if (reason !== undefined) {
          // A real, adjudicated refusal: the link is spent or was never
          // valid, so remove it from the URL like a success.
          window.history.replaceState(null, "", urlWithoutToken());
        }
        if (!aliveRef.current) return;
        setPhase({
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
          reason,
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
          <button type="button" onClick={() => reloadTo(urlWithoutToken())}>
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
          {phase.reason === undefined ? (
            <p className="magic-link-note">
              The link hasn't been used up — it's still worth trying again once you're back online.
            </p>
          ) : (
            <p className="magic-link-note">
              You can ask for a new link from the bottom of your results at any time. Nothing you've
              already searched has been lost.
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
