// Provider-agnostic transactional email.
//
// If RESEND_API_KEY + EMAIL_FROM are set, emails are sent for real via the
// Resend HTTP API (no SDK needed). Otherwise we run in "log" mode: the email
// is recorded to the email_log table and printed to the console, and the
// caller's temp-password fallback still applies. Flipping to real delivery is
// just adding two env vars — no code change.
import "dotenv/config";
import { pool } from "./db/index.js";
import { BRAND } from "./brand.js";
import { CURRENCY, CURRENCY_SYMBOL } from "../shared/currency.js";
import {
  cancellationBandsFor, chargeText, depositPctFor, CANCELLATION_COLUMNS,
  CANCELLATION_BEFORE_GOAHEAD, CANCELLATION_QUALIFIER, CANCELLATION_CAP,
} from "../shared/booking-policy.js";
import { recordSuccess, recordFailure } from "./effect-log.js";
import { rethrowIfProgrammerError, fireAndForget } from "./errors.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Sawa Tours <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "http://localhost:5173";

// Where replies go.
//
// This was a workaround: mail sent from noreply@/hello@sawa.tours while that
// domain had a CNAME at its apex, which answers MX queries too, so mail servers
// found no mailhost and every reply bounced. sawa.tours now has a proper ALIAS
// apex and an MX pointing at Google Workspace, so the From address is a real
// mailbox and this is no longer load-bearing.
//
// Kept anyway, because the From address is not always the one to reply to:
// Supabase sends its auth mail from noreply@sawa.tours, and the two addresses
// should not have to stay in step by coincidence. EMAIL_REPLY_TO overrides it.
const REPLY_TO = process.env.EMAIL_REPLY_TO || BRAND.email;

export const emailMode = RESEND_API_KEY ? "live" : "log";

async function recordEmail({ to, subject, kind, status, error }) {
  try {
    await pool.query(
      `INSERT INTO email_log (recipient, subject, kind, status, error)
       VALUES ($1,$2,$3,$4,$5)`,
      [to, subject, kind, status, error || null]
    );
  } catch (e) {
    // email_log is best-effort; never let logging break a flow.
    console.error("email_log insert failed:", e.message);
  }
}

// ---- O01 — the outbox --------------------------------------------------------
//
// An email that failed, or was mid-send when the process restarted, used to be
// gone: email_log recorded the failure but not the message. Each live send now
// writes its row WITH the content first (status 'pending'), then marks it
// 'sent' or 'failed'; retryPendingEmails() — a scheduled job — sends the
// failed ones again with growing gaps, and picks up any row a restart left
// pending. Resend's Idempotency-Key is the row id, so a retry of a send that
// did in fact go through is not delivered twice.
//
// Until migration 042 is applied the extra columns don't exist: the first
// insert fails with 42703 and every send falls back to the old log-only row.
export const MAX_ATTEMPTS = 5;
// Gap before attempt n+1 after attempt n failed: 5 min, 30 min, 2 h, 6 h.
export const RETRY_GAPS_MS = [5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3];
export const retryGapAfter = (attempts) => RETRY_GAPS_MS[Math.min(Math.max(attempts, 1), RETRY_GAPS_MS.length) - 1];
// A row still 'pending' this long after its last attempt was left by a restart.
export const STALE_PENDING_MS = 10 * 60e3;

let outboxReady = true;   // flips false for the process once 042 is found missing
async function outboxStart(db, { to, subject, kind, html, text }) {
  if (!outboxReady) return null;
  try {
    const r = await db.query(
      `INSERT INTO email_log (recipient, subject, kind, status, html, text_body, attempts, updated_at)
       VALUES ($1,$2,$3,'pending',$4,$5,1,now()) RETURNING id`,
      [to, subject, kind, html || null, text || null]
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    if (e.code === "42703") {
      outboxReady = false;
      console.warn("[email] migration 042 not applied — emails are sent once and not retried until it is.");
    }
    return null;
  }
}

async function outboxFinish(db, id, attempts, { ok, error }) {
  try {
    await db.query(
      ok
        ? `UPDATE email_log SET status='sent', error=NULL, next_attempt_at=NULL, updated_at=now() WHERE id=$1`
        : `UPDATE email_log SET status='failed', error=$2, updated_at=now(),
             next_attempt_at = CASE WHEN $3::int >= $4::int THEN NULL ELSE now() + ($5::bigint * interval '1 millisecond') END
           WHERE id=$1`,
      ok ? [id] : [id, String(error || "").slice(0, 500), attempts, MAX_ATTEMPTS, retryGapAfter(attempts)]
    );
  } catch (e) {
    console.error("email_log update failed:", e.message);
  }
}

async function outboxAbort(db, id, e) {
  try {
    await db.query(`UPDATE email_log SET status='aborted', error=$2, next_attempt_at=NULL, updated_at=now() WHERE id=$1`,
      [id, `programmer error: ${String(e?.message || e).slice(0, 400)}`]);
  } catch (err) {
    console.error("email_log update failed:", err.message);
  }
}

// One call to Resend. Operational failures come back as { ok: false, error };
// a programmer error is rethrown (see sendEmail).
async function deliver({ to, subject, html, text }, idempotencyKey, fetchImpl = fetch) {
  try {
    const headers = { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST", headers,
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text, reply_to: REPLY_TO }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: body.slice(0, 500), rejected: true };
    }
    return { ok: true };
  } catch (e) {
    rethrowIfProgrammerError(e);
    return { ok: false, error: e.message };
  }
}

