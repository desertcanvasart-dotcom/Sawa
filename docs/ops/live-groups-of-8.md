# Maximum group of 8 on the live site (production)

Decided 29 Sep 2026: the maximum group is **8 travelers** (the standard 14-seat vehicle, with spare seats kept for luggage). This covers every live tour, date and page. Groups larger than 8 are a special arrangement, not bookable online.

**Not run by Claude.** Nothing here has been run against production. Deploy the code, then apply migration 062 by hand:

```
DATABASE_URL=<production> npm run db:migrate
```

Migration 062 (`server/db/schema_062_groups_of_eight.sql`) is idempotent and changes only:

- `tour_products.max_seats` above 8 becomes 8 (every live tour);
- `departures.max_seats` above 8 becomes 8, except a date that already holds more than 8: it becomes exactly as large as it is (full, no more bookings) and **every booking stays**. Dates sold through the catalogue are left alone;
- `price_tiers` rows for a group larger than 8 are dropped (the price grid shows 4 to 8). The other rows keep their prices;
- a new `group_requests` table for the special-arrangement requests.

Until 062 is applied, the code already refuses to save a tour above 8, and the copy says 8, but existing rows still carry 12.

## 1. Before: list what the migration will touch (read-only)

```sql
-- Tours above 8
SELECT id, title, max_seats FROM tour_products WHERE max_seats > 8 ORDER BY title;

-- Live dates that ALREADY hold more than 8 booked: for you to handle.
SELECT d.id, d.route, d.date, d.status, SUM(p.seats) AS booked, d.max_seats
  FROM departures d JOIN pledges p ON p.departure_id = d.id AND p.status <> 'cancelled'
 WHERE d.status NOT IN ('cancelled', 'closed')
 GROUP BY d.id HAVING SUM(p.seats) > 8
 ORDER BY d.date;

-- Tours whose price grid has rows above 8 (they are trimmed)
SELECT id, title, price_tiers FROM tour_products
 WHERE price_tiers IS NOT NULL AND jsonb_typeof(price_tiers) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(price_tiers) e WHERE (e->>'seats')::int > 8);
```

Keep the second result: those dates are not changed, moved or cancelled by any of this.

## 2. After: check

```sql
SELECT count(*) FROM tour_products WHERE max_seats > 8;   -- 0
SELECT count(*) FROM departures d
 WHERE d.max_seats > 8
   AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id)
   AND d.max_seats > (SELECT COALESCE(SUM(p.seats), 0) FROM pledges p WHERE p.departure_id = d.id AND p.status <> 'cancelled');  -- 0
```

## 3. Requests for groups larger than 8

A traveler entering more than 8 on the tour page or the widget is shown "Groups of more than 8: request a special arrangement". The request goes to the operations inbox (`OPS_EMAIL`) and to **Group requests** in the admin, with the traveler's name, email, group size, date and tour. No booking is made and no seat is held.

## Rollback

`server/db/down/schema_062_groups_of_eight.down.sql` drops the request table. The old maximum values are not restored: raise a tour's maximum in the editor (up to 8). To see what production held before, save the results of step 1.
