// A throwaway database per integration-test file (O02).
//
// TEST_DATABASE_URL points at a Postgres the tests may create databases on — a
// CI service container or a local scratch instance, NEVER production. Each
// test file gets its own database, so files that run in parallel can't see
// each other's rows. Without TEST_DATABASE_URL, `testDbSkip` is set and the
// integration tests skip.
import pg from "pg";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "";
export const testDbSkip = TEST_DATABASE_URL ? false : "set TEST_DATABASE_URL to a disposable Postgres to run";

// Refuse anything that looks like the real database. A test that drops and
// recreates databases must not be one environment variable away from prod.
function assertDisposable(url) {
  const u = new URL(url);
  if (/supabase\.(co|com)$|pooler\.supabase/.test(u.hostname) || url === process.env.DATABASE_URL_PRODUCTION) {
    throw new Error(`TEST_DATABASE_URL points at ${u.hostname} — refusing to create or drop databases there.`);
  }
}

export async function freshDatabase(name) {
  assertDisposable(TEST_DATABASE_URL);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name: ${name}`);
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function dropDatabase(name) {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
}
