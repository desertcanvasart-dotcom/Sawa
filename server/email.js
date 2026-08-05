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

// Every value interpolated below is user-supplied somewhere: `route` comes from
// an agency-submitted tour title, `reason` from an admin's free text, names and
// codes from the booking form. Tour titles never pass through sanitize.js (only
// the rich-text bodies do), so they are the one path that could otherwise carry
// markup into a recipient's inbox. Escape at the seam.
const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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
    `Welcome to ${esc(agencyName)}`,
    `<p>You've been given a <strong>${roleText}</strong> login on Sawa Tours.</p>
     <p style="background:#f2ebdc;border-radius:10px;padding:14px">
       <strong>Email:</strong> ${esc(to)}<br/>
       <strong>Temporary password:</strong> <code style="font-size:16px">${esc(tempPassword)}</code>
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
    `Deposit at GoAhead: $${depositDue}\nBalance: $${balanceDue} (due ${balanceDueDate})\n\n` +
    `Nothing has been charged. Your seat is held free — the deposit only falls due once this ` +
    `date reaches its minimum travellers (GoAhead), and we'll email you when that happens.`;
  const html = shell(
    "Booking received",
    `<p>We've recorded your booking for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     <p style="background:#f2ebdc;border-radius:10px;padding:14px">
       Seats: <strong>${esc(seats)}</strong>${bookingCode ? `<br/>Booking code: <strong>${esc(bookingCode)}</strong>` : ""}<br/>
       Deposit at GoAhead: <strong>$${esc(depositDue)}</strong><br/>
       Balance: <strong>$${esc(balanceDue)}</strong> (due ${esc(balanceDueDate)})
     </p>
     <p style="font-size:13px;color:#56524a"><strong>Nothing has been charged.</strong> Your seat is held free — the deposit only falls due once this date reaches its minimum travellers, and we'll email you when it's GoAhead.</p>`
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
    `<p>We've received your request to start a shared departure for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     <p style="background:#f2ebdc;border-radius:10px;padding:14px">
       Seats: <strong>${esc(seats)}</strong>${bookingCode ? `<br/>Booking code: <strong>${esc(bookingCode)}</strong>` : ""}
     </p>
     <p style="font-size:13px;color:#56524a">Our team reviews every requested date — you'll hear from us shortly. Nothing is charged at this stage.</p>`
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
    `<p>Good news — your requested departure for <strong>${esc(route)}</strong> on ${esc(dateLabel)} is <strong>approved</strong> and now open for other travellers to join.</p>
     ${bookingCode ? `<p style="background:#f2ebdc;border-radius:10px;padding:14px">Booking code: <strong>${esc(bookingCode)}</strong></p>` : ""}
     <p style="font-size:13px;color:#56524a">It's confirmed to run (GoAhead) once it reaches its minimum travellers — share the date to fill it faster.</p>`
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
    `<p>We couldn't open your requested departure for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     ${reason ? `<p style="background:#f2ebdc;border-radius:10px;padding:14px">${esc(reason)}</p>` : ""}
     <p style="font-size:13px;color:#56524a">Nothing was charged. Nearby dates for the same tour often need just a few more travellers — <a href="${APP_URL}/departures">browse open departures</a>.</p>`
  );
  return { to, subject, html, text, kind: "departure_request_declined" };
}

export function goAheadEmail({ to, route, dateLabel }) {
  const subject = `Confirmed: ${route} is running`;
  const text = `Good news — ${route} on ${dateLabel} has reached its minimum travellers and is confirmed to run (GoAhead).`;
  const html = shell(
    "Your tour is confirmed",
    `<p><strong>${esc(route)}</strong> on ${esc(dateLabel)} has reached its minimum travellers and is now <strong>GoAhead</strong> — confirmed to run.</p>`
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
    `<p>Good news — your tour listing <strong>"${esc(title)}"</strong> has been reviewed and <strong>approved</strong>. It's now live on Sawa and open for bookings.</p>
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
    `<p>Thanks for submitting <strong>"${esc(title)}"</strong>. We couldn't approve it as-is.</p>
     <p style="background:#fbeaea;border-left:3px solid #c0553f;border-radius:8px;padding:14px;color:#7a2e1f">
       <strong>Reason for rejection</strong><br/>${esc(reason || "No reason provided.").replace(/\n/g, "<br/>")}
     </p>
     <p>Edit the listing and resubmit it for review whenever you're ready.</p>
     <p><a href="${APP_URL}/agency" style="background:#1f5f7a;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;display:inline-block">Edit &amp; resubmit</a></p>`
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
  <p style="background:#f2ebdc;border-radius:10px;padding:14px;font-size:14px;line-height:1.7">
    <strong>Company:</strong> ${esc(app.company)}<br/>
    <strong>Contact:</strong> ${esc(app.contactName)}<br/>
    <strong>City / base:</strong> ${esc(app.city)}<br/>
    <strong>Email:</strong> ${esc(app.email)}<br/>
    <strong>WhatsApp / phone:</strong> ${esc(app.phone || "—")}<br/>
    <strong>Tourism licence:</strong> ${esc(app.licence)}<br/>
    <strong>Regions:</strong> ${esc(app.regions || "—")}
  </p>
  <p style="font-size:14px"><strong>About their tours</strong><br/>${esc(app.about || "—").replace(/\n/g, "<br/>")}</p>`;

export function operatorApplicationEmail({ to, reference, ...app }) {
  const subject = `Operator application — ${app.company} (${reference})`;
  const text = `New operator application (${reference})\n\n${operatorApplicationText(app)}`;
  const html = shell(
    `Operator application — ${esc(app.company)}`,
    `<p style="font-size:13px;color:#56524a">Reference ${esc(reference)}</p>${applicationRows(app)}`
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
    `<p>Thanks — we've received your application to list on Sawa Tours.</p>
     <p>Your reference is <strong>${esc(reference)}</strong>. We verify licences with the Ministry of Tourism &amp; Antiquities and usually come back within <strong>2–4 business days</strong>.</p>
     <p style="font-size:14px"><strong>Here's what you sent us</strong></p>
     ${applicationRows(app)}
     <p style="font-size:13px;color:#56524a">If anything is wrong, just reply to this email.</p>`
  );
  return { to, subject, html, text, kind: "operator_application_receipt" };
}

export function cancellationEmail({ to, route, dateLabel }) {
  const subject = `Cancellation — ${route}`;
  const text = `This confirms your booking for ${route} on ${dateLabel} has been cancelled.`;
  const html = shell("Booking cancelled", `<p>This confirms your booking for <strong>${esc(route)}</strong> on ${esc(dateLabel)} has been cancelled.</p>`);
  return { to, subject, html, text, kind: "cancellation" };
}