// Core send. Returns { ok, mode }. Never throws — email must not break bookings.
export async function sendEmail({ to, subject, html, text, kind = "generic" }) {
  if (!to) return { ok: false, mode: emailMode };
  if (emailMode === "log") {
    console.log(`\n[email:log] to=${to} | ${subject}\n${text || "(html only)"}\n`);
    await recordEmail({ to, subject, kind, status: "logged" });
    return { ok: true, mode: "log" };
  }
  // AAA2 / AAA1.2 — this function's contract is "never throws on an
  // OPERATIONAL failure", which is what its thirteen callers defend against.
  // It says nothing about a programmer error, and silently returning
  // { ok: false } for one would make a broken template look like a mail
  // outage. deliver() rethrows those. Asserted in server/email-contract.test.js.
  const id = await outboxStart(pool, { to, subject, kind, html, text });
  let r;
  try {
    r = await deliver({ to, subject, html, text }, id ? `sawa-email-${id}` : undefined);
  } catch (e) {
    // A programmer error: not a delivery failure, and not something a retry
    // can fix. The queued row is set aside ('aborted') so the job leaves it,
    // and nothing is counted as failed.
    if (id) await outboxAbort(pool, id, e);
    throw e;
  }
  if (id) await outboxFinish(pool, id, 1, r);
  else await recordEmail({ to, subject, kind, status: r.ok ? "sent" : "failed", error: r.error });
  if (!r.ok) {
    recordFailure("email", r.rejected ? `Resend rejected: ${String(r.error).slice(0, 200)}` : r.error);
    return { ok: false, mode: "live" };
  }
  // ZZ2.1 — `email: live` says a key is configured. This says a message has
  // actually left the building, which is the question that mattered when the
  // mirror turned out never to have transmitted.
  recordSuccess("email");
  return { ok: true, mode: "live" };
}

// The scheduled half of the outbox. Claims up to `limit` rows that are due —
// failed with attempts left, or pending and abandoned by a restart — and sends
// each again under its original idempotency key. FOR UPDATE SKIP LOCKED means
// two instances never take the same row.
export async function retryPendingEmails({ db = pool, fetchImpl = fetch, limit = 20, log = () => {} } = {}) {
  if (emailMode !== "live") return { skipped: "log mode" };
  let rows;
  try {
    rows = (await db.query(
      `UPDATE email_log e SET status='pending', attempts = e.attempts + 1, updated_at = now()
        WHERE e.id IN (
          SELECT id FROM email_log
           WHERE attempts < $1
             AND (html IS NOT NULL OR text_body IS NOT NULL)
             AND ((status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
               OR (status = 'pending' AND updated_at < now() - ($2::bigint * interval '1 millisecond')))
           ORDER BY id
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING e.id, e.recipient, e.subject, e.html, e.text_body, e.attempts`,
      [MAX_ATTEMPTS, STALE_PENDING_MS, limit])).rows;
  } catch (e) {
    if (e.code === "42703") return { skipped: "migration 042 not applied" };
    throw e;
  }
  let sent = 0, failed = 0;
  for (const row of rows) {
    let r;
    try {
      r = await deliver({ to: row.recipient, subject: row.subject, html: row.html, text: row.text_body }, `sawa-email-${row.id}`, fetchImpl);
    } catch (e) {
      await outboxAbort(db, row.id, e);
      throw e;
    }
    await outboxFinish(db, row.id, row.attempts, r);
    if (r.ok) { sent++; recordSuccess("email"); } else { failed++; recordFailure("email", `retry #${row.attempts}: ${String(r.error).slice(0, 200)}`); }
    log(`email ${row.id} attempt ${row.attempts}: ${r.ok ? "sent" : "failed"}`);
  }
  return { claimed: rows.length, sent, failed };
}

// AAA1.2 — the thirteen call sites, in one place.
//
// Every one of them was `sendEmail(...).catch(() => {})`. The intent behind that
// was right: a booking must not fail because a receipt did not send. The
// expression was not — it defends against a throw whose existence nobody had
// established, and it would have discarded one silently if it happened.
//
// The contract is stated where it belongs, next to the function it describes:
//
//   OPERATIONAL failure   already handled INSIDE sendEmail. It records the
//                         failure, writes an email_log row, and returns
//                         { ok: false }. It does not throw, so there was never
//                         anything for a caller's handler to catch.
//
//   PROGRAMMER error      escapes sendEmail deliberately (see its catch), and
//                         escapes this too. A broken template is not a mail
//                         outage and must not be reported as one.
//
// Callers that want the result — the direct traveller receipt — still await
// sendEmail. This is for the ones that genuinely must not block the response.
// CCC2.2 — "surface", not "crash". Every caller is a request handler, and by
// the time this rejects the response has already gone out: the booking is
// committed and the traveller has been told it succeeded. Killing the process
// then protects no state, and it would stop the site serving pages that have
// nothing to do with email. A broken template is recorded, counted under
// `programmerErrors`, and reported by `codeIsWrong` in /api/modes.
//
// `message` may also be a promise of one, for a message that needs a lookup
// first (the operator's name, U01): the lookup then runs after the response
// too, and a bug in it is surfaced the same way as a broken template.
export function sendEmailInBackground(message) {
  return fireAndForget("email", Promise.resolve(message).then(sendEmail), { onProgrammerError: "surface" });
}

