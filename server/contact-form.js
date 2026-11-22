// ============================================
// CONTACT FORM — /contact's "Send us a message", sent by the server
// ============================================
// Until 13 Nov 2026 the form's action was mailto:hello@sawa.tours: it only
// opened the visitor's own email app, so anyone without one configured sent
// nothing at all. Now POST /api/public/contact:
//   1. validates the fields (and a honeypot — a filled one is answered as a
//      success and nothing is sent, so a bot learns nothing),
//   2. emails hello@sawa.tours through Resend with the visitor as Reply-To
//      (hello@ is synced into Autoura, which files a website-relayed email
//      under its Reply-To person),
//   3. ALSO sends the enquiry, signed, to Autoura's website-lead webhook
//      (autoura-lead.js) — after answering, never blocking the visitor.
// The visitor is told plainly whether it went; on a failure the page offers
// WhatsApp. Rate-limited by the caller (app.js passes the limiter).
//
// A plain form POST is answered with a redirect back to /contact?sent=1 (or
// 0), which the page turns into the same message.
//
// Bots (22 Nov 2026): a spam run ("Hello, I wrote about your price", in a new
// language each time, from rotating addresses) went straight past the
// honeypot and the per-address limit. A message is now only taken from the
// page itself:
//   - the page's script asks GET /api/public/contact/form for a form token
//     (a signed time) and sends it back. No token, which is what a script
//     posting straight here sends, is dropped;
//   - sent less than MIN_FILL_MS after the token was issued is a bot too;
//   - with TURNSTILE_SECRET_KEY set, Cloudflare Turnstile is checked as well
//     (the same check as the booking forms).
// A dropped message is answered as if it went (a bot learns nothing), and
// nothing is emailed or filed in Autoura. A token that doesn't verify
// (a restart without CONTACT_FORM_SECRET, a page left open for hours) is
// told plainly to reload, so a person never loses a message in silence.
// ============================================

import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BRAND } from "./brand.js";
import { newReference, toAutouraLead, sendLeadToAutoura } from "./autoura-lead.js";

export const CONTACT_PATH = "/api/public/contact";
export const CONTACT_FORM_PATH = "/api/public/contact/form";
export const MIN_FILL_MS = 3000;
export const MAX_TOKEN_AGE_MS = 12 * 3600 * 1000;
export const ROLES = ["Traveler", "Operator / agency", "Press", "Something else"];
export const WHATSAPP_URL = "https://wa.me/201092847613";
export const WHATSAPP_LABEL = "+20 109 284 7613";

const oneLine = (max) => z.string().trim().max(max).transform((s) => s.replace(/\s+/g, " "));

const schema = z.object({
  name: oneLine(100).pipe(z.string().min(1, "Please tell us your name.")),
  email: z.string().trim().max(254).pipe(z.email("Please enter a valid email address.")),
  role: z.enum(ROLES).catch("Something else"),
  subject: oneLine(150).optional().default(""),
  message: z.string().trim().min(1, "Please write a message.").max(5000, "Please keep the message under 5,000 characters."),
  consent: z.union([z.literal(true), z.literal("yes"), z.literal("on"), z.literal("true")], {
    error: "Please tick the box so we can reply to you.",
  }),
});

/**
 * → { ok: true, contact } | { ok: false, field, error } | { ok: true, spam: true }
 * `website` is the honeypot: hidden from people, filled by naive bots.
 */
export function validateContact(body) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.website === "string" && b.website.trim() !== "") return { ok: true, spam: true };
  const r = schema.safeParse(b);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = String(issue.path[0] ?? "form");
    return { ok: false, field, error: field === "email" && issue.code !== "custom" ? "Please enter a valid email address." : issue.message };
  }
  return { ok: true, contact: r.data };
}

// ---- form token: proof the message was written on the page --------------
// CONTACT_FORM_SECRET keeps tokens valid across restarts; without it a restart
// only means a page opened before it is asked to reload.
const DEFAULT_SECRET = process.env.CONTACT_FORM_SECRET || randomBytes(32).toString("hex");
const sign = (secret, t) => createHmac("sha256", secret).update(`contact-form:${t}`).digest("base64url");

export function issueFormToken({ secret = DEFAULT_SECRET, now = Date.now() } = {}) {
  return `${now}.${sign(secret, now)}`;
}

/**
 * → { ok: true } | { ok: false, reason: "missing" | "invalid" | "expired" | "too_fast" }
 * "missing" and "too_fast" are what a bot sends; "invalid" and "expired" can
 * happen to a person (a restart, a tab left open), so they are told to reload.
 */
