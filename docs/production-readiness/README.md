# Sawa — Production Readiness Assessment

**Prepared:** 2026-05-29
**Status:** For management review and decisions
**Goal:** Turn the current prototype into a fully functional, reliable, multi-tenant system — two dashboards (Admin/Staff + Agencies), per-agency credentials, agency-managed staff accounts, separate email per agency, with **reliability as the top priority**.

---

## How to read this

This folder breaks the assessment into short, focused files. Read them in order, or jump to what you need.

| # | File | What's in it |
|---|------|--------------|
| 00 | [00-summary.md](00-summary.md) | Plain-language summary. **Start here.** |
| 01 | [01-current-state.md](01-current-state.md) | What exists in the prototype today |
| 02 | [02-requirements-gap.md](02-requirements-gap.md) | What you asked for vs. what's missing |
| 03 | [03-database-problem.md](03-database-problem.md) | Why the JSON file is the #1 reliability risk |
| 04 | [04-target-architecture.md](04-target-architecture.md) | Recommended stack to build on |
| 05 | [05-reliability.md](05-reliability.md) | The "no room for error" engineering |
| 06 | [06-accounts-roles.md](06-accounts-roles.md) | Logins, roles, permissions, agency staff |
| 07 | [07-email.md](07-email.md) | The email system |
| 08 | [08-reuse-vs-rebuild.md](08-reuse-vs-rebuild.md) | What survives, what gets rebuilt |
| 09 | [09-phased-plan.md](09-phased-plan.md) | Step-by-step build sequence |
| 10 | [10-decisions-needed.md](10-decisions-needed.md) | **Questions for the boss to answer** |
| 11 | [11-risks-next-steps.md](11-risks-next-steps.md) | Risk notes and next step |

---

## One-paragraph version

What we have is a **working skeleton** — it demonstrates the idea well, but it was built to demo, not to run a real business. It has **no login** (anyone can act as any agency or admin), its **"database" is a single text file** that can lose bookings when two people act at once, and it has **no email, no audit trail, no backups, and no tests**. Everything you asked for — two real dashboards, per-agency credentials, agency-managed workers, separate emails, and "no room for error" — sits on top of foundations that need to be built. The front-end screens and design are reusable; the back end and data layer need a proper rebuild. Estimated **6–10 weeks** depending on the decisions in file 10.
