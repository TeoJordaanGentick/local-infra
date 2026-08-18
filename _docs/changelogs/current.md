# Changelog — teo-infra

All notable changes to this repo are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this file is the rolling
unreleased section and is copied to `v<X.Y.Z>.md` at release.

## [Unreleased]

### Added
- Initial scaffold of the local shared-infrastructure repo: the leaner, local
  equivalent of `gentick-infra`. Provides the shared PUBLIC backing services on
  this dev box — `nginx`, `postgres`, `mqtt` (NanoMQ), `questdb` and `redis` —
  over one external `backend-net`, so each app (talosot, rms, safaura, …) can
  run its own PRIVATE stack (`svc-start.sh --scope private`) alongside instead
  of colliding on ports 5432/80.
- `compose.yml` with the five services, container names fixed to the shared
  hostnames apps dial (`postgres`, `mqtt`, `questdb`, `redis`, `nginx`).
- `nginx/nginx.conf` routing by `server_name`: `localhost` / `dev.talosot.local`
  serve the talosot bundle and proxy `/api`→`talosot-api`, `/mqtt`→`mqtt`;
  `dev.rms.local` serves the rms bundle and proxies `/api`→`rms-api` (the
  template for adding another app). `localhost` works with no hosts-file edit.
- `nanomq/` broker config carrying TalosOT's Sparkplug B account + ACL model,
  with `gen-nanomq-pwd.sh` rendering the password file from `.env` at bring-up.
- The canonical `svc-*` scripts (copied from `agollum/docker/services/`), a
  `boot.sh` convenience wrapper, `.env.example` reusing the shared pragma key
  names, and per-app placeholder landing pages under `nginx/html/`.
