#!/usr/bin/env bash
# ============================================================
# local-infra — generate nanomq/nanomq_acl.conf from .env.
#
# The NanoMQ ACL keys on the broker USERNAMES, and so does the password file
# (nanomq_pwd.conf, rendered by gen-nanomq-pwd.sh from the same three values).
# Rather than hardcode the usernames in the ACL and let it drift from the pwd
# file the moment someone changes one in the pragma, this RENDERS the ACL from
# the same MQTT_*_USER values in .env — one source of truth. A mismatched
# username otherwise authenticates fine but matches no rule and hits the
# default-deny, with nothing in the logs to say why.
#
# Run automatically by boot.sh. Safe to run by hand:
#
#   ./gen-nanomq-acl.sh
#
# Reads three vars, all REQUIRED (blank / placeholder both fail):
#
#   MQTT_USER        — service account (app api, nexus)
#   MQTT_NODE_USER   — device firmware
#   MQTT_VIEWER_USER — browsers (subscribe-only)
#
# It substitutes them into the committed template nanomq/nanomq_acl.conf.example
# (the @..._USER@ tokens) to produce nanomq/nanomq_acl.conf. The generated file
# is gitignored; only the .example is committed.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
TEMPLATE="${TEMPLATE:-$SCRIPT_DIR/nanomq/nanomq_acl.conf.example}"
OUT="${OUT:-$SCRIPT_DIR/nanomq/nanomq_acl.conf}"

log() { printf '[gen-nanomq-acl] %s\n' "$*"; }
die() { printf '[gen-nanomq-acl] FATAL: %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]]  || die "$ENV_FILE not found — run ./svc-build-env.sh first"
[[ -f "$TEMPLATE" ]]  || die "$TEMPLATE not found"

# Read ONE key from the compose .env. Takes the LAST assignment (compose is
# last-wins), strips a single surrounding quote pair, and un-doubles '$$' -> '$'
# so the value matches exactly what compose interpolates elsewhere.
read_env() { # <KEY> -> echoes raw value, or returns 1 if the key is absent
  local key="$1" line val
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1)" || true
  [[ -n "$line" ]] || return 1
  val="${line#*=}"
  if [[ ${#val} -ge 2 ]]; then
    case "$val" in
      \"*\") val="${val:1:${#val}-2}" ;;
      \'*\') val="${val:1:${#val}-2}" ;;
    esac
  fi
  val="${val//\$\$/\$}"
  printf '%s' "$val"
}

require() { # <KEY> -> echoes value or dies (empty / placeholder both fail)
  local key="$1" val
  val="$(read_env "$key")" || die "$key is not set in $ENV_FILE"
  [[ -n "$val" ]] || die "$key is empty in $ENV_FILE"
  case "$val" in replace*) die "$key still holds a placeholder in $ENV_FILE" ;; esac
  printf '%s' "$val"
}

svc_user="$(require MQTT_USER)"
node_user="$(require MQTT_NODE_USER)"
viewer_user="$(require MQTT_VIEWER_USER)"

# A username with an ACL/JSON metacharacter would corrupt the rules or, worse,
# widen them. Restrict to a conservative broker-username charset.
for pair in "MQTT_USER:$svc_user" "MQTT_NODE_USER:$node_user" "MQTT_VIEWER_USER:$viewer_user"; do
  name="${pair%%:*}"; val="${pair#*:}"
  [[ "$val" =~ ^[A-Za-z0-9._-]+$ ]] || die "$name='$val' has characters not allowed in a broker username ([A-Za-z0-9._-])"
done

# Substitute the tokens. Usernames are charset-restricted above, so a plain sed
# is safe here.
sed -e "s/@SERVICE_USER@/${svc_user}/g" \
    -e "s/@NODE_USER@/${node_user}/g" \
    -e "s/@VIEWER_USER@/${viewer_user}/g" \
    "$TEMPLATE" > "$OUT"

# A stray token left in the output means the template gained a role the script
# does not fill — fail loudly rather than ship a half-substituted ACL.
if grep -q '@[A-Z_]*_USER@' "$OUT"; then
  rm -f "$OUT"
  die "unsubstituted token(s) remain in the rendered ACL — template has a role gen-nanomq-acl.sh does not fill"
fi

log "wrote $OUT (service=$svc_user, node=$node_user, viewer=$viewer_user)"