// ---- Templates -------------------------------------------------------------

// Every value interpolated below is user-supplied somewhere: `route` comes from
// an agency-submitted tour title, `reason` from an admin's free text, names and
// codes from the booking form. Tour titles never pass through sanitize.js (only
// the rich-text bodies do), so they are the one path that could otherwise carry
// markup into a recipient's inbox. Escape at the seam.
const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---- Brand ------------------------------------------------------------------
//
// The same palette the site is built from (see the :root block in
// site/index.html). The old shell used #1f5f7a — a blue that appears nowhere on
// the site — so every email a customer received looked like it came from a
// different company than the one they had just booked with.
const C = {
  teal: "#17323A",
  teal700: "#21454f",
  gold: "#F4C95D",
  goldDeep: "#d9ab45",
  goldInk: "#9a7a26",
  cream: "#F7F3EA",
  paper: "#fbf8f1",
  paper2: "#f1ebdc",
  ink: "#15282e",
  muted: "#5e6f72",
  line: "#e6ded0",
  // Restrained red for the one template that has to deliver bad news.
  alert: "#8c2f27",
  alertBg: "#f9ece9",
  alertLine: "#e0bdb6",
};

// Fraunces and Plus Jakarta Sans are webfonts — Gmail and Outlook strip @font-face,
// so an email that depends on them silently falls back to Times/Arial and loses
// the editorial feel entirely. These stacks pick the closest thing already on the
// machine: a real serif for headings, the system UI face for body copy.
const SERIF = "Georgia,'Iowan Old Style','Times New Roman',serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// ---- Email primitives -------------------------------------------------------
//
// Everything below is table-based with inline styles. Outlook renders through
// Word, which ignores max-width, flexbox and most positioning, so a div-based
// layout collapses to full-bleed there. Tables are the boring thing that works
// in every client.

// Hidden preview line — the grey text the inbox shows next to the subject. With
// no preheader, clients scrape the first visible text instead, which is why the
// old emails previewed as "Sawa Tours Departure request received We've...".
const preheaderBlock = (text) => `
  <div style="display:none;font-size:1px;color:${C.paper};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">
    ${esc(text)}
    ${"&#847;&zwnj;&nbsp;".repeat(60)}
  </div>`;

