#!/usr/bin/env bash
# Start the local database stack for BRAKE's database tests (`npm run test:db`)
# without Docker, which the Supabase CLI's local stack would need:
#
#   * PostgreSQL 16 on localhost:54329, superuser "postgres", trust auth,
#     cluster under /var/lib/postgresql/brake-test, run as the postgres OS user.
#     Tests create and drop their own databases in it; the Supabase pieces
#     (roles, auth schema, default grants) come from supabase/tests/shim.sql.
#   * PostgREST v13.0.4 in .cache/postgrest/postgrest (tests spawn it per file).
#
# Idempotent: a running server, an existing cluster and an already downloaded
# binary are left alone. Trust auth on localhost is for a disposable test
# cluster only; never point this at data you care about.
#
# Overrides: BRAKE_PG_PORT, BRAKE_PG_DIR, BRAKE_PG_OS_USER, BRAKE_PG_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_PORT="${BRAKE_PG_PORT:-54329}"
PG_BASE="${BRAKE_PG_DIR:-/var/lib/postgresql/brake-test}"
PG_DATA="$PG_BASE/data"
PG_LOG="$PG_BASE/log"
PG_OS_USER="${BRAKE_PG_OS_USER:-postgres}"
POSTGREST_VERSION="13.0.4"
POSTGREST_DIR="$ROOT/.cache/postgrest"

log() { printf '[db:start] %s\n' "$*"; }
die() { printf '[db:start] error: %s\n' "$*" >&2; exit 1; }

find_pg_bin() {
  if [[ -n "${BRAKE_PG_BIN:-}" ]]; then echo "$BRAKE_PG_BIN"; return; fi
  local candidates=(/usr/lib/postgresql/16/bin /usr/pgsql-16/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin)
  for dir in "${candidates[@]}"; do
    if [[ -x "$dir/initdb" && -x "$dir/pg_ctl" ]]; then echo "$dir"; return; fi
  done
  if command -v pg_config >/dev/null 2>&1 && [[ "$(pg_config --version)" == *" 16."* ]]; then
    pg_config --bindir
    return
  fi
  die "PostgreSQL 16 server binaries not found (install postgresql-16 or set BRAKE_PG_BIN)"
}

# Run a command as the cluster's OS user (Postgres refuses to run as root).
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

start_postgres() {
  local bin
  bin="$(find_pg_bin)"
  if "$bin/pg_isready" -q -h localhost -p "$PG_PORT"; then
    log "PostgreSQL already accepting connections on localhost:$PG_PORT"
    return
  fi
  id "$PG_OS_USER" >/dev/null 2>&1 || die "OS user '$PG_OS_USER' does not exist (set BRAKE_PG_OS_USER)"

  if [[ ! -d "$PG_BASE" ]]; then
    if [[ "$(id -u)" == "0" ]]; then
      mkdir -p "$PG_BASE"
      chown "$PG_OS_USER" "$PG_BASE"
    else
      as_pg mkdir -p "$PG_BASE"
    fi
  fi

  if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
    log "initialising cluster in $PG_DATA"
    as_pg "$bin/initdb" -D "$PG_DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi

  log "starting PostgreSQL 16 on localhost:$PG_PORT (log: $PG_LOG)"
  as_pg "$bin/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -w -t 60 \
    -o "-p $PG_PORT -k $PG_BASE -c listen_addresses=localhost" start >/dev/null
  "$bin/pg_isready" -q -h localhost -p "$PG_PORT" || die "PostgreSQL did not start; see $PG_LOG"
}

fetch_postgrest() {
  local bin="$POSTGREST_DIR/postgrest"
  if [[ -x "$bin" ]] && "$bin" --version 2>/dev/null | grep -q "PostgREST $POSTGREST_VERSION"; then
    log "PostgREST $POSTGREST_VERSION present at ${bin#"$ROOT"/}"
    return
  fi

  local asset
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) asset="linux-static-x86-64" ;;
    Linux-aarch64 | Linux-arm64) asset="ubuntu-aarch64" ;;
    Darwin-arm64) asset="macos-aarch64" ;;
    Darwin-x86_64) asset="macos-x86-64" ;;
    *) die "no PostgREST $POSTGREST_VERSION build for $(uname -s)-$(uname -m); place a binary at $bin" ;;
  esac

  local url="https://github.com/PostgREST/postgrest/releases/download/v$POSTGREST_VERSION/postgrest-v$POSTGREST_VERSION-$asset.tar.xz"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  log "downloading $url"
  curl -fsSL --retry 3 -o "$tmp/postgrest.tar.xz" "$url"
  tar -xJf "$tmp/postgrest.tar.xz" -C "$tmp"
  mkdir -p "$POSTGREST_DIR"
  install -m 0755 "$tmp/postgrest" "$bin"
  "$bin" --version | grep -q "PostgREST $POSTGREST_VERSION" || die "downloaded PostgREST reports an unexpected version"
  log "PostgREST $POSTGREST_VERSION installed at ${bin#"$ROOT"/}"
}

start_postgres
fetch_postgrest
log "ready: postgres://postgres@localhost:$PG_PORT/postgres"
