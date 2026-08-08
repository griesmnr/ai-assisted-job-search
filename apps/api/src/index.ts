import { pathToFileURL } from "node:url";
import Fastify from "fastify";

/**
 * Builds the Fastify instance. No routes registered yet — this is the
 * buildable entrypoint the scaffold ticket asks for; routes land on
 * follow-up tickets.
 */
export function buildApp() {
  return Fastify({ logger: true });
}

// pathToFileURL handles spaces/non-ASCII in the path correctly (percent-
// encodes as needed); a raw `file://${process.argv[1]}` template does not,
// so this check would silently fail — and the server would silently never
// listen — for anyone running from a path like `~/My Projects/`.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);

  app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
