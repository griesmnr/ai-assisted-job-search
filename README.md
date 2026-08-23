# AI-Assisted Job Search

See `CLAUDE.md` for the project stack, architecture, and development workflow.
See `SETUP_HISTORY.md` for how the sandboxed Ubuntu dev container this repo is
usually edited from was originally built by hand.

## Local Development Environment (docker-compose)

Everything below runs **on the Mac host, with Docker Desktop**, not inside the
Ubuntu sandbox container that Claude Code runs in. That sandbox has no
`docker` CLI (see `SETUP_HISTORY.md`), so this must be run from a normal
Terminal on macOS, in the project root.

Three services, but two different start commands (see below) because the
`dev` service is opt-in:

| Service    | What it is                                     | Reachable from `dev` as | Reachable from Mac host as     |
| ---------- | ---------------------------------------------- | ----------------------- | ------------------------------ |
| `postgres` | Postgres 16.4                                  | `postgres:5432`         | `localhost:5432`               |
| `rabbitmq` | RabbitMQ 3.13.7 + management plugin            | `rabbitmq:5672`         | `localhost:5672`               |
|            | RabbitMQ management UI                         | `rabbitmq:15672`        | `localhost:15672`              |
| `dev`      | Ubuntu 24.04 + Go, Node 22, pnpm, git-bug, RTK | (this is the client)    | `docker compose exec dev bash` |

Published ports are bound to `127.0.0.1` only (not `0.0.0.0`), so they're
reachable as `localhost:<port>` from the Mac itself but not from other
machines on the local network — Postgres and the RabbitMQ UI ship with a
placeholder password in `.env.example`, so this is deliberate, not a bug.

**Important — use service names, not `localhost`, from inside the `dev`
container.** `postgres` and `rabbitmq` are separate containers on the
`jobsearch-net` Docker network; `localhost` inside `dev` refers to the `dev`
container itself, not the other services. The `dev` service also gets
`POSTGRES_HOST=postgres` / `RABBITMQ_HOST=rabbitmq` pre-set as environment
variables for exactly this reason — application code should read the host
from those variables rather than hardcoding `localhost`.

### First-time setup

```bash
[ -f .env ] || cp .env.example .env
# then edit .env and fill in real values
```

That `[ -f .env ] ||` guard matters: a plain `cp .env.example .env` silently
**overwrites** an existing `.env`, and since `.env` is gitignored there is no
undo. If `.env` already has real values in it (rotated API keys, credentials
issued by hand), a bare `cp` destroys them with no recovery. The command
above only copies the template when `.env` doesn't exist yet, and does
nothing (safely) if it already does.

`.env` is gitignored and must never be committed. `.env.example` (committed)
documents every key the project uses, with placeholder or empty values only.

If `.env` is missing or missing a required key, `docker compose up` now
**fails immediately** with a one-line error naming the missing variable
(`docker-compose.yml` guards `POSTGRES_USER`/`POSTGRES_PASSWORD`/
`POSTGRES_DB`/`RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` with `:?`).
That's deliberate: without the guard, a missing var silently interpolates as
an empty string, postgres starts with no password, exits immediately, and
`restart: unless-stopped` restart-loops it forever — `up -d` would appear to
succeed while postgres cycled in the background, with the real cause buried
in `docker compose logs`.

### Start Postgres and RabbitMQ

This is the normal day-to-day command — it does **not** build or start `dev`:

```bash
docker compose up -d
```

Check status:

```bash
docker compose ps
```

`postgres` and `rabbitmq` should show `running`/`healthy`.

### Start the dev container (opt-in)

`dev` is behind a compose profile so a plain `up -d` never triggers it. Its
image compiles `git-bug` from source at a pinned tag (v0.10.1), which
includes Go downloading its own newer toolchain on a cold build cache —
a few extra minutes the first time, not 10-20: this git-bug tag ships its
web UI as pre-built, committed Go source, so there's no pnpm/Vite build in
the loop at all. Only build/start `dev` when you actually need a shell with
Go/Node/pnpm/git-bug/rtk:

```bash
docker compose --profile dev up -d --build dev
```

`--build` is only needed the first time, or after changing `Dockerfile.dev`;
after that, `docker compose --profile dev up -d dev` is enough. `dev` waits
for `postgres` and `rabbitmq` to report healthy (via `depends_on: condition:
service_healthy`) before it starts.

The image's own build includes a verification step (see the bottom of
`Dockerfile.dev`) that checks `node`, `pnpm`, `go`, `git-bug`, `rtk`, and
`pg_isready` all actually run — if any tool is broken, `docker compose build`
fails immediately with that tool's name in the output, rather than leaving a
broken shell to debug later.

### Reach each service

- **Postgres**, from the Mac host (e.g. a GUI client or `psql`):
  `localhost:5432`, using the credentials from `.env`.
- **Postgres**, from application code running in `dev`: host `postgres`, port
  `5432`.
- **RabbitMQ AMQP**, from application code running in `dev`: host
  `rabbitmq`, port `5672`.
- **RabbitMQ management UI**, from a browser on the Mac:
  [http://localhost:15672](http://localhost:15672), log in with
  `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` from `.env`.

### Get a shell in the dev container

```bash
docker compose exec dev bash
```

(Requires `dev` to already be running — see "Start the dev container" above.)

Inside that shell, `/workspace` is the project directory (bind-mounted from
the Mac host — edits made on the Mac or in this container show up in both
instantly), and `go`, `node`, `pnpm`, `git-bug`, and `rtk` are all on `PATH`.

Quick reachability check from inside that shell:

```bash
pg_isready -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# expected: "postgres:5432 - accepting connections"

curl -sS -u "$RABBITMQ_DEFAULT_USER:$RABBITMQ_DEFAULT_PASS" \
  http://rabbitmq:15672/api/overview | head -c 200
# expected: JSON starting with {"management_version":...
```

### Stop everything

```bash
docker compose down
```

This stops `postgres` and `rabbitmq` (and `dev`, if it was running) but
**keeps their data** in the named volumes `postgres-data` and
`rabbitmq-data` — including RabbitMQ's queue/exchange definitions and any
dead-lettered messages, which matter here since DLQs are a deliberate part
of this project's architecture (see `CLAUDE.md`).

To wipe all data and start clean:

```bash
docker compose down -v
```

**If you change `RABBITMQ_DEFAULT_USER` or `RABBITMQ_DEFAULT_PASS` in `.env`
after RabbitMQ has already started once**, you must `docker compose down -v`
first. RabbitMQ only applies those variables while creating a fresh data
directory on first boot; with the `rabbitmq-data` volume already populated,
it keeps the old credentials and ignores the new ones.

### Rebuilding the dev image

After changing `Dockerfile.dev`:

```bash
docker compose build dev
docker compose --profile dev up -d dev
```

The first build downloads and compiles `git-bug` from source (pinned to a
specific tag, see `Dockerfile.dev`), which includes Go automatically
fetching a newer toolchain than the Ubuntu 24.04 `golang-go` package ships
(git-bug's `go.mod` requires a newer Go than `apt` provides; see the comment
block at the top of `Dockerfile.dev` for why this is safe and expected).
This makes the first build noticeably slower than later ones — that is
expected, not a hang.
