# Deploying a live environment (ticket 17d14b1)

Two paths: **Railway** (recommended) or **any Docker host** via the
compose file in this directory. Both need the same six pieces running:
Postgres, RabbitMQ, the API, the two workers, and the web frontend.

Neither path can be completed by an agent — creating a hosting account and
attaching billing is a real-money action only the account owner can take.
Everything up to that point (images, config, migration order) is done;
what's left is the account-creation step itself plus setting the env vars
below.

## Why Railway

The app needs a long-running API process, two long-running worker
processes, Postgres, and RabbitMQ, all running simultaneously and talking
to each other — that rules out static hosts and most serverless platforms
outright. Railway runs arbitrary long-lived containers from a Dockerfile,
has first-party Postgres, and has a community RabbitMQ template, all
inside one project/one bill.

## Railway setup

1. **Create a Railway account and a new empty project.**
2. **Add a Postgres service** (Railway's built-in template, "+ New" →
   "Database" → "PostgreSQL"). Note the connection details it generates —
   Railway exposes them as `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`
   on that service, but **this app reads `POSTGRES_*` names, not `PG*`**
   (see `.env.example`) — map them explicitly in step 5, don't rely on
   Railway's names matching.
3. **Add a RabbitMQ service.** Railway has no first-party RabbitMQ
   offering, but publishes its own guide for deploying one from the
   template marketplace ("Deploy RabbitMQ and Wire Up Producers and
   Consumers" in Railway's docs), which recommends image
   `rabbitmq:4-management` — follow that guide rather than a manual
   deploy. **Cross-service hosts on Railway are not the values shown in
   each service's own Variables tab** — reachability between services goes
   over Railway's private network at `<service>.railway.internal`,
   referenced as `${{ServiceName.RAILWAY_PRIVATE_DOMAIN}}` (the same is
   true of Postgres — `${{Postgres.PGHOST}}`, used below, already resolves
   there). Copying a literal host string out of either service's own
   settings UI is the wrong value here.
4. **Add the `api` service**: "+ New" → "GitHub Repo" (or "Empty Service" +
   manual deploy), root directory `/`, Dockerfile path
   `deploy/api.Dockerfile`. Railway builds from the repo root by default,
   which is required here (see the Dockerfile's own header).
5. **Set `api`'s environment variables** (Railway service → Variables):

   | Variable                                                      | Value                                                                                                                                                |
   | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PORT`                                                        | Railway sets this automatically — don't override it                                                                                                  |
   | `POSTGRES_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB`     | from the Postgres service, step 2                                                                                                                    |
   | `RABBITMQ_HOST` / `_PORT` / `RABBITMQ_DEFAULT_USER` / `_PASS` | from the RabbitMQ service, step 3                                                                                                                    |
   | `ANTHROPIC_API_KEY`                                           | a real key — this is what makes resume scoring cost real money per search, keep it out of any log                                                    |
   | `CORS_ALLOWED_ORIGIN`                                         | the `web` service's real public URL once step 8 gives you one (`https://....up.railway.app`) — circular on the very first deploy, see the note below |
   | Job-source keys/tokens                                        | everything under `.env.example`'s USAJOBS/Greenhouse/Lever/etc. sections, if you want those sources live                                             |

   Railway also supports referencing another service's variables directly
   (`${{Postgres.PGHOST}}` syntax) instead of copy-pasting — use that where
   the names don't need renaming, and a plain value where they do (e.g.
   `POSTGRES_HOST` = `${{Postgres.PGHOST}}`).

6. **Add two more services from the same repo + same Dockerfile**
   (`worker-fetch-source`, `worker-score-job`), each with a **Custom Start
   Command** override (Railway service → Settings → Deploy):
   - `worker-fetch-source`: `node dist/worker/run-fetch-source-worker.js`
   - `worker-score-job`: `node dist/worker/run-score-job-worker.js`

   Give both the same Postgres/RabbitMQ variables as `api` (skip
   `CORS_ALLOWED_ORIGIN` and `PORT` — neither worker serves HTTP).
   `worker-score-job` also needs `ANTHROPIC_API_KEY`.

   Only `api`'s container should run migrations (its Dockerfile `CMD` does
   this automatically before starting the server, on **every** boot and
   redeploy, not just the first one — `drizzle-kit migrate` is idempotent
   against already-applied migrations, so this is harmless, just not
   "once") — that's why the workers get a _Custom Start Command_ instead
   of running the default `CMD`, which would otherwise run it redundantly
   from three containers on every restart.

7. **Add the `web` service**: same repo, Dockerfile path
   `deploy/web.Dockerfile`, with one **required build argument**:
   `VITE_API_BASE_URL` = the `api` service's real public URL (Railway
   assigns one once you enable public networking on that service — Service
   → Settings → Networking → "Generate Domain"). This is a _build_ arg,
   not a runtime variable — Railway's build-arg support is under the same
   Settings → Build page. The image build fails loudly if this is left
   blank (deploy/web.Dockerfile's own guard) rather than silently shipping
   a broken frontend. `VITE_RESUME_OPTIMIZER_APP_URL` (apps/web/src/api/
   client.ts) is a second, optional build-time var with a sane default —
   only set it if the separate resume-tailoring app's own URL needs
   overriding.
   No variable is needed for the port Railway assigns `web` at runtime —
   the image reads `PORT` itself (deploy/web.nginx.conf.template) the same
   way `api` does.

8. **Enable public networking** (Settings → Networking → "Generate
   Domain") on both `api` and `web`. Once both have real URLs:
   - go back to `api`'s variables and set `CORS_ALLOWED_ORIGIN` to `web`'s
     URL (step 5's circularity resolves here — Railway redeploys `api`
     automatically when you save a variable change)
   - go back to `web`'s build args if `api`'s URL changed since step 7, and
     redeploy `web`

9. **First-run data note (ticket b2f9dfd / 3fc1e5e):** every pre-existing
   resume in a fresh Postgres is empty on a brand-new database — nothing
   to reconcile. If you ever restore a dump that has data under
   `LEGACY_USER_ID`, see `apps/api/src/scripts/reassign-legacy-resumes.ts`
   and ticket `27a32bf` before assuming "my resumes" is broken.

10. **Verify before asking Jay to test** (per Nicole's own stated plan):
    open `web`'s URL, paste a resume, run a real search against one
    source, confirm results land. This ticket's Dockerfiles and configs
    were verified by careful reading and by exercising individual pieces
    directly (drizzle-kit against a missing `.env`, a `vite build` with a
    blank `VITE_API_BASE_URL`, `@fastify/cors` against each
    `CORS_ALLOWED_ORIGIN` shape) — Docker itself is not installed in the
    dev container this was built in, so neither image has actually been
    built and run end to end yet. This step is that first real end-to-end
    check, not optional polish on top of one.

## Self-host fallback: `docker-compose.prod.yml`

For any plain Docker host instead of Railway:

```bash
cp .env.example .env.prod   # then fill in REAL production values --
                             # see docker-compose.prod.yml's own :? guards
                             # for exactly which variables are required,
                             # plus CORS_ALLOWED_ORIGIN / VITE_API_BASE_URL,
                             # which .env.example doesn't have (dev doesn't
                             # need them -- see index.ts / client.ts)
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
```

This brings up all six services on one Docker network, with `web` on
`:8080` and `api` on `:3000` published to the host. Put a real reverse
proxy (Caddy, nginx, Traefik) with TLS in front of both if this is
reachable from the public internet — this compose file does not terminate
TLS itself, matching the dev compose file's own scope (infra only, no
certs).
