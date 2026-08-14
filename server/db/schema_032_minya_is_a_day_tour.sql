-- 032: "Full Day Minya Archaeological Tour from Cairo" is a day tour.
--
-- It was published as a `package` and the record contradicted itself: the title
-- said "Full Day", the duration said "1 day · 15 hours", and the type, `nights`
-- and an accommodation tier said multi-day. `type` is the one the system acts
-- on, so a fifteen-hour road trip to Minya and back was carrying every
-- commercial term of a Nile cruise:
--
--   deposit                 25% instead of 10%
--   balance due             14 days before instead of 48 hours
--   free cancellation to    30 days before instead of 48 hours
--   confirmation deadline   30 days instead of 7
--
-- The deadline was the quiet one. Seven days exists for day tours because those
-- travellers are usually already in Egypt when they book; a thirty-day deadline
-- kills dates that would have filled, and does it silently.
--
-- Confirmed a day tour by the client, 13 August 2026.
--
-- ============================================================================
-- WHY THIS IS A MIGRATION AND NOT AN ADMIN EDIT
-- ============================================================================
--
-- `type` cannot be changed in the product editor. It reads
-- `const type = existing?.type || typeProp` and then shapes the whole form from
-- it, so an existing product is locked to the type it was created with. Every
-- other field here is editable; this one is not, and it is the one that is
-- wrong.
--
-- ============================================================================
-- IT ALSO UNDOES 031 FOR THIS ROW
-- ============================================================================
--
-- 031 moved every `package` from a 20% deposit to 25%, and this row was a
-- package when it ran. Left alone it would keep a package's deposit while
-- serving a day tour's cancellation schedule — the two disagreeing on one
-- panel, which is exactly the contradiction #147 closed everywhere else.
--
-- So the deposit goes to 10, the day-tour rate. Ordering matters only in that
-- both live here: run 031 then 032 and the row ends correct either way, because
-- each statement names the value it expects to find.
--
-- Guarded on the id AND on the wrong value, for migrate.js's reason: every file
-- re-runs on every invocation, so an unguarded UPDATE would re-apply forever and
-- silently revert a later deliberate edit. Once this row is a day tour these
-- match nothing.
UPDATE tour_products
   SET type = 'day_tour',
       duration = 'Extended day · about 15 hours',
       -- Package machinery that a day tour never reads. `isPackage` gates both
       -- in the app, so they are inert rather than harmful — but a record that
       -- still claims a hotel tier is how someone later "restores" the package
       -- type believing it was the correct one.
       nights = NULL,
       accommodation_tiers = NULL,
       -- Back to the day-tour rate. 031 raised this to 25 while the row was
       -- still typed as a package.
       deposit_percent = 10
 WHERE id = 'pkg_full_day_minya_archaeological_to_msm1lioi'
   AND type = 'package';

-- Any departure that inherited the package classification. There are none
-- published today — the product has no dates — but this migration must not
-- assume that stays true between writing and running.
UPDATE departures
   SET type = 'day_tour',
       deposit_percent = 10
 WHERE tour_product_id = 'pkg_full_day_minya_archaeological_to_msm1lioi'
   AND type = 'package';

-- The id keeps its `pkg_` prefix deliberately. It is a stable key, referenced by
-- departures.tour_product_id and by any audit_log row that has ever named this
-- product; renaming it to match the corrected type would break those references
-- to make a string read better.
