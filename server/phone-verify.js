// S04 — a direct traveller proves their phone number before holding a seat.
//
// Holding a seat is free and counts toward GoAhead the moment it is made, and a
// direct booking needed nothing but a name: scripted or mistyped reservations
// could fill a date, or push it to GoAhead and start the confirmation and
// payment-link process for travellers who do not exist. The client chose a
// one-time code by SMS or WhatsApp (option C, 25 Sep 2026), sent and checked by
// Twilio Verify. Agencies are signed in and are not asked.
//
// SWITCHED OFF UNTIL CONFIGURED. With TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_VERIFY_SERVICE_SID all set it is enforced; with any of them missing,
// bookings work exactly as they did, and the catalogue tells the page so
// (phoneVerification: false) rather than showing a code step that cannot work.
//
// A correct code is exchanged for a short-lived token, signed here and bound to
// the number, which the booking route checks. Twilio holds the code; Sawa holds
// no state, so there is no table to migrate.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const env = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID || "",
  token: process.env.TWILIO_AUTH_TOKEN || "",
  service: process.env.TWILIO_VERIFY_SERVICE_SID || "",
});

export function phoneVerificationEnabled() {
  const { sid, token, service } = env();
  return Boolean(sid && token && service);
}

// How long a verified number may be used to book, once checked.
export const PHONE_TOKEN_TTL_MS = 30 * 60 * 1000;

// Signing key for the tokens. PHONE_TOKEN_SECRET when set (it survives restarts
// and is shared across instances); otherwise a random key for this process, so
// a restart only means a traveller mid-booking asks for a new code.
const SECRET = process.env.PHONE_TOKEN_SECRET || randomBytes(32).toString("hex");

// E.164 ("+201012345678"). Egyptian local numbers are the common case and are
// accepted as typed ("010 1234 5678"); anything else must carry its country
// code. Returns null for something that cannot be a phone number.
export function normalizePhone(input) {
  let s = String(input ?? "").trim().replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (/^0(10|11|12|15)\d{8}$/.test(s)) s = "+20" + s.slice(1);   // Egyptian mobile
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function issuePhoneToken(phone, nowMs = Date.now()) {
  const exp = nowMs + PHONE_TOKEN_TTL_MS;
  const body = `${phone}.${exp}`;
  return `${Buffer.from(body).toString("base64url")}.${sign(body)}`;
}

// True only for a token this server signed, for exactly this number, unexpired.
export function phoneTokenValid(token, phone, nowMs = Date.now()) {
  if (typeof token !== "string" || !phone) return false;
  const [b64, mac] = token.split(".");
  if (!b64 || !mac) return false;
  let body;
  try { body = Buffer.from(b64, "base64url").toString(); } catch { return false; }
  const expected = sign(body);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const cut = body.lastIndexOf(".");
  const tokenPhone = body.slice(0, cut), exp = Number(body.slice(cut + 1));
  return tokenPhone === phone && Number.isFinite(exp) && nowMs <= exp;
}

// ---- Twilio Verify ---------------------------------------------------------
// fetchImpl is injectable so the calls can be tested without the network.
async function twilio(path, params, fetchImpl = fetch) {
  const { sid, token, service } = env();
  const res = await fetchImpl(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

// Sends a code. Channel "sms" or "whatsapp".
export async function startVerification(phone, channel = "sms", fetchImpl) {
  const r = await twilio("Verifications", { To: phone, Channel: channel === "whatsapp" ? "whatsapp" : "sms" }, fetchImpl);
  return { ok: r.ok, status: r.status, message: r.data?.message };
}

// True when Twilio approves the code for this number.
export async function checkVerification(phone, code, fetchImpl) {
  const r = await twilio("VerificationCheck", { To: phone, Code: String(code ?? "").trim() }, fetchImpl);
  return r.ok && r.data?.status === "approved";
}
