-- 041: restore the Cairo & Luxor four-day package that was present in the
-- repository catalogue but absent from the production catalogue.
--
-- The public URL and slug are derived from the title, so a missing row made
-- /package/cairo-luxor-4-day-discovery a real 404.  This insert is deliberately
-- create-only: an operator's existing live record always wins, and re-running
-- the migration cannot overwrite later editorial or pricing changes.
INSERT INTO tour_products
  (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
   min_seats, max_seats, base_cost, published_rate, break_price, quality,
   deposit_percent, description, included, not_included, itinerary,
   accommodation_tiers, overview_html, status)
VALUES
  (
    'pkg_cairo_luxor_4d',
    'package',
    'Cairo and Luxor 4-day discovery',
    'Cairo',
    '["Cairo", "Luxor"]'::jsonb,
    3,
    '4 days · 3 nights',
    '08:00',
    'Licensed Egyptologist',
    'Private van + domestic flight',
    4,
    12,
    780,
    540,
    460,
    4.8,
    25,
    'Cairo highlights and Luxor temples in four days with a domestic flight and shared guided program.',
    '["3 nights hotel with breakfast", "Domestic flight Cairo → Luxor", "Licensed Egyptologist guide at all sites", "All ground transport and airport transfers"]'::jsonb,
    '["International flights", "Entrance tickets", "Lunches and dinners", "Visa and travel insurance"]'::jsonb,
    '[{"day":1,"city":"Cairo","title":"Arrival and Old Cairo","description":"Airport pickup, hotel check-in, evening walk in Khan el-Khalili.","meals":"—"},{"day":2,"city":"Cairo","title":"Pyramids and Egyptian Museum","description":"Giza Plateau in the morning, Egyptian Museum after lunch.","meals":"Breakfast"},{"day":3,"city":"Luxor","title":"Fly to Luxor, East Bank","description":"Morning flight to Luxor, Karnak and Luxor Temple in the afternoon.","meals":"Breakfast"},{"day":4,"city":"Luxor","title":"West Bank and departure","description":"Valley of the Kings and Hatshepsut, then evening flight back to Cairo.","meals":"Breakfast"}]'::jsonb,
    '[{"id":"standard","name":"Four-star","perPersonSupplement":0,"singleSupplement":90},{"id":"superior","name":"Five-star Standard","perPersonSupplement":120,"singleSupplement":160},{"id":"luxury","name":"Five-star Deluxe","perPersonSupplement":280,"singleSupplement":320}]'::jsonb,
    '<p>Discover Cairo and Luxor in four carefully planned days. Explore Old Cairo, the Giza Plateau and the Egyptian Museum, then fly south for Karnak, Luxor Temple, the Valley of the Kings and Hatshepsut''s temple.</p><p>The package includes three hotel nights, the domestic flight from Cairo to Luxor, a licensed Egyptologist guide and all ground transfers.</p>',
    'approved'
  )
ON CONFLICT (id) DO NOTHING;
