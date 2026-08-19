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
service is "always ours" and belongs in the default `--scope private` file.
(A normal app-infra repo splits `compose.yml` from `public/compose.yml`;
local-infra, like `gentick-infra`, is a pure provider with one compose file.)

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
./svc-start.sh                # 2. render the broker config, then bring the stack up
```

`svc-start.sh` first runs `svc-gen-nanomq.sh` — NanoMQ has no env templating, so
its password file (`nanomq/nanomq_pwd.conf`) and ACL (`nanomq/nanomq_acl.conf`)
are rendered from the same `.env` values the app clients dial with. Both are
gitignored and absent on a fresh clone; generating them **before** the broker
starts is what stops docker bind-mounting an empty directory in their place (the
broker then crash-loops with `input in flex scanner failed`). `svc-start.sh` then
brings the stack up, `--scope private` by default (the whole provider stack).

Docker runs inside WSL on this box, so run it there:
`wsl -e bash -lc 'cd /srv/local-infra && ./svc-start.sh'`.

Check it: `curl -s http://localhost/healthz` → `ok`, and
`docker ps` shows `nginx postgres mqtt questdb redis` healthy.

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
   cd /c/dev/local-infra && ./boot.sh
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
  `postgres/`, `questdb/`, `redis/`, `mqtt-broker/`. This is **outside the repo
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

`backend-net` is declared `external: true` here **and** in every app stack —
nobody owns it in a compose file. `svc-start.sh` creates a plain `backend-net`
if it is missing, and everyone else looks it up. Bring **local-infra up first** on
a fresh box so it triggers the create; then start each app's private stack.

If you ever see `network backend-net ... has incorrect label
com.docker.compose.network`, an app stack that (wrongly) tried to *own* the
network created a mislabelled one. Fix: stop the stacks, `docker network rm
backend-net`, start local-infra first.

---

## The service scripts

Canonical copies from `agollum/docker/services/` — edit them there and copy the
whole set across, never hand-edit one (they source each other; a half-updated
set fails like a bug in the file you didn't touch).

| Script | Does |
|---|---|
| `svc-build-env.sh` | Build `.env` from `.env.example` + the pragma creds |
| `svc-start.sh` | Bring services up and wait for health (`--scope private` default) |
| `svc-stop.sh` | Bring them down |
| `svc-update.sh` | Pull images and recreate |
| `svc-image-purge.sh` | Remove images from the local cache (prompts — it destroys) |
| `svc-compose.sh` | Shared helpers, sourced by the others |
| `svc-gen-nanomq.sh` | Render `nanomq_pwd.conf` + `nanomq_acl.conf` from `.env`; run automatically by `svc-start.sh` |

**Scope note.** local-infra has only `compose.yml`, so use the default
`--scope private` (or no flag). `--scope public`/`--scope all` have no file to
select here and will error — there is nothing "public vs private" to split when
the repo *is* the public provider.

---

## Layout

```
local-infra/
  compose.yml                 the five shared services
  .env.example                committed template (replace- = secret); .env gitignored
  .gitignore  .gitattributes
  svc-*.sh                    canonical service scripts (from agollum)
  svc-gen-nanomq.sh           render nanomq pwd + acl from .env (called by svc-start)
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
