# Changelog — local-infra

All notable changes to this repo are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this file is the rolling
unreleased section and is copied to `v<X.Y.Z>.md` at release.

## [Unreleased]

### Added
- Initial scaffold of the local shared-infrastructure repo: the leaner, local
  equivalent of `gentick-infra`. Provides the shared PUBLIC backing services on
  this dev box — `nginx`, `postgres`, `mqtt` (NanoMQ), `questdb` and `redis` —
  over one shared `backend-net`, so each app (talosot, rms, safaura, …) can run
  its own PRIVATE stack alongside instead of colliding on ports 5432/80.
- `compose.yml` with the five services. Following `gentick-infra`'s convention,
  container names and ports are hardcoded here (not in `.env`). `backend-net` is
  declared `external: true` — local-infra joins the shared network the app stacks
  already use rather than owning it (unlike gentick-infra, the sole creator on the
  server). Host ports are bound to loopback, except nginx (all interfaces, so
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
