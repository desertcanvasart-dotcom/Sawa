// S04 — direct travellers confirm their phone with a one-time code (Twilio
// Verify) before a seat is held. Off until Twilio is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePhone, issuePhoneToken, phoneTokenValid, PHONE_TOKEN_TTL_MS,
  phoneVerificationEnabled, startVerification, checkVerification,
} from "./phone-verify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");

test("numbers are normalised to E.164; Egyptian mobiles may be typed locally", () => {
  const cases = [
    ["010 1234 5678", "+201012345678"],
    ["+20 101 234 5678", "+201012345678"],
    ["0020-101-234-5678", "+201012345678"],
    ["+44 7700 900123", "+447700900123"],
    ["(+1) 415 555 0100", "+14155550100"],
  ];
  assert.ok(cases.length > 0);
  for (const [input, want] of cases) assert.equal(normalizePhone(input), want, input);
  const bads = ["", "12345", "07700 900123", "+0123456789", "not a number"];
  assert.ok(bads.length > 0);
  for (const bad of bads) {
    assert.equal(normalizePhone(bad), null, `accepted: ${bad}`);
  }
});

test("a token proves one number, for a limited time, and can't be forged", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const t = issuePhoneToken("+201012345678", now);
  assert.equal(phoneTokenValid(t, "+201012345678", now), true);
  assert.equal(phoneTokenValid(t, "+201012345679", now), false, "another number");
  assert.equal(phoneTokenValid(t, "+201012345678", now + PHONE_TOKEN_TTL_MS + 1), false, "expired");
  const [body, mac] = t.split(".");
  const other = Buffer.from("+201099999999." + (now + PHONE_TOKEN_TTL_MS)).toString("base64url");
  assert.equal(phoneTokenValid(`${other}.${mac}`, "+201099999999", now), false, "body swapped under the old signature");
  assert.equal(phoneTokenValid(`${body}.x${mac.slice(1)}`, "+201012345678", now), false, "signature altered");
  const junks = [undefined, "", "abc", "a.b.c"];
  assert.ok(junks.length > 0);
  for (const junk of junks) assert.equal(phoneTokenValid(junk, "+201012345678", now), false);
});

test("Twilio Verify is called as documented", async () => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "secret"; process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
  const calls = [];
  const fake = (reply) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => reply }; };
  try {
    assert.equal(phoneVerificationEnabled(), true);
    await startVerification("+201012345678", "whatsapp", fake({ status: "pending" }));
    assert.equal(calls[0].url, "https://verify.twilio.com/v2/Services/VAtest/Verifications");
    assert.equal(calls[0].init.headers.Authorization, "Basic " + Buffer.from("ACtest:secret").toString("base64"));
    assert.equal(calls[0].init.body, "To=%2B201012345678&Channel=whatsapp");
    assert.equal(await checkVerification("+201012345678", "123456", fake({ status: "approved" })), true);
    assert.equal(calls[1].url, "https://verify.twilio.com/v2/Services/VAtest/VerificationCheck");
    assert.equal(await checkVerification("+201012345678", "000000", fake({ status: "pending" })), false, "only 'approved' passes");
  } finally {
    delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_VERIFY_SERVICE_SID;
  }
  assert.equal(phoneVerificationEnabled(), false, "any key missing means off");
});

const route = (sig) => {
  const f = app.indexOf(sig);
  assert.ok(f > 0, `not found: ${sig}`);
  return app.slice(f, app.indexOf("\n}));", f));
};

test("direct bookings and date requests need a verified number, checked before anything is written", () => {
  const sigs = ['app.post("/api/public/departures/:id/bookings"', 'app.post("/api/public/departure-requests"'];
  assert.ok(sigs.length > 0);
  for (const sig of sigs) {
    const body = route(sig);
    const check = body.indexOf("input.customerPhone = verifiedPhoneFor(input);");
    assert.ok(check > 0, `${sig} doesn't verify the phone`);
    const write = Math.min(...["withTransaction", "createDateRequest"].map((w) => body.indexOf(w)).filter((i) => i > 0));
    assert.ok(check < write, `${sig} verifies after it starts writing`);
  }
  const fn = app.slice(app.indexOf("function verifiedPhoneFor("), app.indexOf('app.post("/api/public/phone-verifications"'));
  assert.match(fn, /if \(!phoneVerificationEnabled\(\)\) return input\.customerPhone \|\| null;/, "off means bookings work as before");
  assert.match(fn, /phoneTokenValid\(input\.phoneToken, phone\)/);
});

test("agencies are not asked; the booking form is told whether to ask", () => {
  assert.doesNotMatch(route('app.post("/api/agency/departure-requests"'), /verifiedPhoneFor/);
  assert.match(app, /phoneVerification: phoneVerificationEnabled\(\),/);
});

test("S04 basics: email required server-side; one live booking per verified number per date", () => {
  const schema = app.slice(app.indexOf("const publicBookingSchema"), app.indexOf("});", app.indexOf("const publicBookingSchema")));
  assert.match(schema, /customerEmail: z\.string\(\)\.trim\(\)\.email\("A valid email is required\."\),/);
  assert.match(route('app.post("/api/public/departures/:id/bookings"'), /p\.customerPhone === input\.customerPhone/);
});
