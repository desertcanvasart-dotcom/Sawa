// Cloudflare Turnstile on the public booking forms (the tour page and the
// widget), checked on the server.
//
//   TURNSTILE_SITE_KEY    public; sent to the browser with the bootstrap
//   TURNSTILE_SECRET_KEY  private; used here only
//
// No secret key: the check is skipped and a warning logged once, so the site
// never breaks for want of a key. Cloudflare unreachable: the booking goes
// through and the failure is logged, for the same reason. Only Cloudflare's
// own "this token is not valid" refuses a booking.
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const turnstileSiteKey = (env = process.env) => String(env.TURNSTILE_SITE_KEY || "").trim() || null;

let warned = false;
export async function verifyTurnstile({ token, ip, env = process.env, fetchImpl = fetch, log = console.warn } = {}) {
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    if (!warned) {
      warned = true;
      log("[turnstile] TURNSTILE_SECRET_KEY is not set; the bot check on booking forms is skipped.");
    }
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, reason: "missing" };
  const body = new URLSearchParams({ secret, response: String(token).slice(0, 2048) });
  if (ip) body.set("remoteip", ip);
  try {
    const r = await fetchImpl(env.TURNSTILE_VERIFY_URL || VERIFY_URL, {
      method: "POST", body, signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.success === true) return { ok: true };
    if (j.success === false) return { ok: false, reason: (j["error-codes"] || []).join(",") || "invalid" };
    log(`[turnstile] unexpected answer (HTTP ${r.status}); the booking goes through.`);
    return { ok: true, unverified: true };
  } catch (e) {
    log(`[turnstile] verification unavailable (${e.message}); the booking goes through.`);
    return { ok: true, unverified: true };
  }
}
