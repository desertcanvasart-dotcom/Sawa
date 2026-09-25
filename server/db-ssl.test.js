// S07 — database TLS verifies the server's certificate once PGSSL_CA is set,
// and behaves exactly as before until then. The live checks were run against a
// local Postgres with its own CA: right CA connects; an attacker's CA, and a
// certificate from the right CA for another host, are both refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sslConfig, sslVerified } from "./db/ssl.js";

const here = dirname(fileURLToPath(import.meta.url));
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";

test("no PGSSL: no TLS, as before (local development)", () => {
  assert.equal(sslConfig({}), false);
  assert.equal(sslConfig({ PGSSL: "false", PGSSL_CA: PEM }), false);
});

test("PGSSL without a CA: encrypted, unverified — exactly today's behaviour", () => {
  assert.deepEqual(sslConfig({ PGSSL: "true" }), { rejectUnauthorized: false });
  assert.equal(sslVerified({ PGSSL: "true" }), false);
});

test("PGSSL with a CA: the chain and the host name are verified", () => {
  assert.deepEqual(sslConfig({ PGSSL: "true", PGSSL_CA: PEM }), { ca: PEM, rejectUnauthorized: true });
  assert.equal(sslVerified({ PGSSL: "true", PGSSL_CA: PEM }), true);
});

test("a one-line, \\n-escaped PEM (as pasted into a dashboard) is accepted", () => {
  const oneLine = PEM.replace(/\n/g, "\\n");
  assert.equal(sslConfig({ PGSSL: "true", PGSSL_CA: oneLine }).ca, PEM);
});

test("something that isn't a certificate fails loudly at start-up, not silently unverified", () => {
  assert.throws(() => sslConfig({ PGSSL: "true", PGSSL_CA: "paste here" }), /not a PEM certificate/);
});

test("both pools take their TLS settings from the one rule", () => {
  assert.match(readFileSync(join(here, "db", "index.js"), "utf8"), /const ssl = sslConfig\(\);/);
  assert.match(readFileSync(join(here, "db", "readonly.js"), "utf8"), /ssl: sslConfig\(env\),/);
  for (const f of ["index.js", "readonly.js"]) {
    assert.doesNotMatch(readFileSync(join(here, "db", f), "utf8"), /rejectUnauthorized/, `${f} decides TLS itself again`);
  }
});
