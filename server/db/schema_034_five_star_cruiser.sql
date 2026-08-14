-- 034: say that the Nile cruiser is five-star, on the packages that omit it.
--
-- The cruise is ALWAYS five-star. Sawa does not use a four-star cruiser at any
-- price, and the hotel-tier supplement buys hotel nights only — the boat is the
-- same on every tier.
--
-- Until 033 the tier labels were the only place a standard was stated, and they
-- stated it WRONGLY: "5★ cruise" / "deluxe cruise" / "luxury cruise" read as
-- though the boat upgraded with the hotel. Removing that was right. Leaving
-- nothing in its place was not: on the nine-day package the only "five-star"
-- words left on the page are two hotel tier names, so a traveller choosing
-- "Four-star" is told nothing about the boat at all.
--
-- "Nile Majesty" already says it properly — "4 nights aboard a five-star Nile
-- cruiser (full board)". This gives the other two the same sentence, in the same
-- words, on the client's instruction.
--
-- INCLUSIONS, not tier labels. A tier label describes what VARIES between tiers;
-- the cruiser does not vary, so stating it there would re-create the implication
-- 033 removed. It belongs with the other things every traveller gets.
--
-- One rule covers both packages because both phrase it the same way:
--
--   "4 nights Cairo hotel and 4 nights Nile cruise (full board)"
--   "4 nights Cairo hotel, 1 night Aswan, 3 nights Nile cruise (full board), 3 nights Hurghada"
--
-- Both contain "nights Nile cruise (full board)", and the surrounding text —
-- which differs, and includes Aswan and Hurghada nights — is preserved because
-- only that fragment is replaced.
--
-- Idempotent, and guarded for migrate.js's reason: every file re-runs on every
-- invocation. After this runs the phrase is gone, so it matches nothing. It
-- cannot touch "Nile Majesty" even on the first run — that row already says
-- "aboard a five-star Nile cruiser" and never contained the old fragment.
UPDATE tour_products
   SET included = (
     SELECT jsonb_agg(
              to_jsonb(
                replace(e,
                        'nights Nile cruise (full board)',
                        'nights aboard a five-star Nile cruiser (full board)')
              )
              ORDER BY ord
            )
       FROM jsonb_array_elements_text(included) WITH ORDINALITY AS a(e, ord)
   )
 WHERE type = 'package'
   AND jsonb_typeof(included) = 'array'
   AND included::text LIKE '%nights Nile cruise (full board)%';

-- The same sentence again, in overview_html.
--
-- "Egypt End to End" repeats its inclusions as prose in the rich overview, so
-- the phrase lives in TWO columns on that row. Updating `included` alone leaves
-- the page saying "3 nights Nile cruise (full board)" a few paragraphs above the
-- corrected list — the two halves of one page disagreeing about the same trip,
-- which is worse than neither being fixed.
--
-- Found by grepping the served payload rather than by reading the inclusions,
-- which is the only way this was ever going to surface.
--
-- Plain `replace` on the fragment, so the differing tails are preserved: the
-- overview reads "…(full board) and 3 nights Hurghada" where the inclusions read
-- "…(full board), 3 nights Hurghada".
UPDATE tour_products
   SET overview_html = replace(overview_html,
                               'nights Nile cruise (full board)',
                               'nights aboard a five-star Nile cruiser (full board)')
 WHERE type = 'package'
   AND overview_html LIKE '%nights Nile cruise (full board)%';
