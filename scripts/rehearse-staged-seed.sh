#!/usr/bin/env bash
# DIR-16 — rehearse the staged seed end to end against a throwaway database.
#
# Builds an ephemeral PostgreSQL cluster, applies the real schema and every
# migration, then runs the staged load in the order seed-preconditions.md
# prescribes: ONE below-minimum departure first, verify what rendered nowhere
# before (forming below minimum, no GoAhead, nothing sent), and only then the
# remainder. Each phase is judged by rehearse-staged-seed.mjs with an exit
# code, not by reading output.
#
# Input is data/bookings-rehearsal.json — TEST data (client-confirmed
# 2026-08-11), untracked. The driver refuses to run without it and refuses any
# DATABASE_URL that is not this cluster.
#
# Nothing here can reach production: the cluster listens on 127.0.0.1:55433
# and is destroyed on exit. First observed run recorded in
# docs/audit/staged-seed-rehearsal.md.
set -euo pipefail

PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}
PGPORT_REHEARSAL=55433
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGROOT="${TMPDIR:-/tmp}/sawa-staged-seed-rehearsal"
export DATABASE_URL="postgres://sawa@127.0.0.1:${PGPORT_REHEARSAL}/sawa_seed_rehearsal"
export LANG=C LC_ALL=C

if [ ! -x "$PGBIN/initdb" ]; then
  echo "No PostgreSQL server at $PGBIN. Install one (brew install postgresql@17) or set PGBIN." >&2
  exit 1
fi

cleanup() {
  "$PGBIN/pg_ctl" -D "$PGROOT" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PGROOT"
}
trap cleanup EXIT

echo "### building the ephemeral cluster"
rm -rf "$PGROOT"; mkdir -p "$PGROOT"
"$PGBIN/initdb" -D "$PGROOT" -U sawa --auth=trust --locale=C --encoding=UTF8 >/dev/null
# unix_socket_directories is emptied because the temp path exceeds the 103-byte
# socket limit on macOS; TCP on loopback is enough and is what the app uses.
"$PGBIN/pg_ctl" -D "$PGROOT" \
  -o "-p $PGPORT_REHEARSAL -c unix_socket_directories= -c listen_addresses=127.0.0.1" \
  -l "$PGROOT/server.log" start >/dev/null
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d postgres -qc "CREATE DATABASE sawa_seed_rehearsal;"

echo "### applying the real schema and every migration"
cd "$ROOT/server/db"
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d sawa_seed_rehearsal -v ON_ERROR_STOP=1 -qf schema.sql
for f in $(ls schema_0*.sql | sort); do
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d sawa_seed_rehearsal -v ON_ERROR_STOP=1 -qf "$f" 2>/dev/null
done
cd "$ROOT"

run() { node scripts/rehearse-staged-seed.mjs "$1"; }

echo; echo "### 1 — stage 1: exactly one departure, chosen to sit below minimum"
run stage1
run verify-stage1

echo; echo "### 2 — the remainder, only after stage 1 verified"
run remainder
run verify-full

echo; echo "### staged-seed rehearsal complete; destroying the cluster"
