/**
 * Per-source health (ticket 59fdc52) — "so a dead source is visible rather
 * than silently absent" (the ticket's own framing of what makes the DLQ
 * pattern visible in the product). Config-only check, no network calls; see
 * sources/registry.ts's `checkSourceHealth` doc comment.
 */
import type { GetSourcesResponse } from "@app/shared";
import type { FastifyInstance } from "fastify";
import { checkSourceHealth } from "../sources/registry.js";

export function registerSourceRoutes(app: FastifyInstance): void {
  app.get("/sources", async (_request, reply) => {
    const response: GetSourcesResponse = { sources: checkSourceHealth() };
    return reply.send(response);
  });
}
