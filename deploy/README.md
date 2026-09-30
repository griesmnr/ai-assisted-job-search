# Deploying a live environment (ticket 17d14b1)

Two paths: **Railway** (recommended) or **any Docker host** via the
compose file in this directory. Both need the same six pieces running:
Postgres, RabbitMQ, the API, the two workers, and the web frontend.

Neither path can be completed by an agent — creating a hosting account and
attaching billing is a real-money action only the account owner can take.
Everything up to that point (images, config, migration order) is done;
what's left is the account-creation step itself plus setting the env vars
below.

**Read "What this costs" and "Before you share the URL" first.** This
deployment spends money in two independent places — the host, and your
Anthropic key — and the second one is the one that can be run up by other
people.

## What this costs

**Railway has no free tier.** New accounts get a one-time trial credit and
then need a paid plan; there is no perpetual-free option to settle into.
Ticket 950911d exists because the first version of this document said
"Railway (recommended)" and mentioned billing without ever naming that,
which is a real omission rather than a detail: Nicole hit the end of the
trial credit unexpectedly and reasonably asked whether she'd been pointed at
something she could not afford to keep.

**What the monthly figure will be for THIS app is usage-dependent, and this
document deliberately does not guess.** Railway meters on resources
consumed, and this app runs six always-on services, two of which (Postgres
and RabbitMQ) are the memory-hungry ones. Rather than inherit a number that
rots, do this:

1. Check Railway's current pricing page for the plan's base price and what
   usage allowance it includes. These change.
2. Deploy, then watch your project's own usage/estimated-cost view for two
   or three days of normal use. That gives you a real figure for your
   actual traffic instead of an estimate for someone else's.

If the answer is higher than you want, the honest tradeoff is not a cheaper
managed host — it's whether you want to be a sysadmin:

| Option                       | Ongoing money                     | Ongoing effort                                                              |
| ---------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| Railway (this guide)         | trial credit, then paid & metered | near zero — no machine to patch, no TLS to renew                            |
| A small VPS (Hetzner, DO, …) | low, fixed                        | you own the OS: SSH, firewall, TLS renewal, updates, and the 2am outage     |
| Oracle Cloud "Always Free"   | genuinely $0                      | same as a VPS, plus a signup process widely reported as difficult           |
| Render / Fly.io              | paid, per-service                 | low, but six services priced individually adds up; RabbitMQ is self-managed |

The free options are not free. They move the cost from money to your
evenings. **Nicole chose Railway knowing this** (2026-09-30): "I want to
have an authentic version of the app... I don't want to be turning it on and
off again. You don't need to patch it together just to make it free. I want
a whole operational app."

Two shapes that were considered and **declined**, recorded so they are not
re-proposed as savings:

- **Splitting the frontend onto Vercel's free tier** and hosting only the
  backend. This genuinely works — `apps/web` is a plain `vite build` and
  talks to the API purely over HTTP via `VITE_API_BASE_URL`, so it will
  deploy to Vercel unmodified. But Vercel cannot host the rest: the two
  workers are always-on RabbitMQ consumers and Vercel has no always-on
  compute at all, and there is no Vercel equivalent of RabbitMQ. Once
  you're paying for an always-on backend anyway, the split only adds a
  second platform to operate. Do it if you want Vercel's CDN or its preview
  deploys — not as a cost measure.
- **Bringing the backend up only for demos.** Cheapest correct answer for a
  single reviewer, and explicitly rejected: the app is meant to be
  continuously available to several people.

## Why Railway

The app needs a long-running API process, two long-running worker
processes, Postgres, and RabbitMQ, all running simultaneously and talking
to each other — that rules out static hosts and most serverless platforms
outright. Railway runs arbitrary long-lived containers from a Dockerfile,
has first-party Postgres, and has a community RabbitMQ template, all
inside one project/one bill.

**Do not "optimize" the two workers into one process, or into the API, to
shave hosting cost.** They are separate deliberately: the message-driven
fan-out (API publishes → source workers fetch → scoring workers score) is
the thing this project exists to demonstrate, and it is what gives retries,
DLQs and idempotency somewhere real to live. See CLAUDE.md's "Why RabbitMQ
is the honest architecture here". Collapsing them would save a few dollars
and delete the point.

## Before you share the URL

**There is no login, and every search spends your Anthropic credit.**

This is the one thing about going live that can cost you money you did not
choose to spend. Verified against the code, 2026-09-30:

- A user's identity is a UUID the browser mints for itself and sends in an
  `x-user-id` header. It is unsigned and unverified by design (see
  `apps/api/src/identity.ts`) — it identifies a browser, it does not
  authenticate anyone.
