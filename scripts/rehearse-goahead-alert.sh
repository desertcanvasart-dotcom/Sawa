#!/usr/bin/env bash
# DIR-20 — rehearse the payment-link queue end to end against a throwaway database.
#
# Books a departure up to its minimum through the REAL refreshStatus, watches
# the queue appear, sees the dry path refrain, sends live, and then re-runs to
# prove the same departure is not alerted twice.
#
# Nothing here can reach production: the cluster listens on 127.0.0.1:55434 and
# the Node side refuses any DATABASE_URL but that one.
#
# See docs/audit/cancel-job-rehearsal.md for what was observed and what was not.
set -euo pipefail

PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}
PGPORT_REHEARSAL=55434
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGROOT="${TMPDIR:-/tmp}/sawa-goahead-rehearsal"
export DATABASE_URL="postgres://sawa@127.0.0.1:${PGPORT_REHEARSAL}/sawa_goahead"
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
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d postgres -qc "CREATE DATABASE sawa_goahead;"

echo "### applying the real schema"
cd "$ROOT/server/db"
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d sawa_goahead -v ON_ERROR_STOP=1 -qf schema.sql
for f in $(ls schema_0*.sql | sort); do
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_REHEARSAL" -U sawa -d sawa_goahead -v ON_ERROR_STOP=1 -qf "$f"
done
cd "$ROOT"

run() { node scripts/rehearse-goahead-alert.mjs "$1"; }

echo; echo "### 1 — a departure, open, below its minimum"
run seed
run book3
run state
echo "###     3 of 4 seats: still 'open', and the queue must be EMPTY."

echo; echo "### 2 — the fourth seat. This is the GoAhead moment."
run book1
run state
echo "###     'minimum_reached', a departure.goahead row, and ONE item queued."

echo; echo "### 3 — DRY. Nothing may be sent and nothing may leave the queue."
run dry
run state

echo; echo "### 4 — LIVE"
run live
run state
echo "###     alerted, recorded, and the queue is now empty."

echo; echo "### 5 — RE-RUN. The same departure must not be alerted twice."
run live
run state
