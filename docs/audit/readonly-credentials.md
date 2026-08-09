# X1 — Read-only credentials, and auditing the auditors

**9 August 2026.**

## The incident this closes

`scripts/audit-claims.js` renders every email template so the copy inside them
can be checked. It selected templates by name pattern — `/Email$|Text$/` — and
that pattern matched **`sendEmail`**.

So the audit called it. A row appeared in the production `email_log`. The row
was deleted and the pattern was replaced with an explicit ALLOW-list.

That fixed the instance. **An auditor that inspects a claim and changes the
system while doing so is not an auditor**, and the way to guarantee it does not
is not to keep reviewing what it does.

---

## What shipped

### The session refuses writes, whatever the credentials permit

`server/db/readonly.js` opens the audit connection with
`default_transaction_read_only=on` set as a session option. It applies to every
statement, including implicit single-statement transactions — an unwrapped
`INSERT` is rejected, not only one inside `BEGIN`/`COMMIT`.

**This works today, against the application's own write-capable credentials.**
The guarantee does not wait on anyone provisioning a role.

Proved against a real PostgreSQL 17 database, using ordinary owner credentials:

```
read  : 1 row(s) — reads work
INSERT: rejected, SQLSTATE 25006 (read-only transaction)
UPDATE: rejected, SQLSTATE 25006 (read-only transaction)
DELETE: rejected, SQLSTATE 25006 (read-only transaction)
CREATE: rejected, SQLSTATE 25006 (read-only transaction)
```

The same credentials write freely through `server/db/index.js`. The difference
is the session, not the role.

### Nothing may reach past it

`server/auditor-readonly.test.js` asserts that no `scripts/audit-*.js`:

- imports `server/db/index.js` — the application's pool, with full rights
- constructs its own `Pool`, which would bypass the restriction entirely

and that every auditor touching the database uses `readOnlyPool()`.

**Proven to fire:** reverting `audit-claims.js` to the writable import fails
tests 2 and 3.

The second assertion matters as much as the first. Not importing the writable
pool is no use if an auditor opens its own connection from the same URL.

---

## ⏳ What still needs the client — a real least-privilege role

> **UU1 — the layering, stated the right way round.**
>
> This was found session-first, which made the session setting look like the
> primary guarantee. It is not.
>
> **A session setting can be talked out of.** One
> `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE` and it is gone. A role
> without write grants cannot be talked out of anything.
>
> So the session setting is the **convenient** layer — it works today, with the
> credentials that already exist, without waiting for anyone. The role is the
> **unconditional** one. It is not blocking, and it is **not closed**.

The session restriction is a belt. This is the braces, and it is the only part
that protects against a script that deliberately turns the restriction off
(`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE` would defeat it, and no
static check can see through a runtime string).

**Run once, as the database owner:**

```sql
-- A role that cannot write, whatever it asks for.
CREATE ROLE sawa_auditor LOGIN PASSWORD '<choose one>';

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sawa_auditor;
GRANT CONNECT ON DATABASE <database> TO sawa_auditor;
GRANT USAGE ON SCHEMA public TO sawa_auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sawa_auditor;

-- Tables created later are covered without anyone remembering to re-run this.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sawa_auditor;
```

Then set, alongside `DATABASE_URL`:

```
DATABASE_URL_READONLY=postgres://sawa_auditor:<password>@<host>/<database>
```

`readOnlyPool()` prefers it automatically. **No code change** — that is why the
variable exists rather than the URL being read directly.

I have not created this role and will not: it needs the database password, which
is yours to hold.

### Until it exists

The session restriction is live and proved. The gap it leaves is narrow and
worth naming precisely: **a script that explicitly re-enables writes at runtime
would succeed.**

UU1.1 adds a static check for the plausible form of that — someone hitting a
permissions error mid-audit and reaching for the obvious unblock. It flags
`SET SESSION CHARACTERISTICS`, `SET default_transaction_read_only`,
`BEGIN READ WRITE`, `START TRANSACTION READ WRITE` and `SET TRANSACTION READ
WRITE` in any `audit-*` file, and its patterns are themselves tested against the
statements they name so a typo cannot make it pass on everything.

**It is a pointer, not a verdict.** `client.query("SET SESSION " + mode)` walks
straight past it. Only the role closes this.

`email_log` remains the evidence trail either way: it is the table the incident
touched, and any future write by an auditor would appear there or in
`audit_log`.

---

## Why this comes before SS3.1

The applied-schema check must query production's `schema_migrations` — a check
reading only repository files would pass on **exactly** the case that matters, a
migration merged and never run.

That means the check needs production database access, and it will run inside
`preflight`. Giving `preflight` write-capable credentials to answer a read-only
question is how the `email_log` incident happens again, one step further out.

**So the read-only path lands first, and SS3.1 uses it.**
