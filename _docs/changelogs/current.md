# Changelog — local-infra

All notable changes to this repo are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this file is the rolling
unreleased section and is copied to `v<X.Y.Z>.md` at release.

## [Unreleased]

### Added
- gen1 LoRadian stage 1: a `mysql` service (8.4.13, `gen1` database on first
  boot); three NanoMQ accounts — LoRadian device, gen1-loradian-nexus and a
  read-only console — under new `GEN1_MQTT_LORADIAN_DEVICE_*`, `GEN1_MQTT_NEXUS_*` and `GEN1_MQTT_CONSOLE_*` pragma keys; nginx vhosts
  `gen-1.teojordaan.com` / `gen1.localhost` (console, `/api/` and `/query/` to
  placeholder gen1 upstreams) and `mqtt.teojordaan.com` / `mqtt.localhost`
  (`/mqtt` to the broker's WebSocket listener). Existing services, accounts and
  vhosts render unchanged.
- Initial scaffold of the local shared-infrastructure repo: the leaner, local
  equivalent of `gentick-infra`. Provides the shared PUBLIC backing services on
  this dev box — `nginx`, `postgres`, `mqtt` (NanoMQ), `questdb` and `redis` —
  over one shared `backend-net`, so each app (talosot, rms, safaura, …) can run
  its own PRIVATE stack alongside instead of colliding on ports 5432/80.
- `compose.yml` with the five services. Following `gentick-infra`'s convention,
  container names and ports are hardcoded here (not in `.env`), and local-infra
  OWNS `backend-net` (declared without `external:`), which the app stacks join as
  `external`. Host ports are bound to loopback, except nginx (all interfaces, so
  `localhost` works).
- `nginx/nginx.conf` routing by `server_name`: `localhost` / `talosot.localhost`
  serve the talosot bundle and proxy `/api`→`talosot-api`, `/mqtt`→`mqtt`;
  `rms.localhost` serves the rms bundle and proxies `/api`→`rms-api` (the
  template for adding another app). Per-app `*.localhost` names auto-resolve to
  `127.0.0.1` in browsers (RFC 6761) — no hosts entry, no DNS server — so a
  second app is reachable by name with zero per-developer setup.
- `nanomq/` broker config carrying TalosOT's Sparkplug B role accounts + ACL,
  with `svc-gen-nanomq.sh` rendering the password file and ACL from `.env` at
  bring-up (both gitignored; only the `.example` templates are tracked).
- `svc-build-env.sh` and `svc-gen-nanomq.sh` (from `agollum/docker/services/`) —
  the two scripts a pure provider needs; the stack is brought up with
  `docker compose` directly. `.env.example` reuses the shared pragma key names
  and carries only the database name and secrets, and per-app placeholder landing
  pages live under `nginx/html/`.

### Changed
- `svc-build-env.sh` and `svc-gen-nanomq.sh` at svc-scripts 0.1.3: the generator
  takes its account list from the ACL template's `@<KEY>_USER@` tokens.
