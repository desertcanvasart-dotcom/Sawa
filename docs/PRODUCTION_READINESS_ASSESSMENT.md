# Sawa — Production Readiness Assessment

**Project:** Sawa Shared Tours
**Prepared:** 2026-05-29
**Status:** For management review and decisions
**Goal:** Turn the current prototype into a fully functional, reliable, multi-tenant system with two dashboards (Admin/Staff + Agencies), per-agency credentials, agency-managed staff accounts, separate email per agency, and **reliability as the top priority**.

---

## 1. Read This First (Plain Summary)

What we have today is a **working skeleton / demo**, not a production system. It correctly shows the *idea* — pooled group tours, day tours, packages, live pricing, the booking flow — and that idea is sound.

But it was built to **demonstrate**, not to **operate a real business**. Three things make it unsafe to put real agencies and real money on it as-is:

1. **There is no login.** Anyone who opens the site can act as any agency or as the admin by picking a role from a dropdown. There are no passwords, no accounts, nothing.
2. **The "database" is a single text file** (`db.json`). If two people book at the same moment, one booking can silently overwrite the other. There is no protection against this. For a booking business, that is a direct path to double-bookings and lost money.
3. **No email, no audit trail, no backups, no tests.** Nothing notifies anyone, nothing records who did what, and nothing protects against data loss.

None of this is a criticism of the work so far — a skeleton is *supposed* to be a skeleton. This document is the plan to turn it into the reliable system you described.

**Bottom line:** to deliver what you asked for (two real dashboards, per-agency credentials, agency-managed staff, separate emails, "no room for error"), the back end and data layer need to be rebuilt on proper foundations. The front end (the look and the screens) is largely reusable. This is roughly a **6–10 week build**, depending on the decisions in Section 11.

---

## 2. What Exists Today

| Area | Current state |
|---|---|
| Front end | React + Vite single-page app. Public site, agency desk, admin desk. Looks good, works for demos. |
| Back end | A hand-written Node.js HTTP server (`server/api.js`), ~430 lines. No framework. |
| Database | A single JSON file (`data/db.json`). Read fully into memory, written back fully on every change. |
| Login / accounts | **None.** Role is chosen from a sidebar dropdown. No passwords, no sessions. |
| Agencies | Exist as records, but anyone can "act as" any agency. |
| Staff / workers | **Concept does not exist.** |
| Email | **None.** |
| Permissions | **None.** Admin actions are reachable by anyone who visits `/admin`. |
| Audit log | **None.** No record of who created, cancelled, or changed anything. |
| Backups | **None.** |
| Tests | **None.** |
| Security | CORS fully open; no rate limiting; no input hardening. |

---

## 3. What You Asked For vs. What's Missing

You described a real product. Here is each requirement mapped to what needs building.

### 3.1 Two dashboards (Admin/Staff and Agencies)
- **Have:** Two *visual* desks already exist (`/admin`, `/agency`).
- **Missing:** They are not protected, not separated by real accounts, and show the same data to everyone. They need to become **role-gated dashboards** where what you see and can do depends on *who you logged in as*.

### 3.2 Each agency has its own credentials
- **Missing entirely.** Needs a full **authentication system**: accounts, secure passwords, login, logout, sessions, password reset.
- Each agency becomes a **tenant** — its own isolated space. An agency can only ever see and touch its own bookings, never another agency's.

### 3.3 Agencies can create access for their own workers
- **Missing entirely.** Needs:
  - An **agency-admin role** (the owner/manager at each agency).
  - The ability for that agency-admin to **invite or create staff accounts** under their agency.
  - **Roles within an agency** (e.g. Manager vs. Agent) controlling what each worker can do.
  - Invitations, account activation, and the ability to deactivate a worker who leaves.

### 3.4 Each agency receives separate emails
- **Missing entirely.** Needs a **transactional email system** (e.g. account invites, password resets, booking confirmations, GoAhead notifications, cancellations).
- Emails must go to the **right agency and the right person** — driven by the accounts system above.

### 3.5 "Fully working, no room for error" (reliability)
This is the biggest and most important item, covered in detail in Section 6. In short, it requires: a **real database with transactions**, **server-side validation of everything**, **concurrency control** so simultaneous bookings can't corrupt data, **automated backups**, **monitoring/alerting**, and an **automated test suite**.

---

## 4. The Core Problem: a JSON File Is Not a Database

This deserves its own section because it is the single biggest reliability risk.

Today every change does this:
1. Read the **entire** `db.json` into memory.
2. Change one thing.
3. Write the **entire** file back.

Problems this causes in real use:
- **Lost updates / double-booking:** Two agencies booking the last seats at the same second → the second write overwrites the first. Seats oversell. Money and trust lost.
- **No "all-or-nothing":** A booking that should update seats + pricing + status either fully happens or fully doesn't. A flat file can't guarantee that. A crash mid-write can corrupt the whole file.
- **No concurrent safety:** The file has no locking. Under any real traffic, corruption is a matter of *when*, not *if*.
- **Doesn't scale:** Rewriting the whole file on every action gets slower as data grows and breaks entirely if you ever run more than one server.

