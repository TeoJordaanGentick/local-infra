# local-infra

**Local shared infrastructure for this dev box** — the leaner, local equivalent
of `gentick-infra`. It provides the shared PUBLIC backing services that every
app on this machine reaches *by name* over one docker network, so each app can
run its own PRIVATE stack alongside it instead of every app bringing up its own
`postgres`/`nginx` and colliding on ports `5432`/`80`.

> **The problem it solves.** Each app's standalone infra (`talosot-edge-infra`,
> `rms-infra`, …) can bring up its own `public/` services — `nginx`, `postgres`,
> `mqtt`, `questdb`. Two of those cannot coexist on one box: they fight over the
> container name `postgres`, the port `5432`, the port `80`. So the box runs
> *one* app at a time. local-infra breaks that: it owns the shared services once,
> and every app runs only its own `compose.yml` (`--scope private`) against them.
>
> It is the **local** stand-in for what `gentickit.local` gets from
> `gentick-infra`. It is deploy-ready by construction but is **not wired to any
> server** — it is for this workstation.

---

## Services provided

All five live in `compose.yml` and come up together. There is **no `public/`
split** here: local-infra *is* the provider, so from its own standpoint every
service is "always ours" and belongs in the single `compose.yml`. (A normal
app-infra repo splits `compose.yml` from `public/compose.yml`; local-infra, like
`gentick-infra`, is a pure provider with one compose file, brought up with
`docker compose` directly.)

| Service | Image | Reached by apps as | Host port (loopback unless noted) |
|---|---|---|---|
| `nginx` | `nginx:alpine` | — (serves browsers) | `80` — **all interfaces**, so `localhost` works |
| `postgres` | `postgres:18.4-alpine` | `postgres:5432` | `127.0.0.1:5432` |
| `mqtt` (NanoMQ) | `emqx/nanomq:0.24.13-full` | `mqtt:1883` (tcp), `mqtt:8083` (ws) | `127.0.0.1:1883`, `127.0.0.1:8083` |
| `questdb` | `questdb/questdb:9.4.0` | `questdb:9009` (ILP), `questdb:8812` (pgwire), `questdb:9000` (HTTP) | `127.0.0.1:9000` (console only) |
| `redis` | `redis:8.8.0` | `redis:6379` | `127.0.0.1:6379` |

**Why these five.** `talosot` needs `nginx`, `mqtt`, `postgres`, `questdb`;
`rms` needs `nginx`, `postgres`. `redis` is included for parity with
`gentick-infra` and near-term use — **no local app consumes it today**; drop its
block from `compose.yml` for an even leaner box. `safaura` has no infra yet and
adds nothing. `mariadb`, `cloudflared`, `leantime`, `vaultwarden`, `mailpit`,
`n8n` from `gentick-infra` are server- or app-specific and are intentionally
absent — add one only when a local app truly needs it.

---

## Quick start

The contract every infra repo keeps: **build `.env`, bring it up, done.**

```bash
cd /c/dev/local-infra           # (WSL: /mnt/c/dev/local-infra — docker lives in WSL)

./svc-build-env.sh            # 1. build .env from .env.example + the pragma creds
./svc-gen-nanomq.sh           # 2. render the broker password + ACL files from .env
docker compose up -d          # 3. bring the stack up
```

NanoMQ has no env templating, so its password file (`nanomq/nanomq_pwd.conf`) and
ACL (`nanomq/nanomq_acl.conf`) are rendered from the same `.env` values the app
clients dial with. Both are gitignored and absent on a fresh clone; generating
them **before** the broker starts is what stops docker bind-mounting an empty
directory in their place (the broker then crash-loops with `input in flex scanner
failed`). Always run `svc-gen-nanomq.sh` before `docker compose up`.

Docker runs inside WSL on this box, so run it there:
`wsl -e bash -lc 'cd /srv/local-infra && ./svc-build-env.sh && ./svc-gen-nanomq.sh && docker compose up -d'`.

Check it: `curl -s http://localhost/healthz` → `ok`, and
`docker ps` shows `nginx postgres mqtt questdb redis` healthy.

> Like `gentick-infra`, this repo carries only `svc-build-env.sh` and
> `svc-gen-nanomq.sh` — no `svc-start.sh` or scope machinery. It is a pure
> provider with a single `compose.yml`, started and stopped with `docker compose`
> directly.

---

## Domains and routes

nginx routes by `server_name`, and **every name resolves with no hosts-file
edit** — the per-app names use the `.localhost` TLD, which browsers send to
127.0.0.1 automatically (RFC 6761). `localhost` is the talosot default vhost.

| URL | Vhost serves | `/api/` proxies to | Other |
|---|---|---|---|
| `http://localhost/` | talosot Flutter SPA (`nginx/html/talosot`) | `talosot-api:8080` | `/mqtt` WS → `mqtt:8083`; `/emu/` → `nginx/html/talosot-emulator` |
| `http://talosot.localhost/` | same as above | `talosot-api:8080` | same |
| `http://rms.localhost/` | rms React SPA (`nginx/html/rms`) | `rms-api:8080` | — |

