import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Railway requires SSL; local does not. Toggle via env.
const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false;

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
