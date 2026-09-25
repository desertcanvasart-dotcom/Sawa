// S07 — how the app connects to Postgres over TLS.
//
// With PGSSL=true the connection was encrypted but the server's certificate was
// never checked (rejectUnauthorized: false): anything able to intercept the
// connection, or stand in for the database host, would have been trusted.
//
// Verification needs Supabase's CA certificate, which only the project
// dashboard supplies (Project Settings → Database → SSL configuration →
// Download certificate). So it is switched on by providing it:
//
//   PGSSL_CA   the certificate's PEM text (literal newlines, or "\n"-escaped
//              on one line — both are accepted).
//
// With PGSSL_CA set, the certificate chain AND the host name are verified and
// a mismatch refuses to connect. Without it, behaviour is exactly as before —
// deliberately: the site must never go down because a setting was half-made.
// Test it first with `npm run check:db-tls` (scripts/check-db-tls.js).
//
// Don't add ?sslmode= to DATABASE_URL: node-postgres lets the connection
// string override this object.
export function sslConfig(env = process.env) {
  if (env.PGSSL !== "true") return false;
  const ca = String(env.PGSSL_CA || "").replace(/\\n/g, "\n").trim();
  if (ca) {
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("PGSSL_CA is set but is not a PEM certificate (it should start with -----BEGIN CERTIFICATE-----).");
    }
    return { ca, rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

export const sslVerified = (env = process.env) => {
  const c = sslConfig(env);
  return !!(c && c.rejectUnauthorized);
};
