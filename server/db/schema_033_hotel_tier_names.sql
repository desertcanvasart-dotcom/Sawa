-- 033: the lowest hotel tier on any package is four-star.
--
-- The ladder was Standard (3★) / Superior (4★) / Luxury (5★). Sawa does not sell
-- a three-star package, so the floor moves up and the ladder is renamed to say
-- what is actually offered:
--
--   Four-star            was  Standard (3★ / 5★ cruise)      +€0
--   Five-star Standard   was  Superior (4★ / deluxe cruise)  +€180
--   Five-star Deluxe     was  Luxury (5★ / luxury cruise)    +€390
--
-- Client's instruction and wording, 14 August 2026. Hotel ratings only: the
-- cruise class is deliberately dropped from these labels, confirmed explicitly
-- rather than assumed, because it is half of what the supplements buy.
--
-- SUPPLEMENTS ARE NOT TOUCHED. This renames what is on offer; it does not
-- reprice it. If a four-star floor should cost more than the old three-star
-- floor did, that is a separate decision about `published_rate` and belongs in
-- its own change where it can be seen.
--
-- ============================================================================
-- WHY THIS MATCHES ON THE NAME AND NOT ON THE TIER ID
-- ============================================================================
--
-- The obvious version keys on `id` — standard / superior / luxury — and it is
-- wrong. "Nile Majesty" also has a single tier with id `standard`, and its name
-- is "Five-star Nile cruiser". Keyed on the id, that boat would have been
-- relabelled "Four-star": a five-star cruise advertised as one star lower, on
-- the one package where nothing needed changing at all.
--
-- So each rename names the exact string it replaces. Anything else is left
-- alone, which also makes this idempotent — migrate.js re-runs every file on
-- every invocation, and after the first run these match nothing.
--
-- ============================================================================
-- THE IDS DELIBERATELY DO NOT CHANGE
-- ============================================================================
--
-- `pledges.accommodation_tier` stores the tier id a traveller chose. Renaming
-- `superior` to `five_star_standard` would orphan every booking that pointed at
-- it — the row would keep a value no tier answers to, and the booking would
-- render with no tier at all. The id is a reference; the name is the label.
UPDATE tour_products
   SET accommodation_tiers = (
     SELECT jsonb_agg(
              CASE t->>'name'
                WHEN 'Standard (3★ / 5★ cruise)'     THEN jsonb_set(t, '{name}', '"Four-star"')
                WHEN 'Superior (4★ / deluxe cruise)' THEN jsonb_set(t, '{name}', '"Five-star Standard"')
                WHEN 'Luxury (5★ / luxury cruise)'   THEN jsonb_set(t, '{name}', '"Five-star Deluxe"')
                WHEN 'Standard (3★)'                 THEN jsonb_set(t, '{name}', '"Four-star"')
                ELSE t
              END
              ORDER BY ord
            )
       FROM jsonb_array_elements(accommodation_tiers) WITH ORDINALITY AS a(t, ord)
   )
 WHERE type = 'package'
   AND jsonb_typeof(accommodation_tiers) = 'array'
   -- Only rows that still carry one of the superseded names. Without this the
   -- statement would rewrite every package's tier array on every migrate run —
   -- a no-op in content, but it would churn rows and defeat the "expires by
   -- itself" property the other data migrations have.
   --
   -- LIKE and not SIMILAR TO: these names contain parentheses, which SIMILAR TO
   -- treats as grouping and would need escaping, with the escaping itself
   -- depending on standard_conforming_strings. LIKE has no metacharacter here
   -- but % and _, so the pattern means exactly what it looks like.
   AND (accommodation_tiers::text LIKE '%Standard (3★%'
     OR accommodation_tiers::text LIKE '%Superior (4★ / deluxe cruise)%'
     OR accommodation_tiers::text LIKE '%Luxury (5★ / luxury cruise)%');
