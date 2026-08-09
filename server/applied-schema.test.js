// SS3.1 / UU2 — four states, and each one proved to fire.
//
// The check answers "is the schema the code expects actually applied to
// production". A check reading only the repository would pass on exactly the
// case that matters — a migration merged and never run — because both sides of
// the comparison would come from the same place.
//
// The fourth state is the point. Connected-to-the-wrong-database is NOT a
// variant of could-not-check: the connection succeeds, `schema_migrations` may
// well hold the row, and the check reports a confident "applied" for production
// from a system that is not production. A false verdict, and the exact shape of
// every failure this project has found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAppliedSchema, identifyTarget, expectedMigrations, verdict } from "../scripts/check-applied-schema.js";

const PROD = "postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
const EXPECTED = ["001_initial_schema", "002_auth", "003_ops"];
const answering = (names) => async () => names;

test("the expected list comes from the migration runner, not a second list", () => {
  // A hand-kept copy would be one more thing to keep in sync — the MM3 class.
  const found = expectedMigrations();
  assert.ok(found.length >= 20, `only ${found.length} migrations parsed from migrate.js`);
  assert.equal(found[0], "001_initial_schema");
  // Guards the parser: if the regex stopped matching, every state below would
  // pass against an empty expectation.
  assert.ok(found.every((n) => /^\d{3}_/.test(n)), "a parsed name is not migration-shaped");
});

test("state 1 — applied", async () => {
  const r = await checkAppliedSchema({ url: PROD, env: {}, expected: EXPECTED, connect: answering(EXPECTED) });
  assert.equal(r.state, "applied");
  assert.deepEqual(r.missing, []);
  assert.equal(verdict(r, { hasCredentials: true }).pass, true);
});

test("state 2 — reached production, migrations missing", async () => {
  const r = await checkAppliedSchema({
    url: PROD, env: {}, expected: EXPECTED, connect: answering(["001_initial_schema"]),
  });
  assert.equal(r.state, "not-applied");
  assert.deepEqual(r.missing, ["002_auth", "003_ops"]);

  const v = verdict(r, { hasCredentials: true });
  assert.equal(v.pass, false);
  assert.match(v.line, /db:migrate/, "the message must give the command, not just the diagnosis");
});

test("state 3 — could not reach it", async () => {
  const r = await checkAppliedSchema({
    url: PROD, env: {}, expected: EXPECTED,
    connect: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(r.state, "unreachable");

  // TT4.2 — this must not block local work, and must not be skippable where it
  // can actually run.
  assert.equal(verdict(r, { hasCredentials: false }).pass, true, "a developer without credentials is not blocked");
  assert.equal(verdict(r, { hasCredentials: true }).pass, false, "with credentials, unreachable is a failure");
  assert.match(verdict(r, { hasCredentials: false }).line, /UNVERIFIED/,
    "unverified must not read like a pass");
});

test("state 4 — connected, but not to production", async () => {
  // The likely one. A developer's DATABASE_URL points at their own database,
  // the connection succeeds, and schema_migrations is fully populated because
  // they ran the migrations locally last week.
  let queried = false;
  const r = await checkAppliedSchema({
    url: "postgres://u:p@127.0.0.1:5432/sawa",
    env: {}, expected: EXPECTED,
    connect: async () => { queried = true; return EXPECTED; },
  });
  assert.equal(r.state, "wrong-target");
  assert.equal(verdict(r, { hasCredentials: true }).pass, false);
  assert.equal(verdict(r, { hasCredentials: false }).pass, false, "wrong-target fails everywhere");

  // The order matters as much as the verdict: an answer from an unidentified
  // database is not a weaker answer, it is a different question.
  assert.equal(queried, false, "the database was queried before its identity was established");
});

test("state 4 does not collapse into state 1 — the whole reason it exists", async () => {
  // Same fully-migrated answer, two different targets. If these ever agree, the
  // check is reporting production's state from somewhere else.
  const local = await checkAppliedSchema({
    url: "postgres://u:p@localhost:5432/sawa", env: {}, expected: EXPECTED, connect: answering(EXPECTED),
  });
  const prod = await checkAppliedSchema({ url: PROD, env: {}, expected: EXPECTED, connect: answering(EXPECTED) });
  assert.equal(prod.state, "applied");
  assert.notEqual(local.state, "applied");
});

test("an asserted host fails on ANY other database, not only a local one", () => {
  // Without PRODUCTION_DB_HOST only the local case can be ruled out. With it,
  // a different remote database is caught too — which is the stronger form.
  const env = { PRODUCTION_DB_HOST: "aws-0-eu-west-1.pooler.supabase.com" };
  assert.equal(identifyTarget(PROD, env).ok, true);

  const other = identifyTarget("postgres://u:p@aws-0-us-east-1.pooler.supabase.com/postgres", env);
  assert.equal(other.ok, false);
  assert.equal(other.state, "wrong-target");
  assert.equal(other.strength, "asserted");

  // And the weaker form says it is weaker. "Clean" and "could not fully check"
  // must not render the same.
  assert.equal(identifyTarget(PROD, {}).strength, "inferred");
});

test("private ranges are not production either", () => {
  for (const host of ["10.0.0.5", "192.168.1.10", "172.16.4.2", "host.docker.internal", "[::1]"]) {
    const r = identifyTarget(`postgres://u:p@${host}:5432/sawa`, {});
    assert.equal(r.state, "wrong-target", `${host} was accepted as production`);
  }
});

test("no URL is unreachable, not wrong-target", () => {
  // A developer with no credentials has not pointed at the wrong system; they
  // have pointed at nothing. The two must not produce the same failure.
  const r = identifyTarget(undefined, {});
  assert.equal(r.state, "unreachable");
  assert.equal(verdict({ ...r, expected: [] }, { hasCredentials: false }).pass, true);
});

test("all four states are distinguishable from their output alone", () => {
  const lines = [
    verdict({ state: "applied", host: "h", expected: EXPECTED }, { hasCredentials: true }).line,
    verdict({ state: "not-applied", missing: ["023_x"], expected: EXPECTED }, { hasCredentials: true }).line,
    verdict({ state: "unreachable", detail: "x", expected: EXPECTED }, { hasCredentials: true }).line,
    verdict({ state: "wrong-target", detail: "y", expected: EXPECTED }, { hasCredentials: true }).line,
  ];
  assert.equal(new Set(lines).size, 4, "two states print the same thing");
});
