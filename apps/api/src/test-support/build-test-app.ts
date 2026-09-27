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
 * path.
 */
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp, type BuildAppDeps } from "../index.js";
import { USER_ID_HEADER } from "../identity.js";

export const DEFAULT_TEST_USER_ID = "00000000-0000-4000-8000-000000000000";

type InjectFn = (opts: InjectOptions | string) => ReturnType<FastifyInstance["inject"]>;

export function buildTestApp(deps: BuildAppDeps): FastifyInstance {
  const app = buildApp(deps);
  const rawInject = app.inject.bind(app) as InjectFn;

  app.inject = ((opts: InjectOptions | string) => {
    const normalized: InjectOptions = typeof opts === "string" ? { url: opts } : opts;
    const headers: NonNullable<InjectOptions["headers"]> = { ...normalized.headers };
    if (!(USER_ID_HEADER in headers)) {
      headers[USER_ID_HEADER] = DEFAULT_TEST_USER_ID;
    } else if (headers[USER_ID_HEADER] === "") {
      delete headers[USER_ID_HEADER];
    }
    return rawInject({ ...normalized, headers });
    // `light-my-request`'s own overloads (callback-style, chainable
    // `.inject().end()`) are unused anywhere in this codebase -- every
    // call site is `await app.inject({...})` -- so this narrower
    // reassignment covers everything that actually exists.
  }) as FastifyInstance["inject"];

  return app;
}
