// ============================================
// AUTOURA LEAD — a website enquiry, signed, into Autoura's CRM
// ============================================
// The contact form's message is emailed to hello@sawa.tours (the primary
// channel). It is ALSO POSTed here to Autoura's /api/webhooks/website-lead,
// which files it as a lead in the Sawa company — once per `reference`, so a
// retry or a replay never files it twice.
//
// Same contract as travel2egypt-next (src/lib/leads/autoura.ts + concierge/
// autoura/sign.ts), which the receiver verifies:
//  - HMAC-SHA256, lowercase hex, over `${t}.${rawBody}`; header
//    `X-Autoura-Signature: t=<unix>,v1=<hex>`. The secret is the concierge
//    webhook's (AUTOURA_WEBHOOK_SECRET) — NOT the departure mirror's
//    AUTOURA_SYNC_SECRET.
//  - Sign over the EXACT bytes sent: serialize once, send that string.
//  - Up to 3 sends (1s, 3s apart) on a network error or 5xx; a 4xx is final.
//  - NEVER throws, and the visitor never waits for it (the route fires it
//    after answering). Missing URL or secret → 'skipped', no POST.
//
// Env: AUTOURA_LEAD_WEBHOOK_URL  https://getautoura.net/api/webhooks/website-lead
//      AUTOURA_WEBHOOK_SECRET    the concierge webhook's shared secret
// Every external dependency is injectable so the tests run offline.
// ============================================

import { createHmac, randomBytes, randomUUID } from "node:crypto";

export const BRAND_KEY = "sawa";
export const SIGNATURE_HEADER = "X-Autoura-Signature";
export const TIMESTAMP_HEADER = "X-Autoura-Timestamp";
export const REQUEST_ID_HEADER = "X-Request-Id";

/** Lowercase hex HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function signPayload(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** The headers for one attempt. The signature covers `rawBody` exactly. */
export function buildSignedHeaders({ secret, rawBody, nowSeconds, requestId }) {
  return {
    "Content-Type": "application/json",
    [SIGNATURE_HEADER]: `t=${nowSeconds},v1=${signPayload(secret, nowSeconds, rawBody)}`,
    [TIMESTAMP_HEADER]: String(nowSeconds),
    [REQUEST_ID_HEADER]: requestId,
  };
}

// Crockford-ish alphabet: no 0/O or 1/I/L to misread when quoted on a call.
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** A fresh reference for one enquiry, e.g. "SAWA-7K3MQX9P". */
export function newReference(bytes = randomBytes(8)) {
  let s = "";
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `SAWA-${s}`;
}

/** The wire body Autoura's validateExternalEnquiry reads (snake_case). Autoura
 *  takes no name field (it names the lead from the email), so the visitor's
 *  name, role and subject lead the notes. */
export function toAutouraLead(reference, contact, { pageUrl = null } = {}) {
  const head = [
    `Contact form — ${contact.name}${contact.role ? ` (${contact.role})` : ""}`,
    contact.subject ? `Subject: ${contact.subject}` : null,
  ].filter(Boolean).join("\n");
  return {
    brand: BRAND_KEY,
    reference,
    kind: "contact",
    email: contact.email,
    enquiry_type: contact.role || null,
    notes: `${head}\n\n${contact.message}`.slice(0, 4000),
    page_url: pageUrl,
    locale: "en",
  };
}

const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1000, 3000];

async function defaultPost(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    let response = null;
    try { response = await res.json(); } catch { response = null; }
    return { httpStatus: res.status, response };
  } catch (err) {
    return { httpStatus: null, response: { error: err.message } };
  } finally {
    clearTimeout(timer);
  }
}

export function defaultSendDeps(env = process.env) {
  return {
    url: env.AUTOURA_LEAD_WEBHOOK_URL?.trim() || null,
    secret: env.AUTOURA_WEBHOOK_SECRET?.trim() || null,
    post: defaultPost,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    requestId: () => randomUUID(),
  };
}

/** POST one lead to Autoura. Never throws. → { outcome: sent|failed|skipped, attempts, httpStatus, response } */
export async function sendLeadToAutoura(payload, deps = defaultSendDeps()) {
  if (!deps.url || !deps.secret) {
    return { outcome: "skipped", attempts: 0, httpStatus: null, response: { reason: "AUTOURA_LEAD_WEBHOOK_URL or AUTOURA_WEBHOOK_SECRET not set" } };
  }
  const rawBody = JSON.stringify(payload);
  let last = { httpStatus: null, response: null };
  for (let attempt = 1; attempt <= BACKOFF_MS.length + 1; attempt++) {
    try {
      const headers = buildSignedHeaders({ secret: deps.secret, rawBody, nowSeconds: deps.nowSeconds(), requestId: deps.requestId() });
      last = await deps.post(deps.url, headers, rawBody);
    } catch (err) {
      last = { httpStatus: null, response: { error: err?.message } };
    }
    if (last.httpStatus !== null && last.httpStatus >= 200 && last.httpStatus < 300) {
      return { outcome: "sent", attempts: attempt, ...last };
    }
    // A 4xx (bad signature, unmapped brand, bad body) will not change on retry.
    if (last.httpStatus !== null && last.httpStatus >= 400 && last.httpStatus < 500) {
      return { outcome: "failed", attempts: attempt, ...last };
    }
    if (attempt <= BACKOFF_MS.length) await deps.sleep(BACKOFF_MS[attempt - 1]);
  }
  return { outcome: "failed", attempts: BACKOFF_MS.length + 1, ...last };
}