The web bundles are **bind-mounted** from `nginx/html/<app>/`; nginx serves them
straight from the working tree. On a fresh clone each holds only a placeholder
landing page — populate it per app (below).

### Per-app hostnames (`*.localhost`) — no setup

Each app also answers on its own `*.localhost` name — `talosot.localhost`,
`rms.localhost`. **Browsers resolve any `.localhost` name to `127.0.0.1` on their
own** (RFC 6761), so there is nothing to configure: no hosts file, no DNS server,
no admin. This is what lets a *second* app be reached by name while `localhost`
stays the talosot default.

The one gap is non-browser tooling: `curl.exe` and other OS-level resolvers do
**not** honour `*.localhost`. If you ever need one to — a scripted health check
against `talosot.localhost` from Windows, say — add a line to the OS hosts file
(**admin**, per-developer, so it is not in the repo):

- Windows: `C:\Windows\System32\drivers\etc\hosts`
- WSL/Linux: `/etc/hosts`

```
127.0.0.1  talosot.localhost rms.localhost
```

To make a *different* app the `localhost` default, move `default_server` to its
`listen` line in `nginx/nginx.conf`.

---

## Switching an app from its standalone stack to local-infra

This is the whole point. Worked example with **talosot**:

**Before (standalone, one app per box):** talosot brings up its own backing
services and its app services together —
`cd talosot-edge-infra && ./svc-start.sh --scope all`. That starts a local
`nginx`/`postgres`/`mqtt`/`questdb` **and** `talosot-api`/`talosot-nexus`.

**After (alongside local-infra):**

1. Bring up the shared services **first**:
   ```bash
   cd /c/dev/local-infra && ./svc-build-env.sh && ./svc-gen-nanomq.sh && docker compose up -d
   ```
