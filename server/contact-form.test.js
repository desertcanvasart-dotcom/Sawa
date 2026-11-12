// The /contact form is sent by the server (13 Nov 2026): validated, emailed to
// hello@sawa.tours with the visitor as Reply-To, and filed as a signed lead in
// Autoura. Replaces contact-mailto.test.js, which asserted the old mailto form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import { validateContact, contactEmail, registerContactRoutes, CONTACT_PATH } from "./contact-form.js";
import {
  signPayload, buildSignedHeaders, sendLeadToAutoura, toAutouraLead, newReference, defaultSendDeps,
  SIGNATURE_HEADER,
} from "./autoura-lead.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const good = { name: "Ada Lovelace", email: "ada@example.com", role: "Traveler", subject: "Dates", message: "Hello there", consent: "yes" };

// ---- validation -------------------------------------------------------------

test("a complete message is accepted and tidied", () => {
  const v = validateContact({ ...good, name: "  Ada   Lovelace ", consent: true });
  assert.equal(v.ok, true);
  assert.equal(v.contact.name, "Ada Lovelace");
  assert.equal(v.contact.email, "ada@example.com");
});

test("each required field is refused with its own message", () => {
  for (const [field, body] of [
    ["name", { ...good, name: "  " }],
    ["email", { ...good, email: "not-an-email" }],
    ["email", { ...good, email: undefined }],
    ["message", { ...good, message: "" }],
    ["message", { ...good, message: "x".repeat(5001) }],
    ["consent", { ...good, consent: undefined }],
    ["consent", { ...good, consent: "no" }],
  ]) {
    const v = validateContact(body);
    assert.equal(v.ok, false, `${field} should be refused`);
    assert.equal(v.field, field);
    assert.ok(v.error && !/invalid input/i.test(v.error), `a readable message for ${field}: ${v.error}`);
  }
});

test("an unknown role falls back rather than failing the visitor", () => {
  assert.equal(validateContact({ ...good, role: "Hacker" }).contact.role, "Something else");
  assert.equal(validateContact({ ...good, role: undefined }).contact.role, "Something else");
});

test("a filled honeypot is treated as spam, whatever else is sent", () => {
  assert.deepEqual(validateContact({ ...good, website: "http://spam" }), { ok: true, spam: true });
  assert.deepEqual(validateContact({ website: "x" }), { ok: true, spam: true });
});

test("the team email escapes the visitor's text and replies to the visitor", () => {
  const m = contactEmail({ contact: { ...validateContact(good).contact, message: "<script>x</script>" }, reference: "SAWA-ABCD2345" });
  assert.equal(m.to, "hello@sawa.tours");
  assert.equal(m.replyTo, "ada@example.com");
  assert.match(m.subject, /SAWA-ABCD2345/);
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.text, /ada@example\.com/);
});

// ---- signing (the receiver's published vector) ------------------------------

test("KEYSTONE: the signature matches Autoura's published test vector", () => {
  // travel-ops-pro app/api/webhooks/concierge GET; mirrored in travel2egypt-next.
  assert.equal(
    signPayload("whsec_test_concierge_autoura", 1735732800, '{"conversation_id":"test-conversation","brief_revision":1}'),
    "3cc2e7aba5b04ecf03020484f1befcdb128b1cb83f38030550591b159334db5a",
  );
});

test("signed headers carry t=<unix>,v1=<hex> over the exact body", () => {
  const h = buildSignedHeaders({ secret: "s", rawBody: '{"a":1}', nowSeconds: 100, requestId: "r1" });
  assert.equal(h[SIGNATURE_HEADER], `t=100,v1=${signPayload("s", 100, '{"a":1}')}`);
  assert.equal(h["X-Autoura-Timestamp"], "100");
  assert.equal(h["X-Request-Id"], "r1");
  assert.equal(h["Content-Type"], "application/json");
});

test("the lead body is what Autoura's validateExternalEnquiry reads", () => {
  const ref = newReference();
  assert.match(ref, /^SAWA-[A-Z0-9]{8}$/);
  assert.notEqual(ref, newReference(), "unique per enquiry");
  const p = toAutouraLead(ref, validateContact(good).contact, { pageUrl: "https://sawa.tours/contact" });
  assert.equal(p.brand, "sawa");
  assert.equal(p.reference, ref);
  assert.match(p.reference, /^[A-Za-z0-9-]{4,40}$/);
  assert.equal(p.email, "ada@example.com");
  assert.ok(p.kind.length <= 20);
  assert.match(p.notes, /Ada Lovelace \(Traveler\)/);
  assert.match(p.notes, /Subject: Dates/);
  assert.match(p.notes, /Hello there/);
  assert.equal(p.page_url, "https://sawa.tours/contact");
});

// ---- delivery: retries, finality, never throws ------------------------------

function deps(statuses, extra = {}) {
  const calls = [];
  return {
    calls,
    url: "https://autoura.test/api/webhooks/website-lead", secret: "s3cret",
    post: async (url, headers, body) => {
      calls.push({ url, headers, body });
      const s = statuses[calls.length - 1];
      if (s instanceof Error) throw s;
      return { httpStatus: s, response: null };
    },
    sleep: async () => {}, nowSeconds: () => 1700000000, requestId: () => `req-${calls.length}`,
    ...extra,
  };
}

test("sent on a 2xx, signature verifies over the bytes actually posted", async () => {
  const d = deps([200]);
  const r = await sendLeadToAutoura({ brand: "sawa", reference: "SAWA-1" }, d);
  assert.equal(r.status, "sent");
  const { headers, body } = d.calls[0];
  assert.equal(headers[SIGNATURE_HEADER], `t=1700000000,v1=${signPayload("s3cret", 1700000000, body)}`);
});

