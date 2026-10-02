import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { Client } from "pg";
import { loadEnvFile } from "../load-env.js";

/**
 * Says out loud what the API silently fails to do (ticket 86bb374).
 *
 * WHY THIS EXISTS. Nicole's first Railway deploy crash-looped for hours with
 * a log that, in full and on repeat, said:
 *
 *     Starting Container
 *     Reading config file '/repo/apps/api/drizzle.config.ts'
 *     Using 'pg' driver for database querying
 *     [ ] applying migrations...
 *
 * No error, ever. The cause of the SILENCE (not of the outage) is that `pg`
 * defaults `connectionTimeoutMillis` to 0 -- no timeout. A TCP connect that
 * never completes therefore never gives up and never throws, so
 * `drizzle-kit migrate` hangs until the platform's healthcheck recycles the
 * container. Wrong host, wrong port, unroutable network and
 * nothing-listening all produce that identical log, which is why four
 * successive theories were acted on without converging.
 *
 * So this script's job is not to fix anything. It is to make the failure
 * NAME ITSELF, in four steps that fail independently:
 *
 *   1. what it is about to dial (catches a variable that never applied)
 *   2. what the hostname resolves to, and the address family (Railway's
 *      private network is IPv6-only, so an A-record answer is itself a
 *      finding)
 *   3. a raw TCP connect with a SHORT timeout (separates "cannot reach" from
 *      "reached and rejected")
 *   4. a real `pg` handshake and `select 1` (separates credentials and
 *      database name from reachability)
 *
 * DELIBERATELY NOT IN THE DOCKERFILE'S `CMD`. A diagnostic in the boot path
 * is a new way for boot to fail. This is something a human points the start
 * command at when stuck -- see deploy/README.md -- and it needs no Docker
 * plumbing, since `src/` already compiles to `dist/` and
 * `deploy/api.Dockerfile` copies all of `apps/api`.
 *
 * THE PASSWORD IS NEVER PRINTED, in any form -- not masked, not as a
 * character count. A length narrows a guess space, and this output is
 * expected to be pasted into chat logs and issue threads by someone who is
 * already frustrated and not auditing it first.
 */

/** Short on purpose. The entire point is to fail faster than the thing it is
 * diagnosing, which hangs indefinitely. */
const CONNECT_TIMEOUT_MS = 10_000;

function line(label: string, value: string): void {
  console.log(`${label.padEnd(22)} ${value}`);
}

/** Step 1 -- what are we even dialing? A variable that was edited in a
 * dashboard but never applied to the running container shows up here and
 * nowhere else. */
function reportConfig(): { host: string; port: number; user: string; database: string } {
  const host = process.env.POSTGRES_HOST ?? "(unset)";
  const port = process.env.POSTGRES_PORT ?? "(unset)";
  const user = process.env.POSTGRES_USER ?? "(unset)";
  const database = process.env.POSTGRES_DB ?? "(unset)";
  const password = process.env.POSTGRES_PASSWORD;

  console.log("--- what this container will dial ---");
  line("POSTGRES_HOST", host);
  line("POSTGRES_PORT", port);
  line("POSTGRES_USER", user);
  line("POSTGRES_DB", database);
  // Presence only, never the value or its length -- see this file's header.
  // Empty-but-set is called out separately because it is a distinct and real
  // failure: `.env.example` ships `POSTGRES_PASSWORD=` blank, so a copied
  // config authenticates as nobody and fails at step 4 with an auth error
  // that looks like a wrong password rather than a missing one.
  line(
    "POSTGRES_PASSWORD",
    password === undefined ? "(unset)" : password === "" ? "(set but EMPTY)" : "(set)",
  );
  console.log("");

  return { host, port: Number(port), user, database };
}

/** Step 2 -- resolution and address family, reported separately from the
 * connect so "the name is wrong" and "the route is wrong" cannot be confused
 * for each other. */
