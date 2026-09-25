// S07 — will certificate verification work? Run BEFORE setting PGSSL_CA in
// Railway, so a wrong certificate is found here and not by the live site.
//
//   DATABASE_URL=<production> PGSSL=true PGSSL_CA="$(cat prod-ca-2021.crt)" npm run check:db-tls
//
// Connects with verification ON, runs one read-only query, and prints who
// signed the server's certificate. Exit 0 means it is safe to set PGSSL_CA;
// anything else prints why and exits 1. Changes nothing in the database.
import pg from "pg";
import { sslConfig } from "../server/db/ssl.js";

const env = { ...process.env, PGSSL: "true" };
if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(1); }
if (!env.PGSSL_CA) { console.error("PGSSL_CA is not set — pass the Supabase CA certificate (PEM) to test it."); process.exit(1); }

let ssl;
try { ssl = sslConfig(env); } catch (e) { console.error(e.message); process.exit(1); }

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  const r = await client.query("SELECT current_database() AS db, version() AS v");
  const peer = client.connection?.stream?.getPeerCertificate?.() || {};
  console.log(`OK — connected with the certificate verified.
  database: ${r.rows[0].db}
  server certificate: ${peer.subject?.CN || "?"} (issued by ${peer.issuer?.CN || peer.issuer?.O || "?"}), valid until ${peer.valid_to || "?"}
It is safe to set PGSSL_CA in Railway.`);
  await client.end();
} catch (e) {
  console.error(`FAILED — verification would stop the site connecting: ${e.code || ""} ${e.message}
Do NOT set PGSSL_CA in Railway with this certificate. Check it is the one from
Supabase → Project Settings → Database → SSL configuration, and that
DATABASE_URL has no ?sslmode= parameter.`);
  process.exit(1);
}