- There is **no rate limiting** on the API, and **no global or per-user
  spend cap** in this codebase. `grep` for either comes back empty.
- The app does estimate a search's cost and show it before you confirm, but
  that is one search's estimate shown to one user. Nothing limits how many
  searches happen, or how many people run them.

So anyone who has the `web` URL can run real scoring jobs against your key,
as many times as they like. That is fine for a handful of people you invited.
It is not fine for a link that escapes.

**Do this before the URL leaves your hands:** set a hard spend limit on the
Anthropic account itself, in the Anthropic Console. That is the only control
here that nothing in this app can route around — it does not depend on
anyone behaving, and it fails closed. Pick a number you would be annoyed but
not hurt to lose.

A server-side daily budget guard would be the belt-and-braces version and is
not built. If you want it, file it — it is application work, not deployment
work, and the account-level cap is the thing that actually protects you
either way.

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
   deploy. (This intentionally differs from `docker-compose.prod.yml`'s
   `rabbitmq:3.13.7-management` below — that pin matches this repo's own
   dev `docker-compose.yml`, already tested against this app's actual
   queue topology; Railway's guide is the better source for what Railway
   itself currently recommends. Not a version this app requires either
   way — nothing in `apps/api` pins a RabbitMQ server version.)
   **Cross-service hosts on Railway are not the values shown in
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

   | Variable                                                      | Value                                                                                                                                                                                                  |
   | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `PORT`                                                        | Railway sets this automatically — don't override it                                                                                                                                                    |
   | `POSTGRES_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB`     | from the Postgres service, step 2                                                                                                                                                                      |
   | `RABBITMQ_HOST` / `_PORT` / `RABBITMQ_DEFAULT_USER` / `_PASS` | from the RabbitMQ service, step 3                                                                                                                                                                      |
   | `ANTHROPIC_API_KEY`                                           | a real key — this is what makes resume scoring cost real money per search, keep it out of any log. **Set an account-level spend limit before sharing the URL — see "Before you share the URL" above.** |
   | `CORS_ALLOWED_ORIGIN`                                         | the `web` service's real public URL once step 8 gives you one (`https://....up.railway.app`) — circular on the very first deploy, see the note below                                                   |
   | Job-source keys/tokens                                        | everything under `.env.example`'s USAJOBS/Greenhouse/Lever/etc. sections, if you want those sources live                                                                                               |

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
   and ticket `27a32bf` before assuming "my resumes" is broken. If you're
   bringing over data from your OWN local environment specifically (not a
   pre-auth historical dump), see "Bringing over your local data" below —
   different scenario, different fix, not the legacy-user one.

10. **Verify it works before you show anyone** (per Nicole's own stated
    plan): open `web`'s URL, paste a resume, run a real search against one
    source, confirm results land. Originally written as "before asking Jay
    to test"; as of 2026-09-30 Jay is no longer the only intended audience
    ("Jay isn't the only one I want to show"), which is also why the
    always-on shape was chosen over a per-demo one. This ticket's Dockerfiles and configs
    were verified by careful reading and by exercising individual pieces
    directly (drizzle-kit against a missing `.env`, a `vite build` with a
    blank `VITE_API_BASE_URL`, `@fastify/cors` against each
    `CORS_ALLOWED_ORIGIN` shape) — Docker itself is not installed in the
    dev container this was built in, so neither image has actually been
    built and run end to end yet. This step is that first real end-to-end
    check, not optional polish on top of one.

## Bringing over your local data (ticket f19f589, optional, one-time)

If you've been dogfooding this app locally (Nicole has), your real
resumes, searches, and scored jobs live entirely in your local Postgres
today. There's no reason to lose that just because the deployed database
starts empty — a standard Postgres dump/restore carries it straight
over, plus one identity gotcha that has nothing to do with the database
itself.

**Do this dump/restore BEFORE the `api` service's first boot** (step 4
above) — before it ever runs `drizzle-kit migrate` against the Railway
Postgres. Restoring a full schema+data dump into an already-migrated
(but still empty) database throws "relation already exists" errors for
every table. Order: create the Postgres service (step 2), restore into
it while it's still genuinely empty, _then_ add the `api` service — its
migration step will correctly see every migration already applied (your
dump already ran every one of them locally) and do nothing further.

1. **Dump your local database** (run on your Mac host, wherever
   `docker compose` runs today):

   ```bash
   docker compose exec postgres pg_dump -U jobsearch -d jobsearch \
     --no-owner --no-privileges -F c -f /tmp/jobsearch-dump.pgdump
   docker compose cp postgres:/tmp/jobsearch-dump.pgdump ./jobsearch-dump.pgdump
   ```