// Key/value data box — booking codes, seats, amounts.
export const panel = (rows, { tone = "default" } = {}) => {
  const bg = tone === "alert" ? C.alertBg : C.paper2;
  const border = tone === "alert" ? C.alertLine : "#e8dfcb";
  const color = tone === "alert" ? C.alert : C.ink;
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px">
    <tr>
      <td style="background:${bg};border:1px solid ${border};border-radius:12px;padding:18px 20px;
                 font-family:${SANS};font-size:15px;line-height:1.7;color:${color}">
        ${rows}
      </td>
    </tr>
  </table>`;
};

// One "Label: value" line inside a panel.
export const row = (label, value) =>
  `<span style="color:${C.muted}">${esc(label)}</span> <strong style="color:${C.ink}">${value}</strong>`;

// Bulletproof-ish button. A padded <a> collapses in Outlook; a table cell with a
// bgcolor does not. The radius degrades to square corners there, which is fine.
const button = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px">
    <tr>
      <td align="center" bgcolor="${C.gold}" style="border-radius:999px">
        <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;
           font-weight:700;color:${C.teal};text-decoration:none;border-radius:999px">${esc(label)}</a>
      </td>
    </tr>
  </table>`;

// The cancellation schedule, as a real table.
//
// Terms §13.2 binds the default schedule only where it was "repeated in the
// booking confirmation", so this is disclosure and not decoration — it is
// rendered as a <table> rather than prose so it survives a client that strips
// styling, and every value comes from shared/booking-policy.js.
//
// Borders are on the cells rather than the table: Outlook ignores
// border-collapse and doubles them otherwise.
const cancellationTable = (item) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.55">
    <tr>
      <td style="padding:0 10px 6px 0;color:${C.muted};font-weight:700">${esc(CANCELLATION_COLUMNS.when)}</td>
      <td style="padding:0 0 6px;color:${C.muted};font-weight:700">${esc(CANCELLATION_COLUMNS.charge)}</td>
    </tr>
    ${cancellationBandsFor(item).map((b) => `
    <tr>
      <td style="padding:6px 10px 6px 0;border-top:1px solid ${C.line};color:${C.ink}">${esc(b.when)}</td>
      <td style="padding:6px 0;border-top:1px solid ${C.line};color:${C.ink}">${esc(chargeText(b, depositPctFor(item)))}</td>
    </tr>`).join("")}
  </table>`;

// Small print under the main message.
const note = (html) =>
  `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.65;color:${C.muted}">${html}</p>`;

// The wordmark, built from type rather than an image. The logo is an inline SVG
// on the site, and Gmail strips SVG outright; a hosted PNG would be blocked by
// the default "don't load remote images" setting in most clients, leaving a
// broken-image box as the first thing in the email. Type always renders. The
// gold square is the GoAhead dot — round everywhere except Outlook.
const wordmark = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="font-family:${SERIF};font-size:26px;font-weight:700;color:${C.cream};letter-spacing:-0.01em;padding-right:9px">
        Sawa
      </td>
      <td style="padding-bottom:9px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td width="9" height="9" bgcolor="${C.gold}" style="border-radius:9px;font-size:0;line-height:0">&nbsp;</td></tr>
        </table>
      </td>
    </tr>
    <tr>
      <td colspan="2" style="font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.32em;
                             text-transform:uppercase;color:${C.gold};padding-top:2px">
        Tours &middot; Egypt
      </td>
    </tr>
  </table>`;

/**
 * The one wrapper every template renders through.
 *
 * @param title     the <h1>
 * @param body      pre-escaped HTML
 * @param preheader inbox preview line; falls back to the title
 * @param eyebrow   small caps line above the title (e.g. "GoAhead confirmed")
 */
const shell = (title, body, { preheader = "", eyebrow = "" } = {}) => `<!DOCTYPE html>
<html lang="en" style="margin:0;padding:0">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="x-apple-disable-message-reformatting"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
${/* `title` arrives as HTML (escaped values plus entities like &mdash;), so it is
     used as-is here. Running esc() over it again printed "&amp;mdash;". */ ""}
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${C.cream};-webkit-font-smoothing:antialiased">
${preheaderBlock(preheader || title)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.cream}">
  <tr>
    <td align="center" style="padding:28px 14px 40px">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
             style="width:100%;max-width:600px;border-collapse:separate">

        <!-- Header band: the site's dark editorial band, teal with gold accents -->
        <tr>
          <td style="background:${C.teal};border-radius:18px 18px 0 0;padding:30px 34px 26px">
            ${wordmark}
          </td>
        </tr>

        <!-- Body card -->
        <tr>
          <td style="background:${C.paper};border:1px solid ${C.line};border-top:0;
                     border-radius:0 0 18px 18px;padding:34px 34px 30px">
            ${eyebrow ? `<p style="margin:0 0 12px;font-family:${SANS};font-size:11px;font-weight:700;
                 letter-spacing:0.2em;text-transform:uppercase;color:${C.goldInk}">${esc(eyebrow)}</p>` : ""}
            <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:27px;line-height:1.2;
                       font-weight:600;color:${C.teal};letter-spacing:-0.015em">${title}</h1>
            <div style="font-family:${SANS};font-size:16px;line-height:1.7;color:${C.ink}">
              ${body}
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 34px 0">
            <p style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:1.7;color:${C.muted}">
              Questions? Reply to this email or write to
              <a href="mailto:${BRAND.email}" style="color:${C.goldInk};text-decoration:underline">${BRAND.email}</a>.
            </p>
            <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.65;color:#8a9294">
              Shared departures, confirmed together.<br/>
              Online Era, trading as Sawa Tours &middot; Giza, Egypt
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

export function inviteEmail({ to, fullName, agencyName, tempPassword, role }) {
  const subject = `You've been added to ${agencyName} on Sawa Tours`;
  const roleText = role === "agency_owner" ? "agency owner" : "agent";
  const text =
    `Hi ${fullName || ""},\n\nYou've been given a ${roleText} login for ${agencyName} on Sawa Tours.\n\n` +
    `Sign in at ${APP_URL}/agency\nEmail: ${to}\nTemporary password: ${tempPassword}\n\n` +
    `Please change your password after your first sign-in.`;
  const html = shell(
    `Welcome to ${esc(agencyName)}`,
    `<p style="margin:0 0 20px">You've been given a <strong>${roleText}</strong> login on Sawa Tours.</p>
     ${panel(
       `${row("Email:", esc(to))}<br/>
        ${row("Temporary password:", `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:0.04em">${esc(tempPassword)}</code>`)}`
     )}
     ${button(`${APP_URL}/agency`, "Sign in")}
     ${note("Please change your password after your first sign-in.")}`,
    { eyebrow: "Your account", preheader: `Sign in to ${agencyName} on Sawa Tours` }
  );
  return { to, subject, html, text, kind: "invite" };
}

// `product` carries the type, and nothing else is read off it. Without it this
// mail could only print one schedule, and would have printed the day-tour one
// to everyone who booked a package.
export function bookingConfirmationEmail({ to, customerName, route, dateLabel, seats, depositDue, balanceDue, balanceDueDate, bookingCode, product = null, operator = null }) {
  const subject = `Booking received — ${route}`;
  // The one durable handle on this booking. Before this link existed, the only
  // way to release a seat was a button held in React state on the page the
  // traveller booked from — gone on the first refresh, so in practice there was
  // no way to cancel at all after closing the tab. The code is what /booking
  // already looks bookings up by, so one link answers "where is my date?" and
  // "let me out" both.
  const manageUrl = bookingCode ? `${APP_URL}/booking/${encodeURIComponent(bookingCode)}` : null;
  // U01 — the partner running this date so far. Until GoAhead it is whichever
  // partner has the most travellers on it, so it can still change.
  const operatorName = operator?.name ? String(operator.name) : "";
  const operatorNote = "Until GoAhead, the date is run by the partner with the most travellers on it, so this can change.";
  const text =
    `Hi ${customerName || ""},\n\nWe've recorded your booking for ${route} on ${dateLabel}.\n` +
    `Seats: ${seats}\n${bookingCode ? `Booking code: ${bookingCode}\n` : ""}` +
    (operatorName ? `Run by: ${operatorName}${operator.verified ? " (verified operator)" : ""}\n${operatorNote}\n` : "") +
    `Deposit at GoAhead: ${CURRENCY_SYMBOL}${depositDue} ${CURRENCY}\nBalance: ${CURRENCY_SYMBOL}${balanceDue} ${CURRENCY} (due ${balanceDueDate})\n\n` +
    `Nothing has been charged. Your seat is held free — the deposit only falls due once this ` +
    `date reaches its minimum travellers (GoAhead), and we'll email you when that happens.` +
    (manageUrl
      ? `\n\nCheck your date or cancel your seat, free, any time before GoAhead:\n${manageUrl}`
      : "") +
    // Terms §13.2 — the default schedule applies only where it was "repeated in
    // the booking confirmation". This is that repetition, so it goes in the
    // plain-text part too rather than only the HTML: a client showing text-only
    // must not be a client that was never told.
    `\n\nCancellation\n${CANCELLATION_BEFORE_GOAHEAD}\n${CANCELLATION_CAP}\n\nAfter GoAhead (${CANCELLATION_COLUMNS.when} — ${CANCELLATION_COLUMNS.charge}):\n` +
    cancellationBandsFor(product).map((b) => `  ${b.when} — ${chargeText(b, depositPctFor(product))}`).join("\n") +
    `\n${CANCELLATION_QUALIFIER} Full terms: ${APP_URL}/terms`;
  const html = shell(
    "Booking received",
    `<p style="margin:0 0 20px">We've recorded your booking for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     ${panel(
       `${row("Seats:", esc(seats))}<br/>
        ${bookingCode ? `${row("Booking code:", esc(bookingCode))}<br/>` : ""}
        ${operatorName ? `${row("Run by:", `${esc(operatorName)}${operator.verified ? " ✓" : ""}`)}<br/>` : ""}
        ${row("Deposit at GoAhead:", `${CURRENCY_SYMBOL}${esc(depositDue)} ${CURRENCY}`)}<br/>
        ${row("Balance:", `${CURRENCY_SYMBOL}${esc(balanceDue)} ${CURRENCY}`)} <span style="color:${C.muted}">(due ${esc(balanceDueDate)})</span>`
     )}
     ${operatorName ? note(esc(operatorNote)) : ""}
     ${note(`<strong style="color:${C.ink}">Nothing has been charged.</strong> Your seat is held free — the deposit only falls due once this date reaches its minimum travellers, and we'll email you when it's GoAhead.`)}
     ${manageUrl ? `${button(manageUrl, "Check or cancel your booking")}` : ""}
     <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:700;color:${C.ink}">Cancellation</p>
     ${note(esc(CANCELLATION_BEFORE_GOAHEAD))}
     ${note(`<strong style="color:${C.ink}">${esc(CANCELLATION_CAP)}</strong>`)}
     ${note("If you cancel <strong>after</strong> GoAhead:")}
     ${cancellationTable(product)}
     ${note(`${esc(CANCELLATION_QUALIFIER)} <a href="${APP_URL}/terms" style="color:${C.muted}">Full terms</a>.`)}`,
    { eyebrow: "Seat held", preheader: `Your seat on ${route} is held — nothing charged yet` }
  );
  return { to, subject, html, text, kind: "booking_confirmation" };
}

export function departureRequestReceivedEmail({ to, customerName, route, dateLabel, seats, bookingCode }) {
  const subject = `Request received — ${route} on ${dateLabel}`;
  const text =
    `Hi ${customerName || ""},\n\nWe've received your request to start a shared departure for ${route} on ${dateLabel}.\n` +
    `Seats: ${seats}\n${bookingCode ? `Booking code: ${bookingCode}\n` : ""}\n` +
    `Our team reviews every requested date — you'll hear from us shortly. Nothing is charged at this stage.`;
  const html = shell(
    "Departure request received",
    `<p style="margin:0 0 20px">We've received your request to start a shared departure for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     ${panel(
       `${row("Seats:", esc(seats))}${bookingCode ? `<br/>${row("Booking code:", esc(bookingCode))}` : ""}`
     )}
     ${note("Our team reviews every requested date — you'll hear from us shortly. Nothing is charged at this stage.")}`,
    { eyebrow: "Under review", preheader: `We're reviewing your date for ${route} — nothing charged` }
  );
  return { to, subject, html, text, kind: "departure_request_received" };
}

export function departureRequestApprovedEmail({ to, customerName, route, dateLabel, bookingCode }) {
  const subject = `Your date is live — ${route} on ${dateLabel}`;
  const text =
    `Hi ${customerName || ""},\n\nGood news — your requested departure for ${route} on ${dateLabel} is approved and now open for other travellers to join.\n` +
    `${bookingCode ? `Booking code: ${bookingCode}\n` : ""}` +
    `It's confirmed to run (GoAhead) once it reaches its minimum travellers — share the date to fill it faster.`;
  const html = shell(
    "Your requested date is live",
    `<p style="margin:0 0 20px">Good news — your requested departure for <strong>${esc(route)}</strong> on ${esc(dateLabel)} is <strong>approved</strong> and now open for other travellers to join.</p>
     ${bookingCode ? panel(row("Booking code:", esc(bookingCode))) : ""}
     ${button(`${APP_URL}/departures`, "See your departure")}
     ${note("It's confirmed to run (GoAhead) once it reaches its minimum travellers — share the date to fill it faster.")}`,
    { eyebrow: "Date approved", preheader: `${route} on ${dateLabel} is open for travellers to join` }
  );
  return { to, subject, html, text, kind: "departure_request_approved" };
}

export function departureRequestDeclinedEmail({ to, customerName, route, dateLabel, reason }) {
  const subject = `About your requested date — ${route}`;
  const text =
    `Hi ${customerName || ""},\n\nWe couldn't open your requested departure for ${route} on ${dateLabel}.` +
    `${reason ? `\nReason: ${reason}` : ""}\n\nNothing was charged. Browse other departures at ${APP_URL}/departures — nearby dates for the same tour often need just a few more travellers.`;
  const html = shell(
    "We couldn't open this date",
    `<p style="margin:0 0 20px">We couldn't open your requested departure for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     ${reason ? panel(`<strong style="color:${C.alert}">Why</strong><br/>${esc(reason).replace(/\n/g, "<br/>")}`, { tone: "alert" }) : ""}
     <p style="margin:0 0 4px">Nearby dates for the same tour often need just a few more travellers.</p>
     ${button(`${APP_URL}/departures`, "Browse open departures")}
     ${note("<strong>Nothing was charged.</strong> No seat was held and no payment was taken at any point.")}`,
    { eyebrow: "Date not opened", preheader: `We couldn't open ${dateLabel} — nothing was charged` }
  );
  return { to, subject, html, text, kind: "departure_request_declined" };
}

// TTT3 — where the watcher's alert goes.
//
// "Fails" and "alerts" both need a destination, and stderr inside the production
// process is not one. Nobody reads it — the same problem as an audit trail
// nobody can query, in a place whose entire point is that a human learns
// something.
//
// TTT3.3 — this is only ever sent on DRIFT or STALENESS. A daily mail saying
// nothing changed trains the recipient to filter it, and then the one that
// matters is filtered too.
// DIR-20.2 — everything needed to create a payment link without opening
// anything else. Internal: this goes to ops, never to a traveller.
export function goAheadPaymentLinkEmail({ to, payload }) {
  const p = payload;
  const money = (n) => (n == null ? "—" : `${CURRENCY_SYMBOL}${Number(n).toLocaleString()}`);
  const rows = p.travellers.map((t) =>
    `  ${t.name || "(no name recorded)"} — ${t.seats} seat(s) — ${t.contact || "(no contact)"}\n`
    + `      booking ${t.bookingCode || "—"} · total ${money(t.total)} · deposit due ${money(t.depositDue)}`
    + `${t.balanceDue != null ? ` · balance ${money(t.balanceDue)}${t.balanceDueDate ? ` by ${t.balanceDueDate}` : ""}` : ""}`
  ).join("\n");

  const subject = `GoAhead — payment link needed: ${p.route} on ${p.date}`;
  const text =
    `${p.route}\n${p.date}\n\n`
    + `Confirmed with ${p.seatsConfirmed} of ${p.minSeats ?? "?"} seats.\n`
    + `Operator: ${p.operator || "NOT RECORDED"}${p.operatorContact ? ` (${p.operatorContact})` : ""}\n\n`
    + `Travellers:\n${rows}\n\n`
    + `Total deposits due: ${money(p.depositTotal)}\n`
    + (p.portalLink ? `\nDeparture: ${p.portalLink}\n` : "")
    // Never silently. A missing operator or an uncaptured total changes what
    // the person reading this has to do next.
    + (p.unknowns.length ? `\n⚠️ ${p.unknowns.join("\n⚠️ ")}\n` : "")
    + `\nThis departure stays in the payment-link queue until a link is recorded against it. `
    + `This email is the prompt, not the record — if it is lost, the queue still has it.`;

  return { to, subject, text, html: `<pre style="font:14px/1.5 ui-monospace,monospace">${
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`, kind: "goahead_payment_link" };
}

// Who at Sawa hears about new demand. Until 24 Sep 2026 nobody did: a date
// request or a direct booking emailed the traveller only, and the one
// "request received" the team ever saw was a test made with their own address.
// Same recipient as the GoAhead payment-link alert, so ops has one inbox.
export function opsRecipient(env = process.env) {
  return env.OPS_NOTIFY_TO || env.GOAHEAD_ALERT_TO || REPLY_TO;
}

// Internal: to ops, never to a traveller. Everything needed to act without
// opening anything else, and a link to where the decision is made.
export function opsNewBookingEmail({ to, isRequest, route, dateLabel, seats, seatsNow, minSeats,
  customerName, customerEmail, customerPhone, bookingCode, note, portalLink, bookedBy }) {
  const what = isRequest
    ? (bookedBy ? `New date request from ${bookedBy}` : "New date request")
    : bookedBy ? `New booking by ${bookedBy}` : "New booking";
  const subject = `${what} — ${route} on ${dateLabel} (${seats} seat${seats === 1 ? "" : "s"})`;
  const text =
    `${what}\n\n${route}\n${dateLabel}\n\n`
    + (bookedBy ? `Booked by: ${bookedBy} (operator dashboard)\n` : "")
    + `Traveller: ${customerName || "(no name)"}\n`
    + `Email: ${customerEmail || "(none)"}\n`
    + `Phone: ${customerPhone || "(none)"}\n`
    + `Seats: ${seats}${bookingCode ? ` · booking ${bookingCode}` : ""}\n`
    + (note ? `Note: ${note}\n` : "")
    + (isRequest
      ? `\nThis date is not open yet. Approve or decline it under Date requests — ${bookedBy ? "the operator sees it as under review" : "the traveller has been told it is under review"}.\n`
      : `\nSeats on this date now: ${seatsNow ?? "?"} of ${minSeats ?? "?"} needed for GoAhead.\n`)
    + (portalLink ? `\n${portalLink}\n` : "");
  return { to, subject, text, html: `<pre style="font:14px/1.5 ui-monospace,monospace">${
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`, kind: isRequest ? "ops_new_request" : "ops_new_booking" };
}

// An operator submitted (or resubmitted) a tour for review. "Nothing goes live
// until you approve it" was true — and nobody was told there was anything to
// approve.
export function opsNewListingEmail({ to, title, agencyName, isEdit, portalLink }) {
  const subject = `${isEdit ? "Tour listing updated" : "New tour listing"} to review — ${title}`;
  const text =
    `${isEdit ? "An operator updated a tour listing" : "An operator submitted a new tour listing"}.\n\n`
    + `${title}\nOperator: ${agencyName || "(unknown)"}\n\n`
    + `It is not live until you approve it under Listing requests.\n`
    + (portalLink ? `\n${portalLink}\n` : "");
  return { to, subject, text, html: `<pre style="font:14px/1.5 ui-monospace,monospace">${
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`, kind: "ops_new_listing" };
}

export function auditDriftEmail({ to, base, lines = [], stale }) {
  const subject = stale
    ? `Sawa: the claims watcher has not run for ${stale}`
    : `Sawa: the claims audit changed on ${base}`;
  const body = stale
    ? `The scheduled claims audit has not completed successfully for ${stale}. `
      + `No alert is not the same as no drift — this message exists because the watcher's silence would otherwise look like success.`
    : `The claims audit against ${base} differs from the committed baseline:`;
  const text = `${body}\n\n${lines.join("\n")}\n\nBaseline: docs/audit/claims-baseline.json\nRe-run: npm run audit:watch -- --base=${base}`;
  const html = shell(
    stale ? "The claims watcher has gone quiet" : "The claims audit changed",
    `<p style="margin:0 0 18px">${esc(body)}</p>
     <ul style="margin:0 0 20px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 6px">${esc(l)}</li>`).join("")}</ul>
     <p style="margin:0 0 6px;font-size:14px;color:#6b6257">Baseline: <code>docs/audit/claims-baseline.json</code></p>
     <p style="margin:0;font-size:14px;color:#6b6257">Re-run: <code>npm run audit:watch -- --base=${esc(base)}</code></p>`
  );
  return { to, subject, html, text, kind: "audit_drift" };
}

export function goAheadEmail({ to, route, dateLabel, operator = null }) {
  const subject = `Confirmed: ${route} is running`;
  // U01 — the operator is fixed at GoAhead, so this email can name it.
  const operatorName = operator?.name ? String(operator.name) : "";
  const handover = operatorName
    ? `${operatorName}${operator.verified ? " (verified operator)" : ""} runs this date and has been notified; they are confirming the guide and vehicle.`
    : "Your operator has been notified and is confirming the guide and vehicle.";
  const text = `Good news — ${route} on ${dateLabel} has reached its minimum travellers and is confirmed to run (GoAhead).\n\n${handover} We'll be in touch with your joining details and anything still outstanding on payment.`;
  // The GoAhead is the whole promise the brand is built on, so this is the one
  // email that gets the gold treatment rather than the standard paper panel.
  const html = shell(
    "Your tour is confirmed",
    `<p style="margin:0 0 20px"><strong>${esc(route)}</strong> on ${esc(dateLabel)} has reached its minimum travellers.</p>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px">
       <tr>
         <td style="background:${C.teal};border-radius:14px;padding:22px 24px;text-align:center">
           <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
             <tr>
               <td width="10" height="10" bgcolor="${C.gold}" style="border-radius:10px;font-size:0;line-height:0">&nbsp;</td>
               <td style="padding-left:10px;font-family:${SANS};font-size:12px;font-weight:700;
                          letter-spacing:0.18em;text-transform:uppercase;color:${C.gold}">GoAhead</td>
             </tr>
           </table>
           <p style="margin:12px 0 0;font-family:${SERIF};font-size:21px;font-weight:600;color:${C.cream}">
             Confirmed &mdash; your trip is running.
           </p>
         </td>
       </tr>
     </table>
     ${note(`${esc(handover)} We'll be in touch with your joining details and anything still outstanding on payment.`)}`,
    { eyebrow: "GoAhead confirmed", preheader: `${route} on ${dateLabel} is confirmed to run` }
  );
  return { to, subject, html, text, kind: "goahead" };
}

