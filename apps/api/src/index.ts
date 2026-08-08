import Fastify from "fastify";

/**
 * Builds the Fastify instance. No routes registered yet — this is the
 * buildable entrypoint the scaffold ticket asks for; routes land on
 * follow-up tickets.
 */
export function buildApp() {
  return Fastify({ logger: true });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);

  app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
