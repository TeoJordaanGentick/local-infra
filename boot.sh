#!/usr/bin/env bash
# ============================================================
# local-infra — bring-up entry point (convenience wrapper).
#
# local-infra ALWAYS runs its own broker, so the NanoMQ password file AND the
# ACL must be rendered from .env before the broker starts, every time. Both key
# on the same usernames, so both come from .env (the pragma). This does:
#
#   1. gen-nanomq-pwd.sh   — render nanomq/nanomq_pwd.conf from .env
#   2. gen-nanomq-acl.sh   — render nanomq/nanomq_acl.conf from .env
#   3. svc-start.sh        — bring the shared services up and wait for health
#
# Arguments pass straight through to svc-start.sh. With none it defaults to
# --scope private, which for local-infra is the whole provider stack (there is no
# public/ split — see compose.yml). So the usual call is simply:
#
#   ./boot.sh
#
# Assumes .env already exists (run ./svc-build-env.sh once first).
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GEN_PWD_SCRIPT="${GEN_PWD_SCRIPT:-$SCRIPT_DIR/gen-nanomq-pwd.sh}"
GEN_ACL_SCRIPT="${GEN_ACL_SCRIPT:-$SCRIPT_DIR/gen-nanomq-acl.sh}"
START_SCRIPT="${START_SCRIPT:-$SCRIPT_DIR/svc-start.sh}"

printf '[boot] generating nanomq_pwd.conf from .env\n'
"$GEN_PWD_SCRIPT" || { printf '[boot] FATAL: gen-nanomq-pwd.sh failed\n' >&2; exit 1; }

printf '[boot] generating nanomq_acl.conf from .env\n'
"$GEN_ACL_SCRIPT" || { printf '[boot] FATAL: gen-nanomq-acl.sh failed\n' >&2; exit 1; }

printf '[boot] starting local-infra shared services\n'
exec "$START_SCRIPT" "$@"
