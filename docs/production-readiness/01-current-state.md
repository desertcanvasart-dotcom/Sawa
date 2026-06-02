# 01 — What Exists Today

[← Summary](00-summary.md) · [Index](README.md) · [Next: Requirements gap →](02-requirements-gap.md)

---

| Area | Current state |
|---|---|
| Front end | React + Vite single-page app. Public site, agency desk, admin desk. Looks good, works for demos. |
| Back end | A hand-written Node.js HTTP server (`server/api.js`), ~430 lines. No framework. |
| Database | A single JSON file (`data/db.json`). Read fully into memory, written back fully on every change. |
| Login / accounts | **None.** Role is chosen from a sidebar dropdown. No passwords, no sessions. |
| Agencies | Exist as records, but anyone can "act as" any agency. |
| Staff / workers | **Concept does not exist.** |
| Email | **None.** |
| Permissions | **None.** Admin actions are reachable by anyone who visits `/admin`. |
| Audit log | **None.** No record of who created, cancelled, or changed anything. |
| Backups | **None.** |
| Tests | **None.** |
| Security | CORS fully open; no rate limiting; no input hardening. |

**Verified 2026-05-29:** `package.json` contains only React, Vite, and an icon library — no authentication, database, email, or security packages of any kind. This confirms the system is a front-end prototype with a demo back end.
