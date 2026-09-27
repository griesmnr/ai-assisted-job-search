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
