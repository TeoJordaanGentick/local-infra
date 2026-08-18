#!/usr/bin/env bash
# ============================================================
# teo-infra — bring-up entry point (convenience wrapper).
#
# teo-infra ALWAYS runs its own broker, so the NanoMQ password file must be
# rendered from .env before the broker starts, every time. This does two things:
#
#   1. gen-nanomq-pwd.sh   — render nanomq/nanomq_pwd.conf from .env
#   2. svc-start.sh        — bring the shared services up and wait for health
#
# Arguments pass straight through to svc-start.sh. With none it defaults to
# --scope private, which for teo-infra is the whole provider stack (there is no
# public/ split — see compose.yml). So the usual call is simply:
#
#   ./boot.sh
#
# Assumes .env already exists (run ./svc-build-env.sh once first).
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GEN_SCRIPT="${GEN_SCRIPT:-$SCRIPT_DIR/gen-nanomq-pwd.sh}"
START_SCRIPT="${START_SCRIPT:-$SCRIPT_DIR/svc-start.sh}"

printf '[boot] generating nanomq_pwd.conf from .env\n'
"$GEN_SCRIPT" || { printf '[boot] FATAL: gen-nanomq-pwd.sh failed\n' >&2; exit 1; }

printf '[boot] starting teo-infra shared services\n'
exec "$START_SCRIPT" "$@"
