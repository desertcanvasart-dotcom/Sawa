# 06 — Accounts, Roles & Permissions

[← Reliability](05-reliability.md) · [Index](README.md) · [Next: Email →](07-email.md)

---

A clear model for *who can do what*. This is what makes the two dashboards real.

## Roles

**Platform side (your company):**
- **Super Admin** — full control: manage agencies, staff, tours, packages, pricing, confirmations, everything.
- **Operations Staff** — day-to-day: publish dates, confirm GoAhead, manage bookings. No destructive/system settings.

**Agency side (each travel agency):**
- **Agency Owner / Admin** — manages their own agency: **creates and removes their staff accounts**, sees all their agency's bookings, books and cancels.
- **Agency Agent (worker)** — books seats, manages their own customers, limited or no ability to manage other staff.

## Key rules
- **Tenant isolation:** an agency can *never* see or affect another agency's data. Enforced in the database and on every query.
- **Agency self-service:** the Agency Owner invites/creates workers, assigns their role, and deactivates them when they leave — without needing your team.
- **Least privilege:** each role can do only what it needs.

## New data the system needs (beyond today's tour/booking data)
- **Users** — email, hashed password, name, role, which agency they belong to, active/inactive
- **Agencies** — already exist, but extended with billing/contact/owner
- **Invitations** — pending staff invites with secure, expiring tokens
- **Sessions** — login state
- **Audit log** — every action
- **Email log** — what was sent, to whom, delivery status
- **Bookings linked to a real user and agency**, not a free-text name