async function reportResolution(host: string): Promise<boolean> {
  console.log("--- dns ---");
  try {
    const addresses = await lookup(host, { all: true });
    for (const { address, family } of addresses) {
      line("resolved", `${address}  (IPv${family})`);
    }
    // Loopback is legitimately IPv4 and is how this script is run locally --
    // warning there would cry wolf on every developer invocation.
    const isLoopback = host === "localhost" || host.startsWith("127.") || host === "::1";
    if (!isLoopback && addresses.every((a) => a.family === 4)) {
      console.log(
        "note: only IPv4 answers. A platform whose private network is IPv6-only\n" +
          "      (Railway, for one) will not route this, and the connect below\n" +
          "      will hang or time out rather than be refused.",
      );
    }
    console.log("");
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
    line("FAILED", `${code} -- the hostname does not resolve at all`);
    console.log(
      "\nThat is a name problem, not a network one: nothing was dialed. Check the\n" +
        "host variable above against what the database service actually publishes.",
    );
    console.log("");
    return false;
  }
}

/** Step 3 -- a raw socket, before any database protocol. This is the step
 * that distinguishes the four failures the original log could not. */
function reportTcp(host: string, port: number): Promise<boolean> {
  console.log("--- tcp ---");
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (ok: boolean, detail: string) => {
      socket.destroy();
      line(ok ? "connected" : "FAILED", detail);
      console.log("");
      resolve(ok);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on("connect", () => settle(true, `${host}:${port} accepted a TCP connection`));
    socket.on("timeout", () =>
      settle(
        false,
        `no answer in ${CONNECT_TIMEOUT_MS / 1000}s -- packets are going nowhere.\n` +
          "                       The address resolves but nothing is accepting on it: wrong\n" +
          "                       port, a private network the two services do not share, or a\n" +
          "                       database that is not actually running.",
      ),
    );
    socket.on("error", (err) => {
      const code = "code" in err ? String(err.code) : "unknown";
      const hint =
        code === "ECONNREFUSED"
          ? "something answered and refused -- the host is right, the port is probably wrong"
          : code === "EHOSTUNREACH" || code === "ENETUNREACH"
            ? "no route to that address -- the two services are likely not on the same private network"
            : "see the error code";
      settle(false, `${code} -- ${hint}`);
    });
  });
}

/** Step 4 -- only now the database itself. Reaching this step at all proves
 * the network is fine, so anything that fails here is credentials or naming. */
async function reportPostgres(cfg: {
  host: string;
  port: number;
  user: string;
  database: string;
}): Promise<boolean> {
  console.log("--- postgres ---");
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: process.env.POSTGRES_PASSWORD,
    database: cfg.database,
    // The whole reason this script exists: never inherit `pg`'s
    // wait-forever default.
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query("select 1 as ok");
    line("handshake", "accepted");
    line("select 1", String(result.rows[0]?.ok ?? "(no row)"));
    console.log("");
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "";
    const message = err instanceof Error ? err.message : String(err);
    line("FAILED", `${code ? `${code} -- ` : ""}${message}`);
    console.log(
      "\nThe network was fine (tcp succeeded above), so this is the database\n" +
        "refusing us: wrong user, wrong password, or no such database.",
    );
    console.log("");
    return false;
  } finally {
    await client.end().catch(() => {
      // Closing a connection that never opened throws; irrelevant here and
      // must not mask the real finding above.
    });
  }
}

async function main(): Promise<void> {
  // Same guarded loader every other entry point uses -- a missing `.env` is
  // normal in a container, where real variables are injected directly
  // (ticket 17d14b1, F1: an unguarded `process.loadEnvFile()` here is what
  // crash-looped this very image once before).
  loadEnvFile();

  console.log("database preflight -- see apps/api/src/scripts/preflight-db.ts\n");
  const cfg = reportConfig();

  if (!(await reportResolution(cfg.host))) process.exit(1);
  if (!(await reportTcp(cfg.host, cfg.port))) process.exit(1);
  if (!(await reportPostgres(cfg))) process.exit(1);

  console.log("all four checks passed -- this container can reach and use the database.");
}

void main().catch((err: unknown) => {
  // A throw from the harness itself, not from a check. Report it as such so
  // it is not mistaken for a finding about the database.
  console.error("preflight itself failed:", err);
  process.exit(1);
});
