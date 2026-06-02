# 04 — Recommended Target Architecture

[← Database problem](03-database-problem.md) · [Index](README.md) · [Next: Reliability →](05-reliability.md)

---

A pragmatic, reliable, widely-used stack. Nothing exotic — boring and proven is the goal for reliability.

| Layer | Recommendation | Why |
|---|---|---|
| Database | **PostgreSQL** | Transactions, locking, no lost bookings. Industry standard. |
| Back-end framework | **Node.js + a real framework** (Express or Fastify) | Replaces the hand-rolled server. Structured routing, middleware, validation, error handling. |
| Auth | **Sessions or JWT + bcrypt password hashing** | Proven login/credential handling. Never store plain passwords. |
| Email | **A transactional email provider** (Resend, Postmark, SendGrid, or Amazon SES) | Reliable delivery, templates, bounce handling. |
| Validation | **A schema validator** (e.g. Zod) on every request | Nothing reaches the database unchecked. |
| Front end | **Keep the existing React app** | The UI is reusable. It gets wired to the new secure API and login. |
| Hosting | A managed host for the app + a managed Postgres (Railway, Render, Fly.io, or a VPS) | Managed database = automated backups and uptime. |
| Background jobs | A small job runner | For sending emails, and later the 60-day auto-cancel rule. |

> **Note:** the **60-day no-booking auto-cancel rule** your boss approved fits naturally here as a scheduled background job, once this foundation exists. It is still deferred until after packages, as agreed.
