# AI-Assisted Job Search

See `CLAUDE.md` for the project stack, architecture, and development workflow.
See `SETUP_HISTORY.md` for how the sandboxed Ubuntu dev container this repo is
usually edited from was originally built by hand.

## Local Development Environment (docker-compose)

Everything below runs **on the Mac host, with Docker Desktop**, not inside the
Ubuntu sandbox container that Claude Code runs in. That sandbox has no
`docker` CLI (see `SETUP_HISTORY.md`), so this must be run from a normal
Terminal on macOS, in the project root.

Three services:

| Service    | What it is                          | Reachable from `dev` as | Reachable from Mac host as |
|------------|--------------------------------------|--------------------------|------------------------------|
| `postgres` | Postgres 16.4                        | `postgres:5432`          | `localhost:5432`             |
| `rabbitmq` | RabbitMQ 3.13.7 + management plugin  | `rabbitmq:5672`           | `localhost:5672`             |
| `dev`      | Ubuntu 24.04 + Go, Node 22, pnpm, git-bug, RTK | (this is the client) | `docker compose exec dev bash` |
|            | RabbitMQ management UI               | `rabbitmq:15672`          | `localhost:15672`            |

**Important — use service names, not `localhost`, from inside the `dev`
container.** `postgres` and `rabbitmq` are separate containers on the
`jobsearch-net` Docker network; `localhost` inside `dev` refers to the `dev`
container itself, not the other services. The `dev` service also gets
`POSTGRES_HOST=postgres` / `RABBITMQ_HOST=rabbitmq` pre-set as environment
variables for exactly this reason — application code should read the host
from those variables rather than hardcoding `localhost`.

### First-time setup

```bash
cp .env.example .env
# then edit .env and set real values for:
#   POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
#   RABBITMQ_DEFAULT_USER, RABBITMQ_DEFAULT_PASS
```

`.env` is gitignored and must never be committed. `.env.example` (committed)
documents which keys are required, with placeholder values only.

### Start everything

```bash
docker compose up -d --build
```

`--build` is only needed the first time, or after changing `Dockerfile.dev`;
`docker compose up -d` is enough after that. The `dev` service waits for
`postgres` and `rabbitmq` to report healthy (via `depends_on: condition:
service_healthy`) before it starts.

Check status:

```bash
docker compose ps
```

All three services should show as `running`/`healthy` (postgres and rabbitmq
have healthchecks; dev has no healthcheck defined so it will just show
`running`).

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

Postgres data persists across `down`/`up` in the named volume
`postgres-data`. To wipe it (start from a clean database):

```bash
docker compose down -v
```

### Rebuilding the dev image

After changing `Dockerfile.dev`:

```bash
docker compose build dev
docker compose up -d dev
```

The first build downloads and compiles `git-bug` from source, which includes
Go automatically fetching a newer toolchain than the Ubuntu 24.04 `golang-go`
package ships (git-bug's `go.mod` requires a newer Go than `apt` provides;
see the comment block at the top of `Dockerfile.dev`). This makes the first
build noticeably slower than later ones — that is expected, not a hang.
