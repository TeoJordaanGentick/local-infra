#!/usr/bin/env bash
# svc-scripts 0.1.4 — canonical copy: agollum/docker/services/
# Edit there and copy the whole set across; svc-compose.sh is sourced by
# the others, so a half-updated set breaks in ways that look like a bug.
# Render NanoMQ's generated config (password file + ACL) from .env before the
# broker starts.
#
# NanoMQ has no env templating, so its account passwords and its ACL usernames
# cannot come from the process environment the way api/nexus read theirs. This
# renders both files from the MQTT account values in .env — one source of truth:
#
#   nanomq_pwd.conf  <- every account the template names: <USER_KEY> / <PASSWORD_KEY>
#   nanomq_acl.conf  <- those usernames substituted into nanomq_acl.conf.example
#
# The template decides which accounts exist. Each @TOKEN@ in it names one account:
#
#   @SERVICE_USER@ -> MQTT_USER        / MQTT_PASSWORD          (legacy spelling)
#   @NODE_USER@    -> MQTT_NODE_USER   / MQTT_NODE_PASSWORD     (legacy spelling)
#   @VIEWER_USER@  -> MQTT_VIEWER_USER / MQTT_VIEWER_PASSWORD   (legacy spelling)
#   @<KEY>_USER@   -> <KEY>_USER       / <KEY>_PASSWORD         (any other account)
#
# so adding an account is a template edit plus two .env.example keys, never a
# script edit. The three legacy tokens keep their old spelling because every
# deployed template uses them; for such a template the ACL and the account lines
# are exactly what 0.1.2 wrote (only the password file's comment header differs).
#
# Two accounts resolving to the SAME username is refused: their ACL rules would
# merge (a device account sharing the service account's name inherits pubsub on
# '#'), and the password file would hold the name twice with one password lost.
#
# Both generated files are gitignored (only the .example templates are committed),
# so on a fresh clone they DO NOT EXIST. If the broker starts before they are
# generated, docker bind-mounts an empty DIRECTORY in place of each missing file
# and nanomq dies in a crash loop with "input in flex scanner failed". svc-start.sh
# calls this first to prevent exactly that; this script also clears any such stub
# directory it finds, so the failure cannot recur even after a bad start.
#
# No-op (exit 0) in a repo with no nanomq config. Handles both the provider layout
# (./nanomq) and the public-backing layout (./public/nanomq).
#
# Idempotent. Safe to run by hand:  ./svc-gen-nanomq.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

svc_log() { printf '[gen-nanomq] %s\n' "$*"; }
die()     { printf '[gen-nanomq] FATAL: %s\n' "$*" >&2; exit 1; }

# Read ONE key from the compose .env. LAST assignment wins (compose is last-wins),
# strips a single surrounding quote pair, and un-doubles '$$' -> '$' so the value
# equals exactly what compose interpolates into the app clients and the SPA — the
# broker password MUST equal what the clients dial with.
read_env() { # <KEY> -> raw value, or returns 1 if absent
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

# Called as v="$(require KEY)" — a command substitution is a subshell, so die
# only ends that subshell. Callers therefore append `|| exit 1`; without it a
# missing key would render an account with an empty name or password.
require() { # <KEY> -> value or die (empty / placeholder both fail)
  local key="$1" val
  val="$(read_env "$key")" || die "$key is not set in $ENV_FILE"
  [[ -n "$val" ]] || die "$key is empty in $ENV_FILE"
  case "$val" in replace*) die "$key still holds a placeholder in $ENV_FILE" ;; esac
  printf '%s' "$val"
}

user_key() { # <TOKEN> -> the .env key holding that account's username
  case "$1" in
    SERVICE_USER) printf 'MQTT_USER' ;;
    NODE_USER)    printf 'MQTT_NODE_USER' ;;
    VIEWER_USER)  printf 'MQTT_VIEWER_USER' ;;
    *)            printf '%s' "$1" ;;
  esac
}

