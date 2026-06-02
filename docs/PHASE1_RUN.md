# Phase 1 — How to run (local)

Phase 1 replaces the JSON-file backend with **PostgreSQL + Express**, with
transactions and row-locking so bookings can never oversell or corrupt.
The frontend is unchanged.

## One-time setup

1. **Create the database & app role** (run as the postgres superuser — it will
   prompt for the password you set when installing PostgreSQL 18):

   ```
   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -f "E:\Sawa\Sawa\server\db\setup.sql"
   ```

2. **Create the tables:**
   ```
   npm run db:migrate
   ```

3. **Load the existing data:**
   ```
   npm run db:seed
   ```

## Run it

```
npm run api      # Postgres-backed API on http://localhost:8787
npm run web      # frontend on http://localhost:5173
```

## Useful

- `npm run db:reset` — re-apply schema and reseed from `data/db.json`.
- `npm run api:legacy` — the old JSON-file server (kept for reference only).
- Health check: `GET http://localhost:8787/api/health` -> `{ "ok": true }`.

## What changed under the hood

- **Real database** (`server/db/schema.sql`) with foreign keys and constraints.
- **Transactions** — every write is all-or-nothing (`withTransaction`).
- **Row-locking** — bookings `SELECT ... FOR UPDATE` the departure, so two
  simultaneous bookings are serialised and capacity is enforced safely.
- **Validation** — request bodies validated with Zod before any DB work.
- **Structured errors** — consistent JSON errors; the server fails safely.

The API responses are identical to the old server, so no frontend change was
needed. Auth, dashboards, staff, and email come in Phases 2-5.

## Config

`.env` holds `DATABASE_URL`. For Railway later, set `DATABASE_URL` and
`PGSSL=true` in the Railway environment — no code changes needed.
