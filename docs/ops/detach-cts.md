# Detaching Capital Travel Service from tours, packages and departures (production)

Capital Travel Service (CTS) is not involved in Sawa (decided 27 Sep 2026). Some tours still have it attached as "Operating company" (for example *Giza Pyramids, Sphinx & the Grand Egyptian Museum*), so live departure pages name it. Once detached, they show "a licensed Sawa partner".

**Not run by Claude.** Nothing here has been run; Claude had no production database access. Run it yourself in the Supabase SQL editor, in order.

The record itself is **kept**. Bookings, settlements, payouts and the audit trail refer to it. Only the *attachments* are removed.

## Where CTS can be attached

| Where | Column | What it does |
|---|---|---|
| Tours and packages | `tour_products.agency_id` | Names CTS as the operating company on the tour page and on every departure of it (both `day_tour` and `package`). |
| Departures | none stored | A departure has no operator column. Its operator is derived: the tour's `agency_id`, else the direct-bookings operator, else the agency with most seats. Detaching the tour therefore detaches its departures. |
| Merged departures | `departure_merges.operator_agency_id` | The operator picked when duplicate dates were merged. |
| Catalogue assignments | `catalogue_assignments.operator_id` → `operators.agency_id` | The operator offered or acknowledged on a catalogue date. |

Separately, if Railway still sets `DIRECT_BOOKINGS_OPERATOR=Capital Travel Service`, direct-booking departures resolve to CTS. Delete that variable (see `remove-cts-from-partners.md`, "Related").

## 1. Find CTS, and list what it is attached to (read-only)

```sql
-- Expect exactly one row. If there are none or several, stop and check.
SELECT a.id, a.name, a.public_listed, o.id AS operator_id, o.status AS operator_status
  FROM agencies a LEFT JOIN operators o ON o.agency_id = a.id
 WHERE a.name ILIKE 'capital travel%';

-- Tours and packages
SELECT t.id, t.type, t.title, t.status
  FROM tour_products t
  JOIN agencies a ON a.id = t.agency_id
 WHERE a.name ILIKE 'capital travel%'
 ORDER BY t.type, t.title;

-- Departures named through those tours (open or upcoming, and past)
SELECT d.id, d.date, d.status, t.title
  FROM departures d
  JOIN tour_products t ON t.id = d.tour_product_id
  JOIN agencies a ON a.id = t.agency_id
 WHERE a.name ILIKE 'capital travel%'
 ORDER BY d.date;

-- Merged departures that chose CTS as operator
SELECT m.*
  FROM departure_merges m
  JOIN agencies a ON a.id = m.operator_agency_id
 WHERE a.name ILIKE 'capital travel%';

-- Catalogue dates assigned to CTS as operator
SELECT c.id, c.departure_id, c.state
  FROM catalogue_assignments c
  JOIN operators o ON o.id = c.operator_id
  JOIN agencies a ON a.id = o.agency_id
 WHERE a.name ILIKE 'capital travel%' AND c.state IN ('offered', 'acknowledged');
```

Paste the results into the PR or the ops log before you change anything.

## 2. Detach

```sql
BEGIN;

-- Tours and packages. Departures follow: they take their operator from here.
UPDATE tour_products
   SET agency_id = NULL
 WHERE agency_id IN (SELECT id FROM agencies WHERE name = 'Capital Travel Service');
-- Expect: as many rows as the tour/package list above.

-- Merged departures.
UPDATE departure_merges
   SET operator_agency_id = NULL
 WHERE operator_agency_id IN (SELECT id FROM agencies WHERE name = 'Capital Travel Service');

-- Catalogue dates: release the live assignment. The date returns to the roster
-- for a new assignment; nothing is deleted.
UPDATE catalogue_assignments
   SET state = 'replaced', replaced_at = now()
 WHERE state IN ('offered', 'acknowledged')
   AND operator_id IN (
     SELECT o.id FROM operators o JOIN agencies a ON a.id = o.agency_id
      WHERE a.name = 'Capital Travel Service');

COMMIT;
```

If a count differs from step 1, run `ROLLBACK;` instead of `COMMIT;`.

Bookings (`pledges.agency_id`), settlements and payouts are **not** touched.

## 3. Check

- The tour page (for example *Giza Pyramids, Sphinx & the Grand Egyptian Museum*) says "Run by a licensed Sawa partner".
- The step 1 tour and departure queries return no rows.
- Server-rendered pages can take up to the page cache's lifetime to change; a redeploy clears it.

## Rollback

Not automatic: re-attach each tour from the list you saved in step 1, one `UPDATE tour_products SET agency_id = '<CTS id>' WHERE id = '<tour id>';` per row.

## After this PR

The "Operating company" dropdown in Tours & Packages offers only active, publicly listed operators. CTS is pending and unlisted, so it can't be picked again, and the server refuses it too.