**Required fix:** move to a real database with **transactions** and **row-level locking**. Recommended: **PostgreSQL** (battle-tested, free, handles money/bookings correctly). SQLite is a lighter option for a smaller launch, but PostgreSQL is the right call for a system that must not lose bookings.

---

## 5. Recommended Target Architecture

A pragmatic, reliable, widely-used stack. Nothing exotic — boring and proven is the goal for reliability.

| Layer | Recommendation | Why |
|---|---|---|
| Database | **PostgreSQL** | Transactions, locking, no lost bookings. Industry standard. |
| Back-end framework | **Node.js + a real framework** (Express or Fastify) | Replaces the hand-rolled server. Structured routing, middleware, validation, error handling. |
| Auth | **Sessions or JWT + bcrypt password hashing** | Proven login/credential handling. Never store plain passwords. |
| Email | **A transactional email provider** (e.g. Resend, Postmark, SendGrid, or Amazon SES) | Reliable delivery, templates, bounce handling. |
| Validation | **A schema validator** (e.g. Zod) on every request | Nothing reaches the database unchecked. |
| Front end | **Keep the existing React app** | The UI is reusable. It gets wired to the new secure API and login. |
| Hosting | A managed host for the app + a managed Postgres (e.g. Railway, Render, Fly.io, or a VPS) | Managed database = automated backups and uptime. |
| Background jobs | A small job runner | For sending emails, and later the 60-day auto-cancel rule. |

> Note: the **60-day no-booking auto-cancel rule** your boss approved fits naturally here as a scheduled background job, once this foundation exists. It is still deferred until after packages, as agreed.

---

## 6. Reliability Engineering — the "No Room for Error" Part

This is what separates a demo from a system you can trust with real money. Each item below is required, not optional, for the reliability bar you set.

### 6.1 Transactions
Every multi-step operation (book seats → recompute pricing → update status) runs as a single all-or-nothing transaction. If any step fails, nothing changes.

### 6.2 Concurrency control (no double-booking)
When seats are booked, the relevant rows are **locked** so two simultaneous bookings are processed one after another, not on top of each other. Capacity is enforced **inside the transaction**, not guessed beforehand.

### 6.3 Server-side validation of everything
Today the server trusts much of what it's sent. In production, **every field** is validated on the server (types, ranges, ownership, seat limits) regardless of what the front end does. The front end's validation is for user comfort only; the server is the source of truth.

### 6.4 Authorization on every action
Every API call checks: *Is this user logged in? Do they belong to the agency they're acting for? Are they allowed to do this?* No action is reachable just by knowing its URL.

### 6.5 Audit trail
Every meaningful action (create, cancel, confirm, price change, login, account change) is recorded with **who, what, when**. Essential for disputes ("the price was X when I booked") and for trust.

### 6.6 Error handling and safe failures
Real, consistent error responses. The system fails *safely* (refuses the action) rather than *silently* (corrupts data). Users see clear messages; engineers see logged details.

### 6.7 Backups and recovery
Automated daily (or continuous) database backups, with a tested restore procedure. A managed Postgres host provides this.

### 6.8 Monitoring and alerting
Uptime monitoring, error tracking (e.g. Sentry), and alerts so problems are caught before customers report them.

### 6.9 Automated tests
A test suite covering the money-critical paths (booking, capacity, pricing, permissions, payments if added). This is how you keep "no new errors" true over time as features are added.

### 6.10 Rate limiting and abuse protection
Limits on login attempts and booking requests to block brute-force and spam.

---

## 7. Accounts, Roles & Permissions (the heart of the request)

A clear model for *who can do what*. This is what makes the two dashboards real.

### Roles

**Platform side (your company):**
- **Super Admin** — full control: manage agencies, staff, tours, packages, pricing, confirmations, everything.
- **Operations Staff** — day-to-day: publish dates, confirm GoAhead, manage bookings. No destructive/system settings.

**Agency side (each travel agency):**
- **Agency Owner / Admin** — manages their own agency: **creates and removes their staff accounts**, sees all their agency's bookings, books and cancels.
- **Agency Agent (worker)** — books seats, manages their own customers, limited or no ability to manage other staff.

### Key rules
- **Tenant isolation:** an agency can *never* see or affect another agency's data. Enforced in the database and on every query.
- **Agency self-service:** the Agency Owner invites/creates workers, assigns their role, and deactivates them when they leave — without needing your team.
- **Least privilege:** each role can do only what it needs.

### New data the system needs (beyond today's tour/booking data)
- **Users** (email, hashed password, name, role, which agency they belong to, active/inactive)
- **Agencies** (already exist, but extended with billing/contact/owner)
- **Invitations** (pending staff invites with secure, expiring tokens)
- **Sessions** (login state)
- **Audit log** (every action)
- **Email log** (what was sent, to whom, delivery status)
- Bookings linked to **a real user and agency**, not a free-text name.

