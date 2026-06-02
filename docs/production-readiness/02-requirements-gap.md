# 02 — What You Asked For vs. What's Missing

[← Current state](01-current-state.md) · [Index](README.md) · [Next: Database problem →](03-database-problem.md)

---

You described a real product. Here is each requirement mapped to what needs building.

## At a glance

| You asked for | Status |
|---|---|
| Two dashboards (admin/staff + agency) | Screens exist but aren't protected or separated by real accounts — need role-gating |
| Each agency its own credentials | **Build from zero** — full auth system |
| Agencies create access for their workers | **Build from zero** — agency-owner role + invite/manage staff + sub-roles |
| Separate emails per agency | **Build from zero** — transactional email |
| Reliable, no errors | **Biggest item** — real DB + transactions + validation + audit + backups + monitoring + tests |

---

## 2.1 Two dashboards (Admin/Staff and Agencies)
- **Have:** Two *visual* desks already exist (`/admin`, `/agency`).
- **Missing:** They are not protected, not separated by real accounts, and show the same data to everyone. They need to become **role-gated dashboards** where what you see and can do depends on *who you logged in as*.

## 2.2 Each agency has its own credentials
- **Missing entirely.** Needs a full **authentication system**: accounts, secure passwords, login, logout, sessions, password reset.
- Each agency becomes a **tenant** — its own isolated space. An agency can only ever see and touch its own bookings, never another agency's.

## 2.3 Agencies can create access for their own workers
- **Missing entirely.** Needs:
  - An **agency-admin role** (the owner/manager at each agency).
  - The ability for that agency-admin to **invite or create staff accounts** under their agency.
  - **Roles within an agency** (e.g. Manager vs. Agent) controlling what each worker can do.
  - Invitations, account activation, and the ability to deactivate a worker who leaves.

## 2.4 Each agency receives separate emails
- **Missing entirely.** Needs a **transactional email system** (account invites, password resets, booking confirmations, GoAhead notifications, cancellations).
- Emails must go to the **right agency and the right person** — driven by the accounts system above.

## 2.5 "Fully working, no room for error" (reliability)
The biggest and most important item — see file [05](05-reliability.md). In short, it requires: a **real database with transactions**, **server-side validation of everything**, **concurrency control** so simultaneous bookings can't corrupt data, **automated backups**, **monitoring/alerting**, and an **automated test suite**.
