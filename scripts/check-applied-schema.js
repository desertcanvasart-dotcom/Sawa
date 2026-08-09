// SS3.1 — is the schema the code expects actually applied to production?
//
// Migrations do not run on deploy (B5). Merging a migration ships a FILE. Until
// someone runs `npm run db:migrate` against production, the columns do not
// exist, and code written against them is an outage rather than a bug.
//
// A check that read only the repository would pass on exactly the case that
// matters — a migration merged and never run — because both sides of the
// comparison would come from the same place. So this asks production.
//
// ---------------------------------------------------------------------------
// FOUR states, and the fourth is the likely one (UU2)
//
//   applied            reached production, every migration recorded
//   not-applied        reached production, one or more missing      -> FAIL
//   unreachable        the connection failed                        -> FAIL where
//                                                                      credentials
//                                                                      exist
//   wrong-target       connected, but not to production             -> FAIL always
//
// The fourth is not a variant of the third. If DATABASE_URL points at a
// developer's local database, the connection SUCCEEDS and `schema_migrations`
// may well contain the row — producing a confident "applied" for production,
// from a system that is not production. That is a false verdict, and it is the
// exact shape of every failure this project has found: reading something that
// stands in for the thing rather than the thing.
//
// Which is why the target is established BEFORE the query runs. An answer from
// an unidentified database is not a weaker answer, it is a different question.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The migrations the code believes exist, read from the runner rather than
// re-listed here — a second list would be one more thing to keep in sync
// (NN2.1, and the whole MM3 class).
export function expectedMigrations(file = join(ROOT, "server", "db", "migrate.js")) {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------- the target

// Is this host production, or something standing in for it?
//
// Deliberately conservative: anything local or private is NOT production, and
// says so, rather than being given the benefit of the doubt. The failure being
// guarded against is a confident answer from the wrong system.
const LOCAL_HOSTS = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal)/i;
const PRIVATE_RANGES = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function identifyTarget(url, env = process.env) {
  if (!url) return { ok: false, state: "unreachable", detail: "DATABASE_URL is not set" };

  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, state: "unreachable", detail: "DATABASE_URL is not a URL" }; }

  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, "") || "(default)";

  // An explicitly asserted host is the strong form: it fails on ANY other
  // remote database, not merely on a local one.
  const expected = env.PRODUCTION_DB_HOST;
  if (expected) {
    if (host !== expected) {
      return { ok: false, state: "wrong-target", strength: "asserted",
        detail: `connected to ${host}, expected ${expected}` };
    }
    return { ok: true, host, database, strength: "asserted" };
  }

  // Without an assertion, only the local case can be ruled out. That is weaker,
  // and it is reported as weaker — "clean" and "could not fully check" must not
  // render the same.
  if (LOCAL_HOSTS.test(host) || PRIVATE_RANGES.test(host)) {
    return { ok: false, state: "wrong-target", strength: "inferred",
      detail: `${host} is a local or private address, not production` };
  }
  return { ok: true, host, database, strength: "inferred" };
}

// ---------------------------------------------------------------- the check

// `connect` is injected so every state can be tested without a database.
export async function checkAppliedSchema({
  url,
  env = process.env,
  expected = expectedMigrations(),
  connect,
} = {}) {
  const target = identifyTarget(url, env);
  if (!target.ok) return { ...target, expected };

  let applied;
  try {
    applied = await connect(url);
  } catch (e) {
    return { state: "unreachable", detail: e.message, host: target.host, strength: target.strength, expected };
  }

  const have = new Set(applied);
  const missing = expected.filter((name) => !have.has(name));
  return {
    state: missing.length ? "not-applied" : "applied",
    missing,
    host: target.host,
    database: target.database,
    strength: target.strength,
    expected,
  };
}

// ---------------------------------------------------------------- reporting

// Whether this state is allowed to pass. `hasCredentials` is what separates a
// developer with no production access from CI that has it: the check must not
// block local work, and must not be skippable where it can actually run.
export function verdict(result, { hasCredentials }) {
  switch (result.state) {
    case "applied":
      return { pass: true, line: `Schema up to date on ${result.host} (${result.expected.length} migrations applied).` };
    case "not-applied":
      return { pass: false, line:
        `PRODUCTION IS MISSING ${result.missing.length} MIGRATION(S): ${result.missing.join(", ")}\n`
        + "Merging a migration ships a file. Run it:\n\n"
        + "  DATABASE_URL=<production> npm run db:migrate\n\n"
        + "Until then, any code referencing those columns is an outage." };
    case "wrong-target":
      return { pass: false, line:
        `NOT PRODUCTION — ${result.detail}\n`
        + "Refusing to answer a question about production using a different database.\n"
        + "This state exists because connecting successfully to the wrong system\n"
        + "produces a confident wrong answer, which is worse than no answer." };
    default:
      return { pass: !hasCredentials, line: hasCredentials
        ? `COULD NOT REACH production to check the schema: ${result.detail}`
        : `UNVERIFIED — no production credentials here, so the applied schema was NOT checked.` };
  }
}

// ---------------------------------------------------------------- cli

const isCli = process.argv[1] && process.argv[1].endsWith("check-applied-schema.js");
if (isCli) {
  const { readOnlyUrl, readOnlyPool } = await import("../server/db/readonly.js");
  const url = process.env.DATABASE_URL ? readOnlyUrl() : null;

  const result = await checkAppliedSchema({
    url,
    // X1 — a read-only session. This runs inside preflight, and giving preflight
    // write-capable credentials to answer a read-only question is how the
    // email_log incident happens again one step further out.
    connect: async (u) => {
      const pool = readOnlyPool({ ...process.env, DATABASE_URL: u });
      try {
        const { rows } = await pool.query("SELECT name FROM schema_migrations");
        return rows.map((r) => r.name);
      } finally {
        await pool.end();
      }
    },
  });

  const { pass, line } = verdict(result, { hasCredentials: Boolean(url) });
  if (result.strength === "inferred" && result.state === "applied") {
    console.log("NOTE: PRODUCTION_DB_HOST is not set, so the target was only checked for not being local.");
  }
  (pass ? console.log : console.error)(line);
  process.exit(pass ? 0 : 1);
}
