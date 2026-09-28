/**
 * Ticket dba885e (epic 2b9e9dd, child 1): the anonymous, invisible
 * per-browser identity every API request now carries. Minted ONCE per
 * browser via `crypto.randomUUID()` — never server-generated — and
 * persisted in `localStorage`, deliberately NOT `session.ts`'s
 * `sessionStorage`: that file's own doc comment explains why app state
 * there is tab-scoped on purpose (a stale searchId/resumeId resurrected
 * on a genuinely new visit would be confusing). This identity is the
 * opposite lifetime by design — it must outlive a tab close, a reload, a
 * browser restart, since it's what lets a returning visitor's earlier,
 * anonymous activity still belong to them tomorrow. See epic 2b9e9dd's
 * own design conversation: this is NOT a login, carries no email, and is
 * never shown to the user anywhere.
 *
 * `apps/api/src/identity.ts` is this module's server-side counterpart —
 * it creates the corresponding `users` row lazily, the first time it
 * sees a given id, with no separate "register" call from here. Its own
 * `UUID_RE` is mirrored here so a corrupted/foreign stored value gets
 * re-minted client-side instead of sending a value the server would
 * reject anyway (see `isValidId` below, review fix S1).
 *
 * Review fixes applied after ticket dba885e's own adversarial review:
 *
 *  - S1: every storage access is now wrapped, matching `session.ts`'s own
 *    `readRaw`/`writeRaw` pattern -- `localStorage` can throw on ACCESS
 *    (not just on write) in a browser configured to block site data, and
 *    without a guard here, that throw propagated out of `client.ts`'s own
 *    try/catch as a misleading "Could not reach the API" message on
 *    every single request, for a failure that has nothing to do with the
 *    network. A stored value that doesn't look like a real UUID (e.g. a
 *    stray `userId` key left by an unrelated local project sharing this
 *    origin) is treated the same as "nothing stored yet" and replaced,
 *    rather than sent to the server forever and rejected every time.
 *  - S2: the storage key follows this file's own established convention
 *    (`session.ts`'s `jobsearch.web.appState.v5` / `.activeSearch.v1`) --
 *    `"userId"` alone was one stray key away from colliding with some
 *    other local project sharing `http://localhost:5173`.
 */
const STORAGE_KEY = "jobsearch.web.userId.v1";

// Mirrors apps/api/src/identity.ts's own UUID_RE exactly -- a stored value
// that doesn't match this is never sent to the server; see `getUserId`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(value: string): boolean {
  return UUID_RE.test(value);
}

function readStoredId(): string | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw !== null && isValidId(raw) ? raw : undefined;
  } catch {
    // Blocked storage (private-browsing lockdown, an enterprise policy,
    // a full quota already tripped on an unrelated key) -- treated
    // exactly like "nothing stored yet" rather than propagating.
    return undefined;
  }
}

function writeStoredId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Best-effort only. A freshly-minted id that can't be persisted still
    // works for the rest of THIS page load (see `cached` below) -- it
    // just won't survive a reload, which is the honest, unavoidable
    // consequence of storage being unavailable, not a bug to work around.
  }
}

// Read/minted once per page load, then reused for the rest of it --
// avoids re-touching localStorage on every single API call, and is what
// makes this id stable even across the one case above where persisting a
// fresh id silently fails.
let cached: string | undefined;

export function getUserId(): string {
  if (cached !== undefined) return cached;

  const existing = readStoredId();
  if (existing !== undefined) {
    cached = existing;
    return existing;
  }

  const fresh = crypto.randomUUID();
  writeStoredId(fresh);
  cached = fresh;
  return fresh;
}

/**
 * Ticket 9f06f8f (epic 2b9e9dd, child 4): adopts a user id the SERVER
 * resolved, replacing whatever this browser had minted for itself.
 *
 * This is the one and only path by which an id arrives from outside this
 * module, and it exists for exactly one caller: `POST
 * /auth/magic-link/verify`'s response, after the user clicked a single-use
 * link mailed to their own address. The id it writes is a credential in
 * precisely the same sense a self-minted one is (`x-user-id` is the whole
 * of this app's auth -- see apps/api/src/identity.ts's doc comment on why
 * an unsigned UUID is the chosen trust level), so it is stored the same
 * way and must never be logged.
 *
 * Validated against the SAME `UUID_RE` a self-minted id must satisfy,
 * deliberately: a malformed value here would be rejected by the API on
 * every subsequent request, which presents as "the whole app is broken
 * after signing in" rather than as one failed verification. Throwing
 * instead lets the caller show a real error and leave the browser's
 * existing, working identity untouched.
 *
 * Returns true when the id actually CHANGED. `MagicLinkLanding` branches on
 * that: an unchanged id means "this browser's own anonymous session just
 * gained an email" (nothing to reset -- the in-progress search and its
 * results still belong to the same person), while a changed id means the
 * browser is now a DIFFERENT user, and anything cached under the previous
 * one (session.ts's persisted `resumeId`) refers to rows that user does not
 * own and would 404.
 */
export function setUserId(id: string): boolean {
  if (!isValidId(id)) {
    throw new Error(`Refusing to adopt a malformed user id: "${id}"`);
  }
  const changed = getUserId() !== id;
  writeStoredId(id);
  cached = id;
  return changed;
}

/**
 * The verified email address this browser is signed in as, or `undefined`.
 *
 * WHY THIS IS STORED CLIENT-SIDE RATHER THAN READ FROM THE API. Its only
 * job is to stop the post-results prompt from asking a signed-in user to
 * sign in again, and for that purpose local storage is not merely adequate,
 * it is exactly correct: this value and the user id live in the SAME storage
 * with the SAME lifetime. If storage is cleared, the id goes with it -- the
 * browser is then a genuinely new anonymous visitor, and prompting is the
 * right behavior, not a bug. So a `GET /auth/session` round trip could not
 * be more accurate here, only slower, and this ticket does not add one.
 *
 * Never used for authorization. The server decides what this identity may
 * see from the id on the wire; this string only decides whether a prompt is
 * rendered.
 */
const EMAIL_STORAGE_KEY = "jobsearch.web.userEmail.v1";

export function getVerifiedEmail(): string | undefined {
  try {
    const raw = window.localStorage.getItem(EMAIL_STORAGE_KEY);
    return raw !== null && raw.length > 0 ? raw : undefined;
  } catch {
    // Same blocked-storage handling as `readStoredId` (review fix S1): read
    // as "nothing stored", never propagate.
    return undefined;
  }
}

export function setVerifiedEmail(email: string): void {
  try {
    window.localStorage.setItem(EMAIL_STORAGE_KEY, email);
  } catch {
    // Best-effort, exactly like `writeStoredId`: failing to remember this
    // only means the prompt may reappear later, which is a cosmetic
    // consequence of unavailable storage, not a broken sign-in.
  }
}
