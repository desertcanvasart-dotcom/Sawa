-- Booking codes are the only credential on the public /booking lookup
-- (GET /api/public/bookings/:code), which matches case-insensitively. Two
-- pledges sharing a code therefore means one traveller can pull up the other's
-- tour, date, seats and status — and the lookup was a full table scan besides.
--
-- The old generator produced 5 characters from Math.random(); any duplicates it
-- already created are re-suffixed below so the unique index can be built. A
-- duplicate is already broken (only one of the pair was ever reachable), so
-- rewriting the older row's code loses nothing that worked.
UPDATE pledges p
   SET booking_code = p.booking_code || '-' || substr(md5(p.id), 1, 4)
 WHERE p.booking_code IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM pledges q
      WHERE q.id <> p.id
        AND UPPER(q.booking_code) = UPPER(p.booking_code)
        AND q.created_at > p.created_at
   );

-- Unique on UPPER(...) so it both enforces case-insensitive uniqueness and
-- serves the lookup's UPPER(booking_code) = UPPER($1) predicate. NULLs are
-- exempt, so agency pledges (which carry no code) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pledges_booking_code_upper
    ON pledges (UPPER(booking_code));