2. Put the talosot web bundle where local-infra's nginx serves it — build it into
   `local-infra/nginx/html/talosot/` (and the emulator into
   `nginx/html/talosot-emulator/`**`emu/`** — it is served at `/emu/` and nginx
   uses `root`, so the bundle lives one folder deep), or copy an existing build in. (The agollum
   Flutter build script is the house tool for this — it already targets a
   shared nginx html dir for `gentick-infra`; point it at local-infra's.)
3. Start **only** talosot's private services — its `api` and `nexus`:
   ```bash
   cd /c/dev/talosot/Edge/talosot-edge-infra && ./svc-start.sh --scope private
   ```
   `--scope private` selects `compose.yml` (api + nexus only). It does **not**
   start `public/` — that is the collision you are avoiding. The two Go services
   join `backend-net` and reach `postgres`, `mqtt`, `questdb` by name — the same
   names local-infra registered.
4. Browse `http://localhost/`.

The app needs no code change: talosot's `.env` already points `POSTGRES_HOST`,
`MQTT_HOST`, `QUESTDB_HOST` at the shared service names and joins
`SHARED_NETWORK=backend-net`. local-infra registers exactly those names. That is
why the `.env` key names here are deliberately identical to the apps' — see
*Credentials* below.

> **Do NOT run `--scope all` (or `--scope public`) in an app repo while
> local-infra is up.** That starts a *second* `postgres`/`mqtt` on the same
> network. Two containers cannot both answer to `mqtt`, and what you get is not
> an error — it is an app quietly talking to an empty database, or a subscriber
> listening to a broker nobody publishes to. No log line says so. This is the
> entire reason the private/public split exists.

---

## Add another app (the rms / safaura pattern)

The `rms.localhost` server block in `nginx/nginx.conf` is the template. To wire a
new app `foo`:

1. **nginx** — copy the rms `server { … }` block, then change:
   - `server_name foo.localhost;`
   - `root /usr/share/nginx/html/foo;`
   - the `/api/` upstream to your app's **container** name, e.g.
     `set $api http://foo-api:8080;` (container name, not the service name `api`
     — that is unprefixed and any stack could claim it).
2. **hostname** — none needed: `foo.localhost` resolves in browsers automatically
   (only add an OS hosts entry if a non-browser tool must reach it — see above).
3. **bundle** — create `nginx/html/foo/` and put the app's web build there.
4. **credentials** — if `foo` needs a service local-infra doesn't provide yet, add
   it to `compose.yml` and reuse the shared `.env` key names (or add new keys to
   the pragma). For a broker account, add the username to `nanomq/nanomq_acl.conf`
   and a matching `MQTT_*` pair.
5. Start `foo`'s private stack: `cd foo-infra && ./svc-start.sh --scope private`.

**rms** today needs only `nginx` + `postgres`, both already provided — so rms
needs nothing added here; just steps 2–3 and starting `rms-infra --scope
private` (which brings up `rms-api` + `n8n`). **safaura** has no infra repo and
no backing-service dependencies yet, so there is nothing to wire until
`safaura-nexus` is built out.

> This first cut fully wires **talosot on `localhost`** and ships the **rms
> vhost as a working template**. It does not pre-build rms/safaura bundles or
> start their private stacks — that is the per-app step above.

---

## Where data lives

- **Host level.** Everything persistent is under `${HOST_DATA_ROOT}` (default
  `/srv/data`), set per-machine in `.env` — it is the one value that genuinely
  varies per host:
  `postgres/data/`, `questdb/`, `redis/`, `mqtt-broker/` (postgres nests its
  cluster under `postgres/data/` so the `postgres/` parent stays free for
  backups/dumps without fouling the strict-perms data dir). This is **outside the repo
  on purpose** — a data directory under a git working tree is one `git clean`
  from gone. Because it is the same root the app stacks use, local-infra serves the
  **same** cluster/data the standalone stacks did.
- **One postgres cluster, many databases.** `POSTGRES_DB` (default `gentick`) is
  only the cluster's first-boot default database. Each app owns its own database
  inside the cluster (`talosot`, `gentick_rms`, …); those are created by the app
  (or by hand) — not re-initialised here. On an already-initialised data root the
  `POSTGRES_*`/`QUESTDB_*` init values are ignored.
- **Nothing secret is committed.** `.env`, `nanomq/nanomq_pwd.conf` and
  `nanomq/nanomq_acl.conf` are gitignored (all generated at bring-up from `.env`);
  only `.env.example`, `nanomq_pwd.conf.example` and `nanomq_acl.conf.example` are
  tracked.

---

## Credentials (`.env`)

`.env.example` is the single declaration of what the stack needs. A value
starting with `replace` is a secret; `svc-build-env.sh` fills those from the
shared pragma file and refuses to write a `.env` that still holds a placeholder.

**Key names are shared on purpose.** They are identical to the ones in
`gentick-infra`, `talosot-edge-infra` and `rms-infra` (`POSTGRES_USER`,
`MQTT_USER`, `QUESTDB_USER`, `REDIS_PASSWORD`, …). The pragma is flat and shared
across every stack on the box, so one entry serves all of them — inventing a
parallel name (`PG_USER` vs `POSTGRES_USER`) is how two keys end up holding what
should be one value, and they drift.

Two silent foot-guns: a literal `$` in a secret must be **doubled** (`pa$$word`),
and never set `COMPOSE_PROJECT_NAME` (it outranks `name:` and renames every
container on the box).

---

## Ordering and the network

**local-infra OWNS `backend-net`** — its `networks:` block declares it without
`external:`, so `docker compose up` creates it (properly labelled), exactly as
`gentick-infra` does on the server. Every app stack declares it `external: true`
and only looks it up. Bring **local-infra up first** on a fresh box, then start
each app's private stack.

If you ever see `network backend-net ... has incorrect label
com.docker.compose.network`, a plain (unlabelled) `backend-net` already exists —
usually left by an older `svc-start.sh` run or by an app stack that wrongly tried
to own it. Fix: stop the stacks, `docker network rm backend-net`, then start
local-infra first so it re-creates the network with compose's labels.

---

## The service scripts

Canonical copies from `agollum/docker/services/` — edit them there and copy
across, never hand-edit one. This repo carries only the two a pure provider
needs; start and stop the stack with `docker compose` directly.

| Script | Does |
|---|---|
| `svc-build-env.sh` | Build `.env` from `.env.example` + the pragma creds |
| `svc-gen-nanomq.sh` | Render `nanomq_pwd.conf` + `nanomq_acl.conf` from `.env` — run it before `docker compose up` |

The `--scope`-aware scripts (`svc-start.sh`, `svc-stop.sh`, …) are deliberately
absent: they exist to select between `compose.yml` and `public/compose.yml`, and
local-infra has no such split — it *is* the public provider, so `--scope private`
would name the whole stack and `--scope public` would name nothing. This mirrors
`gentick-infra`, which carries the same two scripts and nothing else.

---

## Layout

```
local-infra/
  compose.yml                 the five shared services
  .env.example                committed template (replace- = secret); .env gitignored
  .gitignore  .gitattributes
  svc-build-env.sh            build .env from .env.example + pragma creds
  svc-gen-nanomq.sh           render nanomq pwd + acl from .env (run before compose up)
  nginx/
    nginx.conf                server_name routing (talosot default + rms template)
    html/<app>/index.html     bind-mount targets; placeholders until a build lands
  nanomq/
    nanomq.conf                          broker config
    nanomq_pwd.conf.example              tracked; real file generated + gitignored
    nanomq_acl.conf.example              tracked template; real file generated + gitignored
  _docs/
    VERSION  changelogs/current.md
```
