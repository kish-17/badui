#!/usr/bin/env bash
# Stop the local PostgreSQL started by scripts/db/start-local.sh. The cluster's
# data directory is kept (start-local.sh reuses it); test databases are
# dropped by the tests themselves. Idempotent: a stopped server is fine.
#
# Overrides: BRAKE_PG_DIR, BRAKE_PG_OS_USER, BRAKE_PG_BIN (as for start-local.sh).
set -euo pipefail

PG_BASE="${BRAKE_PG_DIR:-/var/lib/postgresql/brake-test}"
PG_DATA="$PG_BASE/data"
PG_OS_USER="${BRAKE_PG_OS_USER:-postgres}"

log() { printf '[db:stop] %s\n' "$*"; }
die() { printf '[db:stop] error: %s\n' "$*" >&2; exit 1; }

find_pg_bin() {
  if [[ -n "${BRAKE_PG_BIN:-}" ]]; then echo "$BRAKE_PG_BIN"; return; fi
  local candidates=(/usr/lib/postgresql/16/bin /usr/pgsql-16/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin)
  for dir in "${candidates[@]}"; do
    if [[ -x "$dir/pg_ctl" ]]; then echo "$dir"; return; fi
  done
  if command -v pg_config >/dev/null 2>&1; then pg_config --bindir; return; fi
  die "PostgreSQL 16 binaries not found (set BRAKE_PG_BIN)"
}

as_pg() {
  if [[ "$(id -un)" == "$PG_OS_USER" ]]; then
    "$@"
  elif [[ "$(id -u)" == "0" ]]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$PG_OS_USER" -- "$@"
    else
      su -s /bin/sh "$PG_OS_USER" -c "$(printf '%q ' "$@")"
    fi
  else
    sudo -u "$PG_OS_USER" -- "$@"
  fi
}

if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
  log "no cluster at $PG_DATA; nothing to stop"
  exit 0
fi

bin="$(find_pg_bin)"
if as_pg "$bin/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
  as_pg "$bin/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null
  log "stopped PostgreSQL ($PG_DATA)"
else
  log "PostgreSQL is not running ($PG_DATA)"
fi
