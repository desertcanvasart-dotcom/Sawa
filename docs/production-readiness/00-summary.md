# 00 — Plain Summary

[← Index](README.md) · [Next: Current state →](01-current-state.md)

---

What we have today is a **working skeleton / demo**, not a production system. It correctly shows the *idea* — pooled group tours, day tours, packages, live pricing, the booking flow — and that idea is sound.

But it was built to **demonstrate**, not to **operate a real business**. Three things make it unsafe to put real agencies and real money on it as-is:

1. **There is no login.** Anyone who opens the site can act as any agency or as the admin by picking a role from a dropdown. There are no passwords, no accounts, nothing.

2. **The "database" is a single text file** (`db.json`). If two people book at the same moment, one booking can silently overwrite the other. There is no protection against this. For a booking business, that is a direct path to double-bookings and lost money.

3. **No email, no audit trail, no backups, no tests.** Nothing notifies anyone, nothing records who did what, and nothing protects against data loss.

None of this is a criticism of the work so far — a skeleton is *supposed* to be a skeleton. This document is the plan to turn it into the reliable system you described.

**Bottom line:** to deliver what you asked for (two real dashboards, per-agency credentials, agency-managed staff, separate emails, "no room for error"), the back end and data layer need to be rebuilt on proper foundations. The front end (the look and the screens) is largely reusable. This is roughly a **6–10 week build**, depending on the decisions in file [10](10-decisions-needed.md).
