#!/usr/bin/env bash
# JJ2 — rehearse the auto-cancel job end to end against a throwaway database.
#
# Builds an ephemeral PostgreSQL cluster, applies the real schema, puts ONE
# synthetic candidate in front of the job, and observes the dry path refraining
# from something it could have done. Then runs it live, purges, and destroys the
# cluster.
#
# Nothing here can reach production: the cluster listens on 127.0.0.1:55432 and
# the Node side refuses any DATABASE_URL but that one.
#
# See docs/audit/cancel-job-rehearsal.md for what was observed and what was not.
set -euo pipefail

PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}
PGPORT_REHEARSAL=55432
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGROOT="${TMPDIR:-/tmp}/sawa-cancel-job-rehearsal"
export DATABASE_URL="postgres://sawa@127.0.0.1:${PGPORT_REHEARSAL}/sawa_rehearsal"
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
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d postgres -qc "CREATE DATABASE sawa_rehearsal;"

echo "### applying the real schema"
cd "$ROOT/server/db"
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d sawa_rehearsal -v ON_ERROR_STOP=1 -qf schema.sql
for f in $(ls schema_0*.sql | sort); do
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d sawa_rehearsal -v ON_ERROR_STOP=1 -qf "$f"
done
cd "$ROOT"

run() { node scripts/rehearse-cancel-job.mjs "$1"; }

echo; echo "### 1 — one synthetic candidate, past its deadline"
run seed
run state

echo; echo "### 2 — DRY. Nothing may be cancelled and nothing may be sent."
run dry
run state

echo; echo "### 3 — LIVE, on the same candidate"
run live
run state

echo; echo "### a second DRY tick — the terminal state must hold"
run dry

echo; echo "### 4 — purge"
run purge
run state

echo; echo "### what a traveller actually receives"
run email