---

## 8. Email System

Required emails, each routed to the correct agency/person:
- **Account invitation** (agency owner invites a worker; you invite an agency owner)
- **Welcome / set-password**
- **Password reset**
- **Booking confirmation** (to the booking agency)
- **GoAhead confirmed** (the date is running)
- **Cancellation / change notices**
- (Later) **Balance-due reminders**, **60-day auto-cancel notices**

Built on a transactional email provider so delivery is reliable and trackable, with branded templates and per-agency addressing.

---

## 9. What Is Reusable vs. What Is Rebuilt

**Reusable (most of the visible work survives):**
- The React front-end screens, components, and the new design/identity.
- The booking-flow logic and pricing model (concepts and formulas).
- The data *shape* (tours, departures, packages, pledges) — it maps cleanly onto database tables.

**Rebuilt / newly built:**
- The back end (framework + real database instead of a JSON file).
- Authentication, accounts, roles, sessions.
- Agency staff management.
- Email.
- All the reliability infrastructure in Section 6.
- Connecting the existing screens to the new secure, logged-in API.

---

## 10. Phased Plan

A sequence that front-loads reliability and the accounts system you prioritised.

**Phase 1 — Foundations (reliability core)**
- Stand up PostgreSQL; migrate the data shape from `db.json` into real tables.
- Replace the hand-rolled server with a proper framework.
- Add transactions, server-side validation, concurrency control, structured errors.
- *Outcome: the same features as today, but reliable and incapable of double-booking.*

**Phase 2 — Authentication & tenancy**
- Login, logout, sessions, password reset, bcrypt password hashing.
- Tenant isolation: agencies only see their own data.
- *Outcome: real, secure logins; the dropdown role-switch is gone.*

**Phase 3 — Two dashboards & roles**
- Admin/Staff dashboard and Agency dashboard, gated by role.
- Permissions enforced on every action.
- *Outcome: the two dashboards you asked for, properly separated.*

**Phase 4 — Agency staff management**
- Agency owners create/invite/remove their own workers and set their roles.
- Invitations with secure expiring links.
- *Outcome: agencies self-manage their teams.*

**Phase 5 — Email**
- Transactional email for invites, resets, confirmations, GoAhead, cancellations.
- *Outcome: each agency and worker gets the right emails.*

**Phase 6 — Hardening & launch readiness**
- Audit log, backups, monitoring/alerting, rate limiting, automated tests.
- *Outcome: production-grade reliability; safe to onboard real agencies.*

**Phase 7 — Deferred features (post-launch)**
- The 60-day no-booking auto-cancel rule.
- Payments/deposits online (if desired — see Section 11).

---

## 11. Decisions Needed From You / The Boss

These shape scope, cost, and timeline. Please answer each.

### Q1. Online payments — in or out of scope?
Right now deposits are shown but not *collected* online. Do you want real payment collection (card/Fawry/etc.) in this build, or do agencies keep settling payment off-platform for now? *(Adds significant scope and compliance if in.)*

### Q2. Database choice
We recommend **PostgreSQL** for reliability. Agree, or do you have a hosting/database preference already?

### Q3. Hosting
Do you have a preferred host/cloud (AWS, a VPS, Railway/Render, etc.), or should we recommend and set one up?

### Q4. Email provider
Any existing email service or domain you must use? Otherwise we'll recommend one and configure your sending domain.

### Q5. Languages
English only for launch, or do we need **Arabic / right-to-left** support? *(Best decided now — retrofitting later is costly.)*

### Q6. Agency onboarding
How does a new agency get in? Self-signup with your approval, or only your team creates agency accounts? This changes the signup flow.

### Q7. Roles
Are the roles in Section 7 (Super Admin, Ops Staff / Agency Owner, Agency Agent) right, or do you need more granularity (e.g. finance-only, read-only)?

### Q8. Customer accounts
Should **direct travellers** (public site) also get accounts and login, or stay as one-off guest bookings like today?

### Q9. Scale expectation
Rough number of agencies, workers, and bookings/month at launch and in year one? This informs hosting size and a few design choices.

### Q10. Compliance
Any data-protection or tourism-authority requirements we must meet (data residency, invoicing rules, etc.)?

---

## 12. Honest Risk Notes

- **Don't onboard real agencies onto the current prototype.** Without auth and a real database, a data-loss or double-booking incident is likely and would damage trust early.
- **Reliability is mostly invisible work.** Much of Phases 1 and 6 produces no new screen but is exactly what "no room for error" requires. It is the most important part of the budget.
- **Scope creep is the main timeline risk.** Payments (Q1) and Arabic (Q5) each meaningfully extend the work; deciding them now keeps the estimate honest.

---

## 13. Next Step

1. You and the boss answer **Section 11 (Q1–Q10)**.
2. I turn those answers into a **detailed technical build plan** (database schema, API list, screen-by-screen, and a firm phase-by-phase timeline).
3. You approve, and we build Phase 1 first — proving reliability before adding features on top.

---

*End of assessment.*
