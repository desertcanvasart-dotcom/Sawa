// Provider-agnostic transactional email.
//
// If RESEND_API_KEY + EMAIL_FROM are set, emails are sent for real via the
// Resend HTTP API (no SDK needed). Otherwise we run in "log" mode: the email
// is recorded to the email_log table and printed to the console, and the
// caller's temp-password fallback still applies. Flipping to real delivery is
// just adding two env vars — no code change.
import "dotenv/config";
import { pool } from "./db/index.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Sawa Tours <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "http://localhost:5173";

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

// Core send. Returns { ok, mode }. Never throws — email must not break bookings.
export async function sendEmail({ to, subject, html, text, kind = "generic" }) {
  if (!to) return { ok: false, mode: emailMode };

  if (emailMode === "log") {
    console.log(`\n[email:log] to=${to} | ${subject}\n${text || "(html only)"}\n`);
    await recordEmail({ to, subject, kind, status: "logged" });
    return { ok: true, mode: "log" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      await recordEmail({ to, subject, kind, status: "failed", error: body.slice(0, 500) });
      console.error("Resend send failed:", body);
      return { ok: false, mode: "live" };
    }
    await recordEmail({ to, subject, kind, status: "sent" });
    return { ok: true, mode: "live" };
  } catch (e) {
    await recordEmail({ to, subject, kind, status: "failed", error: e.message });
    console.error("Resend send error:", e.message);
    return { ok: false, mode: "live" };
  }
}

// ---- Templates -------------------------------------------------------------

const shell = (title, body) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1b1a16">
    <div style="font-size:20px;font-weight:700;color:#1f5f7a;margin-bottom:16px">Sawa Tours</div>
    <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>
    ${body}
    <hr style="border:none;border-top:1px solid #eadfce;margin:24px 0"/>
    <p style="font-size:12px;color:#8a8478">Sawa shared tours · Cairo, Egypt</p>
  </div>`;

export function inviteEmail({ to, fullName, agencyName, tempPassword, role }) {
  const subject = `You've been added to ${agencyName} on Sawa Tours`;
  const roleText = role === "agency_owner" ? "agency owner" : "agent";
  const text =
    `Hi ${fullName || ""},\n\nYou've been given a ${roleText} login for ${agencyName} on Sawa Tours.\n\n` +
    `Sign in at ${APP_URL}/agency\nEmail: ${to}\nTemporary password: ${tempPassword}\n\n` +
    `Please change your password after your first sign-in.`;
  const html = shell(
    `Welcome to ${agencyName}`,
    `<p>You've been given a <strong>${roleText}</strong> login on Sawa Tours.</p>
     <p style="background:#f2ebdc;border-radius:10px;padding:14px">
       <strong>Email:</strong> ${to}<br/>
       <strong>Temporary password:</strong> <code style="font-size:16px">${tempPassword}</code>
     </p>
     <p><a href="${APP_URL}/agency" style="background:#1f5f7a;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;display:inline-block">Sign in</a></p>
     <p style="font-size:13px;color:#56524a">Please change your password after your first sign-in.</p>`
  );
  return { to, subject, html, text, kind: "invite" };
}

export function bookingConfirmationEmail({ to, customerName, route, dateLabel, seats, depositDue, balanceDue, balanceDueDate, bookingCode }) {
  const subject = `Booking received — ${route}`;
  const text =
    `Hi ${customerName || ""},\n\nWe've recorded your booking for ${route} on ${dateLabel}.\n` +
    `Seats: ${seats}\n${bookingCode ? `Booking code: ${bookingCode}\n` : ""}` +
    `Deposit due now: $${depositDue}\nBalance: $${balanceDue} (due ${balanceDueDate})\n\n` +
    `Your date is confirmed to run once it reaches its minimum travellers — we'll let you know.`;
  const html = shell(
    "Booking received",
    `<p>We've recorded your booking for <strong>${route}</strong> on ${dateLabel}.</p>
     <p style="background:#f2ebdc;border-radius:10px;padding:14px">
       Seats: <strong>${seats}</strong>${bookingCode ? `<br/>Booking code: <strong>${bookingCode}</strong>` : ""}<br/>
       Deposit due now: <strong>$${depositDue}</strong><br/>
       Balance: <strong>$${balanceDue}</strong> (due ${balanceDueDate})
     </p>
     <p style="font-size:13px;color:#56524a">Your date is confirmed to run once it reaches its minimum travellers — we'll email you when it's GoAhead.</p>`
  );
  return { to, subject, html, text, kind: "booking_confirmation" };
}

export function goAheadEmail({ to, route, dateLabel }) {
  const subject = `Confirmed: ${route} is running`;
  const text = `Good news — ${route} on ${dateLabel} has reached its minimum travellers and is confirmed to run (GoAhead).`;
  const html = shell(
    "Your tour is confirmed",
    `<p><strong>${route}</strong> on ${dateLabel} has reached its minimum travellers and is now <strong>GoAhead</strong> — confirmed to run.</p>`
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
    `<p>Good news — your tour listing <strong>"${title}"</strong> has been reviewed and <strong>approved</strong>. It's now live on Sawa and open for bookings.</p>
     <p><a href="${APP_URL}/agency" style="background:#1f5f7a;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;display:inline-block">Open your dashboard</a></p>`
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
    `<p>Thanks for submitting <strong>"${title}"</strong>. We couldn't approve it as-is.</p>
     <p style="background:#fbeaea;border-left:3px solid #c0553f;border-radius:8px;padding:14px;color:#7a2e1f">
       <strong>Reason for rejection</strong><br/>${(reason || "No reason provided.").replace(/\n/g, "<br/>")}
     </p>
     <p>Edit the listing and resubmit it for review whenever you're ready.</p>
     <p><a href="${APP_URL}/agency" style="background:#1f5f7a;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;display:inline-block">Edit &amp; resubmit</a></p>`
  );
  return { to, subject, html, text, kind: "listing_rejected" };
}

export function cancellationEmail({ to, route, dateLabel }) {
  const subject = `Cancellation — ${route}`;
  const text = `This confirms your booking for ${route} on ${dateLabel} has been cancelled.`;
  const html = shell("Booking cancelled", `<p>This confirms your booking for <strong>${route}</strong> on ${dateLabel} has been cancelled.</p>`);
  return { to, subject, html, text, kind: "cancellation" };
}
