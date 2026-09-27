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
 * sees a given id, with no separate "register" call from here.
 */
const STORAGE_KEY = "userId";

// Read once per page load, then reused — avoids re-touching localStorage
// (and re-parsing) on every single API call this session makes.
let cached: string | undefined;

export function getUserId(): string {
  if (cached !== undefined) return cached;

  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing !== null && existing.length > 0) {
    cached = existing;
    return existing;
  }

  const fresh = crypto.randomUUID();
  window.localStorage.setItem(STORAGE_KEY, fresh);
  cached = fresh;
  return fresh;
}
