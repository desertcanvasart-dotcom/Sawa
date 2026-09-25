import "dotenv/config";
import pg from "pg";
import { sslConfig } from "./ssl.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Railway requires SSL; local does not. Toggle via env. Certificate
// verification switches on with PGSSL_CA — see ./ssl.js (S07).
const ssl = sslConfig();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("Unexpected idle client error", err);
});

// Run a single query.
export function query(text, params) {
  return pool.query(text, params);
}

// Run a function inside a transaction. The callback receives a dedicated client.
// Commits on success, rolls back on any thrown error. This is the core of
// "all-or-nothing" reliability for bookings.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// TT1 / OO2.1 — the mirror as a consequence of the write.
//
// `emitDepartureSync` was called from nine route handlers and nowhere else.
// FOUR writers changed a departure and never reached it — a price change across
// every date of a product, a declined request, a booking status change, and the
// unattended cancel job. Two of those left a departure Sawa had CANCELLED
// sitting `open` in a partner system indefinitely, because nothing else ever
// corrects the mirror.
//
// The case that settles the design: `POST /api/public/departure-requests` does
// not sync, and that is right — the row is `pending_review` and the payload
// builder returns null for it. The BUILDER decided; the route author did not,
// and could equally have added a call that was silently discarded or omitted one
// that should have fired, with nothing to tell them either way.
//
// So this wrapper emits once per touched departure, AFTER commit — never inside
// it, because a rollback following an emit tells the mirror about a state that
// never existed, and the emitter is fire-and-forget with retries. There is no
// way to recall it.
//
// HONEST LIMIT, stated rather than implied: a caller still has to call `touch`.
// This is a detector, not a structural impossibility — the guard below reports
// a write that touched nothing, but it cannot make marking automatic without
// sniffing SQL, which would be fragile in exactly the way this is meant to
// avoid. A database trigger WOULD be unconditional and is rejected for stated
// reasons: it fires for the one-off scripts too, including the one whose whole
// purpose is removing rows that should never have been mirrored, and B5 lets a
// trigger and the code disagree in production indefinitely.
const TOUCHES_A_DEPARTURE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(departures|pledges)\b/i;

export async function withDepartureWrites(fn) {
  const touched = new Set();
  const touch = (id) => { if (id != null) touched.add(Number(id)); };
  let wrote = false;

  const result = await withTransaction(async (client) => {
    const wrapped = {
      ...client,
      query: (...args) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (sql && TOUCHES_A_DEPARTURE.test(sql)) wrote = true;
        return client.query(...args);
      },
    };
    return fn(wrapped, touch);
  });

  if (wrote && touched.size === 0) {
    // Loud, because the failure it describes is silent: the write landed, the
    // mirror was never told, and everything downstream looks fine.
    console.error(
      "[autoura-sync] a departure or pledge was written inside withDepartureWrites() "
      + "and nothing called touch(). The external mirror was NOT told about this change."
    );
  }

  // After COMMIT. Imported lazily so this module stays usable without the sync
  // configured, and so db/index.js does not depend on the sync at load time.
  if (touched.size) {
    const { emitDepartureSync } = await import("../autoura-sync.js");
    for (const id of touched) emitDepartureSync(id);
  }
  return result;
}
