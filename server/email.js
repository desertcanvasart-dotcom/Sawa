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

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Sawa Tours <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "http://localhost:5173";

// Where replies go. The sending domain and the receiving domain are not the
// same thing: a domain is verified for SENDING by SPF/DKIM records on
// subdomains, which says nothing about whether anything accepts mail for it.
// sawa.tours resolves via a CNAME at the apex — that answers MX queries too, so
// mail servers find no mailhost and every reply bounces. BRAND.email sits on the
// domain that actually has MX records, so replies land in a real inbox
// regardless of which address we send from.
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
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text, reply_to: REPLY_TO }),
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
              <a href="mailto:hello@sawatours.org" style="color:${C.goldInk};text-decoration:underline">hello@sawatours.org</a>.
            </p>
            <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.65;color:#8a9294">
              Shared departures, confirmed together.<br/>
              Capital Travel Service, trading as Sawa Tours &middot; Giza, Egypt
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

export function bookingConfirmationEmail({ to, customerName, route, dateLabel, seats, depositDue, balanceDue, balanceDueDate, bookingCode }) {
  const subject = `Booking received — ${route}`;
  const text =
    `Hi ${customerName || ""},\n\nWe've recorded your booking for ${route} on ${dateLabel}.\n` +
    `Seats: ${seats}\n${bookingCode ? `Booking code: ${bookingCode}\n` : ""}` +
    `Deposit at GoAhead: $${depositDue} USD\nBalance: $${balanceDue} USD (due ${balanceDueDate})\n\n` +
    `Nothing has been charged. Your seat is held free — the deposit only falls due once this ` +
    `date reaches its minimum travellers (GoAhead), and we'll email you when that happens.`;
  const html = shell(
    "Booking received",
    `<p style="margin:0 0 20px">We've recorded your booking for <strong>${esc(route)}</strong> on ${esc(dateLabel)}.</p>
     ${panel(
       `${row("Seats:", esc(seats))}<br/>
        ${bookingCode ? `${row("Booking code:", esc(bookingCode))}<br/>` : ""}
        ${row("Deposit at GoAhead:", `$${esc(depositDue)} USD`)}<br/>
        ${row("Balance:", `$${esc(balanceDue)} USD`)} <span style="color:${C.muted}">(due ${esc(balanceDueDate)})</span>`
     )}
     ${note(`<strong style="color:${C.ink}">Nothing has been charged.</strong> Your seat is held free — the deposit only falls due once this date reaches its minimum travellers, and we'll email you when it's GoAhead.`)}`,
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

export function goAheadEmail({ to, route, dateLabel }) {
  const subject = `Confirmed: ${route} is running`;
  const text = `Good news — ${route} on ${dateLabel} has reached its minimum travellers and is confirmed to run (GoAhead).`;
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
     ${note("Your operator has been notified and is confirming the guide and vehicle. We'll be in touch with your joining details and anything still outstanding on payment.")}`,
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
