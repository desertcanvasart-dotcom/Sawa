# Did any legacy settlement money go to Capital Travel Service after 1 Aug 2026?

**Read-only.** Every query below only reads. Run them in the Supabase SQL editor on the production project, **one at a time**: the editor shows only the last statement's result. None of them has been run.

## How money reached Capital Travel Service in the old module

The old Settlements module (migrations 044 to 046) shares each departure's gross profit:
- **10% to Sawa**;
- **90% to the agencies, by headcount of paid travelers**.

Two routes gave Capital Travel Service (CTS) a share:
- **its own bookings** (`pledges.agency_id` = its id);
- **direct bookings.** Until #226 was deployed, a traveler who booked directly (no agency, no widget code) counted for the company named by `DIRECT_BOOKINGS_OPERATOR`, and the default was "Capital Travel Service". If Railway still sets that variable, it still does.

A share is:
- **calculated** when a Wednesday run is built (`payout_lines`);
- **approved** with the run (`payout_runs.state = 'approved'`);
- **paid** when the transfer is marked paid (`payout_transfers.state = 'paid'`, with the bank reference).

Sawa's own adjustments for an agency sit in `settlement_adjustments`.

"Since 1 Aug 2026" means a departure that ended on or after 1 Aug 2026, or a run paid on or after that day.

## 0. CTS's id

```sql
SELECT id, name FROM agencies WHERE name ILIKE 'capital travel%';
```

The queries below find it by its exact name. If this returns a different spelling, change the name in their first line.

## 1. Every share calculated for CTS: the departure, the amount, the run and whether it was paid

```sql
WITH cts AS (SELECT id FROM agencies WHERE name = 'Capital Travel Service')
SELECT d.id AS departure_id, d.route, COALESCE(d.start_date, d.date) AS departure_date, d.status AS departure_status,
       l.amount AS share_eur, l.detail->>'seats' AS seats_counted, l.detail->>'pct' AS share_of_headcount,
       r.id AS run_id, r.pay_date, r.state AS run_state, r.approved_at,
       t.state AS transfer_state, t.paid_at AS transfer_paid_at, t.bank_reference
  FROM payout_lines l
  JOIN payout_runs r ON r.id = l.run_id
  JOIN departures d ON d.id = l.departure_id
  LEFT JOIN payout_transfers t ON t.run_id = r.id AND t.agency_id = l.agency_id
 WHERE l.agency_id IN (SELECT id FROM cts)
   AND (COALESCE(d.end_date, d.start_date, d.date) >= DATE '2026-08-01' OR r.pay_date >= DATE '2026-08-01')
 ORDER BY r.pay_date, d.id;
```

How to read it:
- `run_state = 'draft'`: calculated, not approved.
- `run_state = 'approved'` with `transfer_state = 'due'`: approved, **not yet sent**.
- `transfer_state = 'paid'`: **sent**, on `transfer_paid_at`, with `bank_reference`.
- `seats_counted` includes the direct travelers attributed to CTS.

## 2. The money actually sent to CTS (one transfer per run)

```sql
WITH cts AS (SELECT id FROM agencies WHERE name = 'Capital Travel Service')
SELECT r.pay_date, t.amount AS transfer_eur, t.state, t.paid_at, t.bank_reference, t.paid_by
  FROM payout_transfers t JOIN payout_runs r ON r.id = t.run_id
 WHERE t.agency_id IN (SELECT id FROM cts) AND r.pay_date >= DATE '2026-08-01'
 ORDER BY r.pay_date;
```

The total of the `paid` rows is what left Sawa for CTS since 1 Aug 2026.

## 3. Sawa's adjustments in CTS's favor (or against it)

```sql
WITH cts AS (SELECT id FROM agencies WHERE name = 'Capital Travel Service')
SELECT a.created_at, d.id AS departure_id, d.route, COALESCE(d.start_date, d.date) AS departure_date, a.amount, a.reason, a.created_by
  FROM settlement_adjustments a JOIN departures d ON d.id = a.departure_id
 WHERE a.agency_id IN (SELECT id FROM cts) AND (a.created_at >= DATE '2026-08-01' OR COALESCE(d.end_date, d.start_date, d.date) >= DATE '2026-08-01')
 ORDER BY a.created_at;
```

## 4. Departures where CTS would be given a share not yet in any run

Shares are calculated when a run is built, so a departure that went ahead but hasn't been in a run yet has no `payout_lines` row. This lists legacy departures since 1 Aug 2026 that went ahead with CTS bookings or direct bookings, and whether each has been in an approved run.

```sql
WITH cts AS (SELECT id FROM agencies WHERE name = 'Capital Travel Service')
SELECT d.id AS departure_id, d.route, COALESCE(d.start_date, d.date) AS departure_date, d.status AS departure_status,
       SUM(p.seats) FILTER (WHERE p.agency_id IN (SELECT id FROM cts)) AS cts_booked_seats,
       SUM(p.seats) FILTER (WHERE (p.agency_id IS NULL OR p.agency_id = 'direct_customer') AND p.ref_code IS NULL) AS direct_seats,
       (SELECT COALESCE(SUM(b.amount), 0) FROM booking_payments b JOIN pledges pp ON pp.id = b.pledge_id
         WHERE pp.departure_id = d.id AND b.state = 'paid') AS collected_eur,
       EXISTS (SELECT 1 FROM payout_lines l JOIN payout_runs r ON r.id = l.run_id
                WHERE l.departure_id = d.id AND r.state = 'approved') AS paid_out_in_a_run
  FROM departures d JOIN pledges p ON p.departure_id = d.id AND p.status <> 'cancelled'
 WHERE COALESCE(d.end_date, d.start_date, d.date) >= DATE '2026-08-01'
   AND d.status IN ('minimum_reached', 'supplier_confirmed')
   AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id)
 GROUP BY d.id
HAVING SUM(p.seats) FILTER (WHERE p.agency_id IN (SELECT id FROM cts)) > 0
    OR SUM(p.seats) FILTER (WHERE (p.agency_id IS NULL OR p.agency_id = 'direct_customer') AND p.ref_code IS NULL) > 0
 ORDER BY departure_date;
```

- A row with `paid_out_in_a_run = false` and `collected_eur` above 0 would give CTS a share in the next Wednesday run, **if**:
  - it has CTS bookings, or
  - it has direct bookings and `DIRECT_BOOKINGS_OPERATOR` still names CTS in Railway.
- After #226, with the variable unset, direct travelers count for no agency, and their share stays with Sawa.
- Catalog departures are left out: they are never settled in the old module (#229 excludes them).

## If something was paid that shouldn't have been

Nothing here changes data. For a transfer that shouldn't have gone out, the old module has no reversal. Record it as a negative `settlement_adjustments` row against CTS on that departure, with the reason, and recover it outside the platform. Tell me what you find first, and I'll write the exact statement.
