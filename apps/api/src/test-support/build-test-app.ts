/**
 * Ticket dba885e (epic 2b9e9dd, child 1): every route now requires the
 * `x-user-id` header (see `../identity.ts`). Wiring a real header into
 * every one of the ~290 pre-existing `app.inject(...)` calls across this
 * codebase's six route test files would be pure mechanical churn with no
 * test value -- none of those tests are ABOUT identity, they're about
 * everything this app already did before this ticket existed.
 *
 * This wraps `buildApp`'s returned instance so `.inject()` defaults to a
 * fixture user id whenever the caller doesn't specify one. Same app, same
 * routes, same real behavior -- this only changes `.inject()`, which is
 * Fastify's test-only injection method (`light-my-request`); production
 * traffic goes through `app.listen()` and never touches this wrapper at
 * all, so this is not environment-forked application behavior, only a
 * convenience default for a testing tool.
 *
 * Every existing test file's `import { buildApp } from "../index.js"`
 * becomes `import { buildTestApp as buildApp } from
 * "../test-support/build-test-app.js"` -- the alias means every existing
 * `buildApp({...})` call site keeps working completely unchanged.
 *
 * Escape hatch for a test that's actually ABOUT the identity requirement
 * itself (this ticket's own tests, or ticket 3fc1e5e's cross-user
 * isolation tests): pass a real `headers["x-user-id"]` to act as a
 * SPECIFIC (possibly different) user, or `headers: { "x-user-id": "" }`
 * to omit the header entirely and exercise the missing-header rejection
 * path. `injectAs` below is the safer spelling of the first case --
 * prefer it over hand-rolling the header yourself.
 *
 * Review fix (B2, required): the presence check below is now
 * case-INSENSITIVE, matching real HTTP header semantics. The original
 * version checked `"x-user-id" in headers` literally -- a caller passing
 * `{ "X-User-Id": someOtherUser }` (equally valid HTTP, and an easy typo
 * to make) found its own header silently ignored and overwritten with
 * `DEFAULT_TEST_USER_ID`, with no error. For ticket 3fc1e5e's own
 * cross-user isolation tests specifically, that failure mode is
 * dangerous in exactly the wrong direction: a test meant to prove "user A
 * cannot see user B's data" would silently run as the SAME default user
 * throughout, and could pass while proving nothing.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp, type BuildAppDeps } from "../index.js";
import { USER_ID_HEADER } from "../identity.js";

export const DEFAULT_TEST_USER_ID = "00000000-0000-4000-8000-000000000000";

// `FastifyInstance["inject"]` is overloaded (options-object, callback,
// zero-arg chainable), and `ReturnType<...>` on an overloaded type picks
// the LAST signature, not the one this codebase actually calls -- naming
// the real return type directly avoids that trap.
type InjectFn = (opts: InjectOptions | string) => Promise<LightMyRequestResponse>;

/** Case-insensitive lookup of `name` among `headers`' own keys -- HTTP
 * header names are never case-sensitive, but a plain JS object's `in`/
 * index access is. Returns the key AS THE CALLER SPELLED IT (never
 * rewritten), so `rawInject` still sees whatever casing was actually
 * passed in. */
function findHeaderKey(
  headers: NonNullable<InjectOptions["headers"]>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === target);
}

export function buildTestApp(deps: BuildAppDeps): FastifyInstance {
  const app = buildApp(deps);
  const rawInject = app.inject.bind(app) as InjectFn;

  app.inject = ((opts: InjectOptions | string) => {
    const normalized: InjectOptions = typeof opts === "string" ? { url: opts } : opts;
    const headers: NonNullable<InjectOptions["headers"]> = { ...normalized.headers };
    const existingKey = findHeaderKey(headers, USER_ID_HEADER);
    if (existingKey === undefined) {
      headers[USER_ID_HEADER] = DEFAULT_TEST_USER_ID;
    } else if (headers[existingKey] === "") {
      delete headers[existingKey];
    }
    return rawInject({ ...normalized, headers });
    // `light-my-request`'s zero-arg chainable overload (`app.inject()`,
    // with no options, then `.end()`/`.then()` chained on afterward) is
    // unused anywhere in this codebase -- every call site is `await
    // app.inject({...})` -- so this narrower reassignment covers
    // everything that actually exists. Calling the zero-arg form against
    // THIS wrapper throws (there's no `opts` to read a header default
    // onto), which is a fine failure mode for a form nothing here uses.
  }) as FastifyInstance["inject"];

  return app;
}

/**
 * Review suggestion: a casing-proof way to act as a SPECIFIC user,
 * primarily for ticket 3fc1e5e's cross-user isolation tests -- prefer
 * this over hand-building `headers: { "x-user-id": ... }` yourself, since
 * it can't typo the header name or collide with `findHeaderKey`'s
 * case-insensitive matching above.
 */
export function injectAs(
  app: FastifyInstance,
  userId: string,
  opts: InjectOptions,
): Promise<LightMyRequestResponse> {
  return app.inject({ ...opts, headers: { ...opts.headers, [USER_ID_HEADER]: userId } });
}
