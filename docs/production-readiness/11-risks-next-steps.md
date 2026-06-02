# 11 — Risk Notes & Next Step

[← Decisions needed](10-decisions-needed.md) · [Index](README.md)

---

## Honest risk notes

- **Don't onboard real agencies onto the current prototype.** Without auth and a real database, a data-loss or double-booking incident is likely and would damage trust early.
- **Reliability is mostly invisible work.** Much of Phases 1 and 6 produces no new screen but is exactly what "no room for error" requires. It is the most important part of the budget.
- **Scope creep is the main timeline risk.** Payments (Q1) and Arabic (Q5) each meaningfully extend the work; deciding them now keeps the estimate honest.

## Rough effort

**~6–10 weeks**, swinging mainly on two decisions in file [10](10-decisions-needed.md): online payments (Q1) and Arabic/RTL (Q5).

## Next step

1. You and the boss answer **file [10](10-decisions-needed.md) (Q1–Q10)**.
2. I turn those answers into a **detailed technical build plan** (database schema, API list, screen-by-screen, and a firm phase-by-phase timeline).
3. You approve, and we build **Phase 1 first** — proving reliability before adding features on top.
