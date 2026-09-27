/**
 * Per-source health (ticket 59fdc52) — "so a dead source is visible rather
 * than silently absent" (the ticket's own framing of what makes the DLQ
 * pattern visible in the product). Config-only check, no network calls; see
 * sources/registry.ts's `checkSourceHealth` doc comment.
 */
import type { GetSourcesResponse } from "@app/shared";
import type { FastifyInstance } from "fastify";
import { checkSourceHealth } from "../sources/registry.js";

/**
 * AUDIT VERDICT (ticket 3fc1e5e): GENUINELY GLOBAL -- no per-user scoping
 * needed, and this was VERIFIED rather than assumed (the ticket names this
 * route as a plausible legitimately-global case, which is exactly the kind
 * of claim worth checking instead of accepting).
 *
 * What was checked: this handler's entire body is `checkSourceHealth()`
 * (sources/registry.ts), which maps over `SOURCE_DESCRIPTORS` -- a static
 * hardcoded array in db/seed.ts -- and for each one attempts `build()` from
 * `BUILDERS`, reporting whether the adapter's own credentials are present
 * in the PROCESS's environment. It performs no database query of any kind
 * and no network call, so there is no row it could read and no user-owned
 * table it could reach. The response (`SourceHealth[]`: id, displayName,
 * description, configured, error) is a property of this deployment's
 * configuration, identical for every caller by construction.
 *
 * This route is also the one that most needs to stay global: every user
 * must see the same source toggles, and a per-user answer here would be a
 * fact about the server dressed up as a fact about the user. It does still
 * REQUIRE the `x-user-id` header -- `registerIdentity`'s hook is global and
 * this route is not one of its two exemptions -- it simply has no use for
 * the value, which is why the handler takes `_request`.
 */
export function registerSourceRoutes(app: FastifyInstance): void {
  app.get("/sources", async (_request, reply) => {
    const response: GetSourcesResponse = { sources: checkSourceHealth() };
    return reply.send(response);
  });
}
