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
// Works without JavaScript too: a plain form POST is answered with a redirect
// back to /contact?sent=1 (or 0), which the page turns into the same message.
// ============================================

import express from "express";
import { z } from "zod";
import { BRAND } from "./brand.js";
import { newReference, toAutouraLead, sendLeadToAutoura } from "./autoura-lead.js";

export const CONTACT_PATH = "/api/public/contact";
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
}) {
  const form = express.urlencoded({ extended: false, limit: "20kb" });
  app.post(CONTACT_PATH, limiter, form, async (req, res) => {
    const json = wantsJson(req);
    const answer = (status, body) => (json
      ? res.status(status).json(body)
      : res.redirect(303, `/contact?sent=${body.ok ? 1 : 0}#contact-form`));

    const v = validateContact(req.body);
    if (v.ok && v.spam) return answer(200, { ok: true });
    if (!v.ok) return answer(400, { ok: false, field: v.field, error: v.error });

    const ref = reference();
    const contact = v.contact;

    // The lead goes to Autoura whatever the email does: it is a second door
    // into the same CRM, and it runs after the visitor has their answer.
    const fireLead = () => {
      const payload = toAutouraLead(ref, contact, { pageUrl: `${siteUrl}/contact` });
      Promise.resolve()
        .then(() => sendLead(payload))
        .then((r) => {
          if (r.status === "failed") log.warn?.(`[contact] Autoura lead ${ref} not filed`, r.httpStatus, r.response);
          else if (r.status === "skipped") log.warn?.(`[contact] Autoura lead ${ref} skipped — ${r.response?.reason}`);
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
