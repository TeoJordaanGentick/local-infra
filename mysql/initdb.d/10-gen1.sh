#!/bin/bash
# COPY of gen1-infra's public/mysql/initdb.d/10-gen1.sh (gen1-infra commit
# 8a4bee3, branch agentic_teo), kept byte-for-byte below this header. local-infra
# cannot mount another repo, and gen1 expects exactly these databases and
# accounts, so the logic is reused rather than re-written: when gen1-infra's
# script changes, copy it here again and update this header.
#
# First-boot setup for a bare host's MySQL: everything gen1 needs beyond the
# production database and MYSQL_USER, which the image itself creates.
#
# Run by the image's entrypoint ONCE, on an empty data directory, against the
# temporary init server (socket only, root). It is never re-run, so a later
# change in the pragma is not applied here; change the account by hand then.
#
# Values come from the container environment (public/compose.yml), which
# compose fills from .env. They are quoted for SQL here, not trusted.
set -euo pipefail

# A MySQL string literal: backslash and single quote escaped.
sql_str() {
  local v="${1//\\/\\\\}"
  printf "'%s'" "${v//\'/\'\'}"
}

# An identifier (database name): backticks doubled.
sql_id() {
  printf '`%s`' "${1//\`/\`\`}"
}

{
  # The staging slot's own database, on the same account as production.
  printf 'CREATE DATABASE IF NOT EXISTS %s;\n' "$(sql_id "$MYSQL_DATABASE_STAGING")"
  printf 'GRANT ALL ON %s.* TO %s@%s;\n' \
    "$(sql_id "$MYSQL_DATABASE_STAGING")" "$(sql_str "$MYSQL_USER")" "'%'"

  # rain, water, level: one account each, as on ZA.
  for n in 2 3 4; do
    db_var="MYSQL_DATABASE_$n" user_var="MYSQL_USER_$n" pass_var="MYSQL_PASSWORD_$n"
    printf 'CREATE DATABASE IF NOT EXISTS %s;\n' "$(sql_id "${!db_var}")"
    printf 'CREATE USER IF NOT EXISTS %s@%s IDENTIFIED BY %s;\n' \
      "$(sql_str "${!user_var}")" "'%'" "$(sql_str "${!pass_var}")"
    printf 'GRANT ALL ON %s.* TO %s@%s;\n' \
      "$(sql_id "${!db_var}")" "$(sql_str "${!user_var}")" "'%'"
  done

  # The query API's read-only account. On ZA it holds SELECT on two tables
  # (personal_access_tokens, users) in each database; a table-level grant
  # needs the table to exist, and on a bare host the API's migrations have not
  # run yet, so here it is SELECT on both databases. Still read-only.
  printf 'CREATE USER IF NOT EXISTS %s@%s IDENTIFIED BY %s;\n' \
    "$(sql_str "$MYSQL_USER_QUERY_API")" "'%'" "$(sql_str "$MYSQL_PASSWORD_QUERY_API")"
  for db in "$MYSQL_DATABASE" "$MYSQL_DATABASE_STAGING"; do
    printf 'GRANT SELECT ON %s.* TO %s@%s;\n' \
      "$(sql_id "$db")" "$(sql_str "$MYSQL_USER_QUERY_API")" "'%'"
  done

  printf 'FLUSH PRIVILEGES;\n'
} | mysql --protocol=socket -uroot -p"$MYSQL_ROOT_PASSWORD"