export function listingApprovedEmail({ to, fullName, title }) {
  const subject = `Approved: "${title}" is now live on Sawa`;
  const text =
    `Hi ${fullName || ""},\n\nGood news — your tour listing "${title}" has been reviewed and approved. ` +
    `It's now live on Sawa and open for travellers to book.\n\nManage it any time at ${APP_URL}/agency`;
  const html = shell(
    "Your listing is approved",
    `<p style="margin:0 0 20px">Good news — your tour listing <strong>&ldquo;${esc(title)}&rdquo;</strong> has been reviewed and <strong>approved</strong>. It's now live on Sawa and open for bookings.</p>
     ${button(`${APP_URL}/agency`, "Open your dashboard")}`,
    { eyebrow: "Listing approved", preheader: `"${title}" is live and open for bookings` }
  );
  return { to, subject, html, text, kind: "listing_approved" };
}

export function listingRejectedEmail({ to, fullName, title, reason }) {
  const subject = `Update on your listing "${title}"`;
  const text =
    `Hi ${fullName || ""},\n\nThanks for submitting "${title}". We couldn't approve it as-is.\n\n` +
    `Reason:\n${reason || "No reason provided."}\n\n` +
    `You can edit the listing and resubmit it for review at ${APP_URL}/agency`;
  const html = shell(
    "Your listing needs a change",
    `<p style="margin:0 0 20px">Thanks for submitting <strong>&ldquo;${esc(title)}&rdquo;</strong>. We couldn't approve it as it stands.</p>
     ${panel(
       `<strong style="color:${C.alert}">What needs changing</strong><br/>${esc(reason || "No reason provided.").replace(/\n/g, "<br/>")}`,
       { tone: "alert" }
     )}
     <p style="margin:0 0 4px">Edit the listing and resubmit it for review whenever you're ready.</p>
     ${/* button() escapes its label — an entity here would render literally. */ ""}
     ${button(`${APP_URL}/agency`, "Edit & resubmit")}`,
    { eyebrow: "Action needed", preheader: `"${title}" needs a change before it can go live` }
  );
  return { to, subject, html, text, kind: "listing_rejected" };
}

