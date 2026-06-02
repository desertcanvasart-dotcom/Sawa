# 05 — Reliability Engineering ("No Room for Error")

[← Target architecture](04-target-architecture.md) · [Index](README.md) · [Next: Accounts & roles →](06-accounts-roles.md)

---

This is what separates a demo from a system you can trust with real money. Each item below is **required, not optional**, for the reliability bar you set.

## 5.1 Transactions
Every multi-step operation (book seats → recompute pricing → update status) runs as a single all-or-nothing transaction. If any step fails, nothing changes.

## 5.2 Concurrency control (no double-booking)
When seats are booked, the relevant rows are **locked** so two simultaneous bookings are processed one after another, not on top of each other. Capacity is enforced **inside the transaction**, not guessed beforehand.

## 5.3 Server-side validation of everything
Today the server trusts much of what it's sent. In production, **every field** is validated on the server (types, ranges, ownership, seat limits) regardless of what the front end does. The front end's validation is for user comfort only; the server is the source of truth.

## 5.4 Authorization on every action
Every API call checks: *Is this user logged in? Do they belong to the agency they're acting for? Are they allowed to do this?* No action is reachable just by knowing its URL.

## 5.5 Audit trail
Every meaningful action (create, cancel, confirm, price change, login, account change) is recorded with **who, what, when**. Essential for disputes ("the price was X when I booked") and for trust.

## 5.6 Error handling and safe failures
Real, consistent error responses. The system fails *safely* (refuses the action) rather than *silently* (corrupts data). Users see clear messages; engineers see logged details.

## 5.7 Backups and recovery
Automated daily (or continuous) database backups, with a tested restore procedure. A managed Postgres host provides this.

## 5.8 Monitoring and alerting
Uptime monitoring, error tracking (e.g. Sentry), and alerts so problems are caught before customers report them.

## 5.9 Automated tests
A test suite covering the money-critical paths (booking, capacity, pricing, permissions, payments if added). This is how you keep "no new errors" true over time as features are added.

## 5.10 Rate limiting and abuse protection
Limits on login attempts and booking requests to block brute-force and spam.