export function checkFormToken(token, { secret = DEFAULT_SECRET, now = Date.now(), minMs = MIN_FILL_MS, maxMs = MAX_TOKEN_AGE_MS } = {}) {
  if (typeof token !== "string" || token === "") return { ok: false, reason: "missing" };
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  if (!m) return { ok: false, reason: "invalid" };
  const t = Number(m[1]);
  const want = Buffer.from(sign(secret, t));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "invalid" };
  const age = now - t;
  if (age > maxMs || age < -60_000) return { ok: false, reason: "expired" };
  if (age < minMs) return { ok: false, reason: "too_fast" };
  return { ok: true };
}

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The email to the team. Every value is the visitor's, so the HTML escapes it. */
export function contactEmail({ contact, reference, to = BRAND.email }) {
  const subject = `Website contact: ${contact.subject || `message from ${contact.name}`} [${reference}]`;
  const text =
    `A message from the contact form on sawa.tours.\n\n`
    + `Name: ${contact.name}\nEmail: ${contact.email}\nI am a: ${contact.role}\n`
    + (contact.subject ? `Subject: ${contact.subject}\n` : "")
    + `Reference: ${reference}\n\n${contact.message}\n\n`
    + `Reply to this email to answer ${contact.name} directly.\n`;
  return {
    to, subject, text, kind: "contact_form", replyTo: contact.email,
    html: `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${esc(text)}</pre>`,
  };
}

const wantsJson = (req) => (req.get("content-type") || "").includes("application/json");

/**
 * Register the route. deps: sendEmail (email.js), limiter (express-rate-limit),
 * and optionally sendLead / reference / log for tests.
 */
export function registerContactRoutes(app, {
  sendEmail, limiter, sendLead = sendLeadToAutoura, reference = newReference,
  log = console, siteUrl = BRAND.url,
  secret = DEFAULT_SECRET, now = () => Date.now(), minFillMs = MIN_FILL_MS,
  verifyTurnstile = async () => ({ ok: true, skipped: true }), turnstileSiteKey = () => null,
}) {
  // What the page asks for when it loads: its form token, and the Turnstile
  // site key when there is one.
  app.get(CONTACT_FORM_PATH, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ formToken: issueFormToken({ secret, now: now() }), turnstileSiteKey: turnstileSiteKey() });
  });

  const form = express.urlencoded({ extended: false, limit: "20kb" });
  app.post(CONTACT_PATH, limiter, form, async (req, res) => {
    const json = wantsJson(req);
    const answer = (status, body) => (json
      ? res.status(status).json(body)
      : res.redirect(303, `/contact?sent=${body.ok ? 1 : 0}#contact-form`));
    // Answered as sent; nothing goes anywhere. A plain form POST without a
    // token is told it failed instead: it may be a person without JavaScript,
    // and the page offers WhatsApp.
    const drop = (reason) => {
      log.info?.(`[contact] dropped as a bot (${reason})`);
      return json ? answer(200, { ok: true }) : answer(400, { ok: false });
    };

    const v = validateContact(req.body);
    if (v.ok && v.spam) return drop("honeypot");
    const token = checkFormToken(req.body?.formToken, { secret, now: now(), minMs: minFillMs });
    if (!token.ok && (token.reason === "missing" || token.reason === "too_fast")) return drop(token.reason);
    if (!token.ok) {
      return answer(400, { ok: false, field: "form", error: "This page was open for a long time. Please reload it and send your message again." });
    }
    if (!v.ok) return answer(400, { ok: false, field: v.field, error: v.error });
    const human = await verifyTurnstile({ token: req.body?.turnstileToken, ip: req.ip });
    if (!human.ok) {
      log.info?.(`[contact] Turnstile refused (${human.reason})`);
      return answer(403, { ok: false, field: "form", error: "We couldn't check that this message came from a person. Please reload the page and try again." });
    }

    const ref = reference();
    const contact = v.contact;

    // The lead goes to Autoura whatever the email does: it is a second door
    // into the same CRM, and it runs after the visitor has their answer.
    const fireLead = () => {
      const payload = toAutouraLead(ref, contact, { pageUrl: `${siteUrl}/contact` });
      Promise.resolve()
        .then(() => sendLead(payload))
        .then((r) => {
          if (r.outcome === "failed") log.warn?.(`[contact] Autoura lead ${ref} not filed`, r.httpStatus, r.response);
          else if (r.outcome === "skipped") log.warn?.(`[contact] Autoura lead ${ref} skipped — ${r.response?.reason}`);
        })
        .catch((e) => log.error?.(`[contact] Autoura lead ${ref} threw`, e?.message));
    };

    let sent;
    try {
      sent = await sendEmail(contactEmail({ contact, reference: ref }));
    } catch (e) {
      log.error?.(`[contact] email for ${ref} threw`, e?.message);
      sent = { ok: false };
    }
    if (!sent?.ok) {
      answer(502, {
        ok: false,
        error: `Sorry — your message didn't send. Please try again, or message us on WhatsApp (${WHATSAPP_LABEL}).`,
        whatsapp: WHATSAPP_URL,
      });
      fireLead();
      return;
    }
    answer(200, { ok: true, reference: ref });
    fireLead();
  });
}
