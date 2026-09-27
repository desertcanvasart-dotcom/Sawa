# Taking Capital Travel Service off the public pages (production)

Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). Its `agencies` record still appears on `/partners`, and it can still be named as a date's operator on tour pages, in booking confirmations, in GoAhead emails and in the JSON-LD.

The record is **kept, not deleted**. Past bookings, settlements, payouts and the audit trail refer to it.

- Migration 054 adds `agencies.public_listed`.
- `publicOperator()` in `server/domain.js` names no record where it is `false`, on every traveler-facing surface.
- Where no operator is named, pages and emails say "a licensed Sawa partner".

**Not run by Claude.** Run it yourself, after the live-fix PR is deployed.

## Before: check what you're changing

Supabase → SQL editor, on the production project. This query only reads.

```sql
SELECT id, name, verification_state
  FROM agencies
 WHERE name ILIKE 'capital travel%';
```

Expect **one row**, named exactly `Capital Travel Service`. If there are none, or more than one, stop and check before going on.

## The change

```sql
BEGIN;

-- Migration 054, idempotent. Skip it if `npm run db:migrate` already applied it.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS public_listed BOOLEAN NOT NULL DEFAULT true;
INSERT INTO schema_migrations (name) VALUES ('054_partner_listing') ON CONFLICT (name) DO NOTHING;

-- Take Capital Travel Service off the public surfaces.
UPDATE agencies
   SET public_listed = false
 WHERE name = 'Capital Travel Service';
-- Expect: UPDATE 1

COMMIT;
```

If the `UPDATE` reports anything other than 1, run `ROLLBACK;` instead of `COMMIT;`.

## Check

- `https://sawa.tours/partners` no longer names Capital Travel Service. The server-rendered HTML can take up to the page cache's lifetime to change; a redeploy clears it.
- A tour page that used to show Capital Travel Service as "Your operator" now says "Run by a licensed Sawa partner".
- The daily DOM smoke no longer requires Capital Travel Service on `/partners`, as of the live-fix PR.

## Rollback

```sql
BEGIN;
UPDATE agencies
   SET public_listed = true
 WHERE name = 'Capital Travel Service';
-- Expect: UPDATE 1
COMMIT;
```

This puts the record back on every public surface. The column stays; removing it is `server/db/down/schema_054_partner_listing.down.sql`, which shows every record again.

## Related: `DIRECT_BOOKINGS_OPERATOR`

`server/brand.js` no longer defaults it to "Capital Travel Service". If Railway still sets `DIRECT_BOOKINGS_OPERATOR=Capital Travel Service`, direct travelers' dates still resolve to that record:

- they count for it in the operator rule;
- they count for it in the legacy profit split.

The record is unlisted, so it isn't named on pages or in emails, but the split still pays it. **Delete the variable in Railway** (web service → Variables), or set it to another operator's exact name if one should take direct bookings.
