# 08 — What Is Reusable vs. What Is Rebuilt

[← Email](07-email.md) · [Index](README.md) · [Next: Phased plan →](09-phased-plan.md)

---

## Reusable (most of the visible work survives)
- The React front-end screens, components, and the new design/identity.
- The booking-flow logic and pricing model (concepts and formulas).
- The data *shape* (tours, departures, packages, pledges) — it maps cleanly onto database tables.

## Rebuilt / newly built
- The back end (framework + real database instead of a JSON file).
- Authentication, accounts, roles, sessions.
- Agency staff management.
- Email.
- All the reliability infrastructure in file [05](05-reliability.md).
- Connecting the existing screens to the new secure, logged-in API.