// ---- Operator verification applications (site/verify.html) -----------------
//
// The application used to be handed to the visitor's own mail client via a
// mailto: link, which meant an operator on a machine with no mail app
// configured filled the whole form in — licence number included — and watched
// it evaporate. It now posts over HTTPS and produces two emails: one to the
// team, and a copy back to the applicant so they hold a record of what they
// sent.

// The plain-text body is shared by both emails and is also what the form offers
// as a downloadable copy, so an applicant always ends up with the same document.
export function operatorApplicationText(app) {
  return [
    `Company: ${app.company}`,
    `Contact: ${app.contactName}`,
    `City / base: ${app.city}`,
    `Email: ${app.email}`,
    `WhatsApp / phone: ${app.phone || "—"}`,
    `Tourism licence: ${app.licence}`,
    `Regions: ${app.regions || "—"}`,
    "",
    "About their tours:",
    app.about || "—",
  ].join("\n");
}

const applicationRows = (app) => `
  ${panel(
    `${row("Company:", esc(app.company))}<br/>
     ${row("Contact:", esc(app.contactName))}<br/>
     ${row("City / base:", esc(app.city))}<br/>
     ${row("Email:", esc(app.email))}<br/>
     ${row("WhatsApp / phone:", esc(app.phone || "—"))}<br/>
     ${row("Tourism licence:", esc(app.licence))}<br/>
     ${row("Regions:", esc(app.regions || "—"))}`
  )}
  <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:${C.ink}">About their tours</p>
  <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:${C.muted}">${esc(app.about || "—").replace(/\n/g, "<br/>")}</p>`;