2. **Restore into Railway's Postgres, using `DATABASE_PUBLIC_URL` —
   specifically NOT `DATABASE_URL` or the plain `PG*` variables.** Opus
   review, blocker: those all resolve to `postgres.railway.internal`,
   reachable only from INSIDE Railway's own private network (the exact
   thing step 3 above already warns about for cross-service host values)
   — from your Mac, that fails with a DNS error that gives no hint of the
   real cause. `DATABASE_PUBLIC_URL` (same service's Variables tab) is
   the one that's actually reachable from outside Railway.

   Opus review round 2: Railway's databases are **private by default** as
   of mid-2026 — `DATABASE_PUBLIC_URL` will not exist in the Variables
   tab at all until you turn public access on. On the Postgres service:
   Settings → Networking → enable **Public Networking / TCP Proxy**. That
   creates the proxy and populates `DATABASE_PUBLIC_URL`. It's fine to
   turn public access back off once the restore is done — the `api`
   service never needs it, only this one manual step does — and worth
   doing, since a public proxy bills network egress and has no reason to
   stay open afterward.

   ```bash
   pg_restore --no-owner --no-privileges \
     -d "<Railway's DATABASE_PUBLIC_URL>" \
     jobsearch-dump.pgdump
   ```

   Needs `pg_restore` installed locally. macOS: `brew install libpq` —
   but that formula is keg-only and does NOT put its binaries on `PATH`
   by itself (opus review); also run:

   ```bash
   export PATH="$(brew --prefix libpq)/bin:$PATH"
   ```

   in the same shell before calling `pg_restore`, or you'll see
   `pg_restore: command not found` next. A GUI client (TablePlus, Postico)
   works too if you'd rather not touch the CLI — but only if it exports
   the WHOLE database, not just the `public` schema: drizzle's own
   migration-tracking table lives in a separate `drizzle` schema, and
   that table is what makes step 3's ordering claim ("the migration step
   will see everything already applied") actually true. A `public`-only
   export drops it, and `api`'s first boot then re-runs all 18+
   migrations against a database that already has every table.

   If you get the order wrong and `api` has already migrated before you
   restore, `pg_restore --clean --if-exists ...` (same command, two added
   flags) drops and recreates each object instead of erroring on it —
   but plain `pg_restore` does NOT abort on the first error by default,
   so a partial run without `--clean` can leave a confusing half-restored
   mix rather than a clean failure. Getting the order right the first
   time (this section's whole point) is still the better plan.

3. **The identity gotcha — do this before your first real click on the
   deployed site, not after.** This app's anonymous identity is
   client-asserted, never server-generated (`apps/web/src/identity.ts` /
   `apps/api/src/identity.ts`'s own documented invariant), and it lives in
   the _browser's_ localStorage, scoped per **origin**. Your local app
   runs on `localhost`; the deployed site is a different origin entirely
   — so a fresh visit there mints a brand-new, unrelated anonymous id, and
   none of the data you just restored will appear to belong to it (the
   exact "My Resumes looks wiped" symptom ticket `27a32bf` describes for a
   different cause).

   This is NOT (necessarily only) the `LEGACY_USER_ID` case step 9 above
   covers — and your local database may well contain BOTH kinds of data
   at once: your own browser's real id from normal use, AND rows still
   under `LEGACY_USER_ID` from any `demo-match.ts` CLI runs (its default
   owner). `reassign-legacy-resumes.ts` only ever moves data away from
   that one specific legacy placeholder id, never between two arbitrary
   real ids, so it can't do what this step needs on its own — but you may
   still want to run it too, for the `LEGACY_USER_ID` half, AFTER doing
   the identity fix below (that script refuses to run until a real
   `users` row already exists for its target id, which the localStorage
   step is what creates).

   The fix for your OWN browser's data doesn't need a script at all — you
   can just make your browser claim the SAME id on both sites:

   - On your **local** app, open devtools console:
     ```js
     localStorage.getItem("jobsearch.web.userId.v1");
     ```
     Copy the value it prints.
   - On the **deployed** site, before doing anything else there, open
     devtools console and run:
     ```js
     localStorage.setItem("jobsearch.web.userId.v1", "<the value you copied>");
     ```
     then reload the page. (If you'd also verified an email locally,
     copy `jobsearch.web.userEmail.v1` the same way so the deployed site
     doesn't re-prompt you to sign in — cosmetic only, but saves a step.)

   Your browser is now the same anonymous identity on both sites, the
   data you restored already belongs to it, and everything appears
   immediately — no reconciliation step needed for this half.

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