test("a 5xx or network error is retried, three tries in all", async () => {
  const d = deps([503, new Error("ECONNRESET"), 502]);
  const r = await sendLeadToAutoura({ a: 1 }, d);
  assert.equal(r.status, "failed");
  assert.equal(d.calls.length, 3);
  const d2 = deps([500, 201]);
  assert.equal((await sendLeadToAutoura({ a: 1 }, d2)).status, "sent");
  assert.equal(d2.calls.length, 2);
});

test("a 4xx is final", async () => {
  const d = deps([401, 200]);
  const r = await sendLeadToAutoura({ a: 1 }, d);
  assert.equal(r.status, "failed");
  assert.equal(r.httpStatus, 401);
  assert.equal(d.calls.length, 1);
});

test("without the URL or secret nothing is posted", async () => {
  const d = deps([200], { secret: null });
  assert.equal((await sendLeadToAutoura({ a: 1 }, d)).status, "skipped");
  assert.equal(d.calls.length, 0);
  const env = defaultSendDeps({ AUTOURA_LEAD_WEBHOOK_URL: " https://x/y ", AUTOURA_WEBHOOK_SECRET: "" });
  assert.equal(env.url, "https://x/y");
  assert.equal(env.secret, null);
});

// ---- the route --------------------------------------------------------------

async function withServer({ emailResult = { ok: true }, max = 1000 } = {}, fn) {
  const emails = [], leads = [];
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json());
  registerContactRoutes(app, {
    sendEmail: async (m) => { emails.push(m); if (emailResult instanceof Error) throw emailResult; return emailResult; },
    limiter: rateLimit({ windowMs: 60_000, max, message: { ok: false, error: "slow down" } }),
    sendLead: async (p) => { leads.push(p); return { status: "sent" }; },
    reference: () => "SAWA-TEST2345",
    log: { warn() {}, error() {} },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, emails, leads });
  } finally {
    server.close();
  }
}
const postJson = (base, body) => fetch(base + CONTACT_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 20));

test("route: a good message is emailed and filed as a lead", async () => {
  await withServer({}, async ({ base, emails, leads }) => {
    const r = await postJson(base, { ...good, consent: true });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, reference: "SAWA-TEST2345" });
    await settle();
    assert.equal(emails.length, 1);
    assert.equal(emails[0].replyTo, "ada@example.com");
    assert.equal(leads.length, 1);
    assert.equal(leads[0].reference, "SAWA-TEST2345");
    assert.equal(leads[0].brand, "sawa");
  });
});

test("route: invalid input is a 400 naming the field; nothing is sent", async () => {
  await withServer({}, async ({ base, emails, leads }) => {
    const r = await postJson(base, { ...good, email: "nope" });
    assert.equal(r.status, 400);
    const b = await r.json();
    assert.equal(b.ok, false);
    assert.equal(b.field, "email");
    await settle();
    assert.equal(emails.length + leads.length, 0);
  });
});

test("route: the honeypot answers OK and sends nothing", async () => {
  await withServer({}, async ({ base, emails, leads }) => {
    const r = await postJson(base, { ...good, website: "spam.example" });
    assert.equal(r.status, 200);
    await settle();
    assert.equal(emails.length + leads.length, 0);
  });
});

test("route: a failed email is a clear failure with WhatsApp as the fallback", async () => {
  for (const emailResult of [{ ok: false }, new Error("boom")]) {
    await withServer({ emailResult }, async ({ base, leads }) => {
      const r = await postJson(base, good);
      assert.equal(r.status, 502);
      const b = await r.json();
      assert.equal(b.ok, false);
      assert.match(b.error, /didn't send/);
      assert.match(b.error, /\+20 109 284 7613/);
      assert.equal(b.whatsapp, "https://wa.me/201092847613");
      await settle();
      assert.equal(leads.length, 1, "the CRM still gets the enquiry");
    });
  }
});

test("route: a plain (no-JavaScript) form post is redirected back with the outcome", async () => {
  await withServer({}, async ({ base }) => {
    const form = new URLSearchParams({ ...good }).toString();
    const r = await fetch(base + CONTACT_PATH, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/contact?sent=1#contact-form");
  });
});

test("route: rate-limited", async () => {
  await withServer({ max: 2 }, async ({ base }) => {
    assert.equal((await postJson(base, good)).status, 200);
    assert.equal((await postJson(base, good)).status, 200);
    assert.equal((await postJson(base, good)).status, 429);
  });
});

// ---- the page ---------------------------------------------------------------

test("/contact's form posts to the server, not to an email app", () => {
  const page = readFileSync(join(ROOT, "site", "contact.html"), "utf8");
  const form = page.slice(page.indexOf('id="contact-form"'), page.indexOf("</form>"));
  assert.match(form, /action="\/api\/public\/contact" method="post"/);
  assert.doesNotMatch(form, /action="mailto:/);
  assert.match(form, /name="website"/, "honeypot");
  assert.match(form, /type="submit">Send message/);
  assert.match(form, /class="fail" role="alert"[\s\S]*wa\.me\/201092847613/, "WhatsApp on failure");
  assert.doesNotMatch(page, /window\.location\.href = 'mailto:/);
  const app = readFileSync(join(ROOT, "src", "PublicPages.jsx"), "utf8");
  assert.doesNotMatch(app, /window\.location\.href = `mailto:/, "the in-app contact page posts too");
  assert.match(app, /fetch\("\/api\/public\/contact"/);
});