export function operatorApplicationEmail({ to, reference, ...app }) {
  const subject = `Operator application — ${app.company} (${reference})`;
  const text = `New operator application (${reference})\n\n${operatorApplicationText(app)}`;
  const html = shell(
    `Operator application &mdash; ${esc(app.company)}`,
    applicationRows(app),
    { eyebrow: `Reference ${esc(reference)}`, preheader: `${app.company} (${app.city}) applied to list on Sawa` }
  );
  return { to, subject, html, text, kind: "operator_application" };
}

export function operatorApplicationReceiptEmail({ to, reference, ...app }) {
  const subject = `We've got your Sawa operator application (${reference})`;
  const text =
    `Hi ${app.contactName || ""},\n\nThanks — we've received your application to list on Sawa Tours. ` +
    `Your reference is ${reference}. We verify licences with the Ministry of Tourism & Antiquities and ` +
    `usually come back within 2–4 business days.\n\nHere's what you sent us:\n\n${operatorApplicationText(app)}\n\n` +
    `If anything is wrong, just reply to this email.`;
  const html = shell(
    "Application received",
    `<p style="margin:0 0 20px">Thanks — we've received your application to list on Sawa Tours. We verify licences with the Ministry of Tourism &amp; Antiquities and usually come back within <strong>2&ndash;4 business days</strong>.</p>
     <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:${C.ink}">Here's what you sent us</p>
     ${applicationRows(app)}
     ${note("If anything is wrong, just reply to this email and we'll correct it.")}`,
    { eyebrow: `Reference ${esc(reference)}`, preheader: `Application ${reference} received — we reply within 2–4 business days` }
  );
  return { to, subject, html, text, kind: "operator_application_receipt" };
}

export function cancellationEmail({ to, route, dateLabel }) {
  const subject = `Cancellation — ${route}`;
  const text = `This confirms your booking for ${route} on ${dateLabel} has been cancelled.`;
  const html = shell(
    "Booking cancelled",
    `<p style="margin:0 0 20px">This confirms your booking for <strong>${esc(route)}</strong> on ${esc(dateLabel)} has been cancelled.</p>
     ${button(`${APP_URL}/departures`, "Find another departure")}
     ${note("If you were charged anything for this booking, it is refunded in full. If this cancellation wasn't expected, reply to this email and we'll look into it.")}`,
    { eyebrow: "Cancelled", preheader: `Your booking for ${route} on ${dateLabel} has been cancelled` }
  );
  return { to, subject, html, text, kind: "cancellation" };
}