# Resolve every account the template names, in first-appearance order, into the
# parallel arrays TOKENS / UKEYS / USERS / PASSES. Validates the usernames once,
# here, so the pwd file and the ACL are rendered from the same checked values.
load_accounts() { # <template>
  local tmpl="$1" tok uk pk u p i
  TOKENS=(); UKEYS=(); USERS=(); PASSES=()
  while IFS= read -r tok; do
    uk="$(user_key "$tok")"
    pk="${uk%_USER}_PASSWORD"
    u="$(require "$uk")" || exit 1
    p="$(require "$pk")" || exit 1
    # A username with an ACL/JSON metacharacter would corrupt or, worse, widen the
    # rules. Restrict to a conservative broker-username charset before sed.
    [[ "$u" =~ ^[A-Za-z0-9._-]+$ ]] || die "$uk='$u' has characters not allowed in a broker username ([A-Za-z0-9._-])"
    for i in "${!USERS[@]}"; do
      [[ "${USERS[$i]}" != "$u" ]] || die "$uk and ${UKEYS[$i]} hold the same username — each broker account needs its own"
    done
    TOKENS+=("$tok"); UKEYS+=("$uk"); USERS+=("$u"); PASSES+=("$p")
  done < <(grep -oE '@[A-Z][A-Z0-9_]*_USER@' "$tmpl" | tr -d '@' | awk '!seen[$0]++')
  [[ ${#TOKENS[@]} -gt 0 ]] || die "$tmpl names no account (@..._USER@ token)"
}

gen_pwd() { # <nanomq-dir> — HOCON "username: password" pairs; secret, 0600
  local out="$1/nanomq_pwd.conf" i
  ( umask 077
    {
      printf '%s\n' \
        '# GENERATED by svc-gen-nanomq.sh from .env — DO NOT EDIT, DO NOT COMMIT.' \
        '# NanoMQ password file: HOCON "username: password" pairs, included by nanomq.conf' \
        '# -> auth.password. Roles/ACL: nanomq_acl.conf. Regenerated on every bring-up.' \
        '# One line per account named in nanomq_acl.conf.example, from these .env keys:'
      for i in "${!UKEYS[@]}"; do printf '#   %s / %s\n' "${UKEYS[$i]}" "${UKEYS[$i]%_USER}_PASSWORD"; done
      for i in "${!USERS[@]}"; do printf '%s: %s\n' "${USERS[$i]}" "${PASSES[$i]}"; done
    } > "$out"
  ) || die "could not write $out"
  svc_log "wrote $out (accounts: ${USERS[*]})"
}

gen_acl() { # <nanomq-dir> — usernames substituted into nanomq_acl.conf.example
  local tmpl="$1/nanomq_acl.conf.example" out="$1/nanomq_acl.conf" i
  local -a expr=()
  for i in "${!TOKENS[@]}"; do expr+=(-e "s/@${TOKENS[$i]}@/${USERS[$i]}/g"); done
  sed "${expr[@]}" "$tmpl" > "$out" || die "could not write $out"
  # Every token was collected from this template, so a leftover means the sed
  # above failed silently — fail loud rather than ship a half-substituted ACL.
  if grep -qE '@[A-Z][A-Z0-9_]*_USER@' "$out"; then
    rm -f "$out"
    die "unsubstituted token(s) remain in $out"
  fi
  svc_log "wrote $out (${#TOKENS[@]} accounts)"
}

# A nanomq config dir is marked by its committed ACL template. Check both the
# provider (./nanomq) and public-backing (./public/nanomq) layouts.
found=0
for dir in "$SCRIPT_DIR/nanomq" "$SCRIPT_DIR/public/nanomq"; do
  [[ -f "$dir/nanomq_acl.conf.example" ]] || continue
  found=1
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found — run ./svc-build-env.sh first"
  # Clear any empty stub DIRECTORY docker created over a missing generated file on
  # a prior bad start — else the cat/sed below fails writing "a file over a dir".
  for f in nanomq_pwd.conf nanomq_acl.conf; do
    if [[ -d "$dir/$f" ]]; then
      rmdir "$dir/$f" 2>/dev/null || die "$dir/$f is a directory (a docker bind-mount stub) and is not empty — remove it and retry"
      svc_log "cleared empty stub dir $dir/$f (docker created it over the missing file)"
    fi
  done
  load_accounts "$dir/nanomq_acl.conf.example"
  gen_pwd "$dir"
  gen_acl "$dir"
done

[[ "$found" -eq 1 ]] || svc_log "no nanomq config in this repo — nothing to generate"
exit 0
