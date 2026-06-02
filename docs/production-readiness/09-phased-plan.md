# 09 — Phased Plan

[← Reuse vs rebuild](08-reuse-vs-rebuild.md) · [Index](README.md) · [Next: Decisions needed →](10-decisions-needed.md)

---

A sequence that front-loads reliability and the accounts system you prioritised.

## Phase 1 — Foundations (reliability core)
- Stand up PostgreSQL; migrate the data shape from `db.json` into real tables.
- Replace the hand-rolled server with a proper framework.
- Add transactions, server-side validation, concurrency control, structured errors.
- **Outcome:** the same features as today, but reliable and incapable of double-booking.

## Phase 2 — Authentication & tenancy
- Login, logout, sessions, password reset, bcrypt password hashing.
- Tenant isolation: agencies only see their own data.
- **Outcome:** real, secure logins; the dropdown role-switch is gone.

## Phase 3 — Two dashboards & roles
- Admin/Staff dashboard and Agency dashboard, gated by role.
- Permissions enforced on every action.
- **Outcome:** the two dashboards you asked for, properly separated.

## Phase 4 — Agency staff management
- Agency owners create/invite/remove their own workers and set their roles.
- Invitations with secure expiring links.
- **Outcome:** agencies self-manage their teams.

## Phase 5 — Email
- Transactional email for invites, resets, confirmations, GoAhead, cancellations.
- **Outcome:** each agency and worker gets the right emails.

## Phase 6 — Hardening & launch readiness
- Audit log, backups, monitoring/alerting, rate limiting, automated tests.
- **Outcome:** production-grade reliability; safe to onboard real agencies.

## Phase 7 — Deferred features (post-launch)
- The 60-day no-booking auto-cancel rule.
- Payments/deposits online (if desired — see file [10](10-decisions-needed.md)).
