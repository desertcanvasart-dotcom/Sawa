# 03 — The Core Problem: a JSON File Is Not a Database

[← Requirements gap](02-requirements-gap.md) · [Index](README.md) · [Next: Target architecture →](04-target-architecture.md)

---

This deserves its own file because it is the single biggest reliability risk.

Today every change does this:
1. Read the **entire** `db.json` into memory.
2. Change one thing.
3. Write the **entire** file back.

## Problems this causes in real use

- **Lost updates / double-booking:** Two agencies booking the last seats at the same second → the second write overwrites the first. Seats oversell. Money and trust lost.
- **No "all-or-nothing":** A booking that should update seats + pricing + status either fully happens or fully doesn't. A flat file can't guarantee that. A crash mid-write can corrupt the whole file.
- **No concurrent safety:** The file has no locking. Under any real traffic, corruption is a matter of *when*, not *if*.
- **Doesn't scale:** Rewriting the whole file on every action gets slower as data grows and breaks entirely if you ever run more than one server.

## Required fix

Move to a real database with **transactions** and **row-level locking**.

**Recommended: PostgreSQL** — battle-tested, free, and handles money/bookings correctly. SQLite is a lighter option for a smaller launch, but PostgreSQL is the right call for a system that must not lose bookings.
