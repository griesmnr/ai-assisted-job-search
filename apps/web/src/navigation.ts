/**
 * The one place this app performs a real page navigation (ticket 9f06f8f).
 *
 * WHY A MODULE FOR ONE LINE. Two reasons, both concrete:
 *
 *  1. TESTABILITY. `jsdom` does not implement navigation -- assigning
 *     `window.location.href`/`.replace()` emits a "Not implemented" jsdom
 *     error on the virtual console. A one-function module is something a test
 *     can `vi.mock`, so the sign-in flow is testable end to end without
 *     either polluting test output or asserting around an unnavigable window.
 *  2. IT MARKS THE SEAM. A full reload is a deliberate, unusual act in an SPA
 *     and the only caller has a specific reason for it (see below). Having it
 *     named makes that reason findable, rather than buried as a bare
 *     `location.replace` in a component.
 *
 * WHY THE SIGN-IN FLOW RELOADS AT ALL, rather than re-rendering in place:
 * adopting a verified identity changes who every subsequent request is FOR,
 * and `App`'s data hooks (useSources, useResults, useResumesList) have
 * already fetched under the previous id by the time a magic link is
 * redeemed -- React hooks cannot be skipped conditionally, so the landing
 * view cannot prevent those fetches from having happened. A reload is the
 * honest way to make every fetch on the page belong to the new identity, and
 * it costs one page load on an action a user takes approximately once per
 * device.
 *
 * `replace`, not `assign`: the URL being left is the emailed link, which
 * still carries (or carried) a single-use token. Keeping it in the back
 * button's history is exactly what we do not want.
 */
export function reloadTo(url: string): void {
  window.location.replace(url);
}

/**
 * Reload the page AS IT IS, preserving the current URL and its fragment.
 *
 * WHY THIS EXISTS SEPARATELY FROM `reloadTo` (ticket a90095b). `reloadTo`
 * cannot reload to the URL the page is already on. Navigating to a URL equal
 * to the current one *including* its fragment is a same-document fragment
 * navigation -- the browser does not reload, and with an identical fragment
 * it does nothing observable at all. That is precisely what broke
 * "Continue to your results": ticket bb2f275 started baking a
 * `#landOnScoredTab=1` marker into the URL via `history.replaceState` the
 * moment verification succeeded, which made the button's
 * `reloadTo(urlWithoutTokenLandingOnScoredTab())` a call to replace the
 * current URL with itself. Silent no-op; the button appeared dead.
 *
 * (It worked before bb2f275 only by accident of fragment handling:
 * `urlWithoutToken()` drops the `#` entirely when the fragment empties, and
 * `location.replace()` to an identical URL with NO fragment *is* a real
 * navigation.)
 *
 * WHY `reload()` IS SAFE HERE despite this module's `replace`-not-`assign`
 * reasoning above. That reasoning is about not leaving a URL bearing a
 * single-use token in the back button's history. By the time anything calls
 * this, the successful-verification path has already run
 * `history.replaceState` and OVERWRITTEN that token-bearing entry -- the
 * credential is gone from history, so there is nothing for a reload to
 * preserve. A caller that still has a live token in its URL must use
 * `reloadTo` with a token-stripped URL instead (the failure path does
 * exactly that, deliberately).
 */
export function reloadCurrent(): void {
  window.location.reload();
}
