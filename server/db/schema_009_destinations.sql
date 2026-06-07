-- Tourist-facing destinations, each owning its meeting points.
-- meeting_points: [{ "point": "<location>", "note": "<be there by / departs ...>" }]
CREATE TABLE IF NOT EXISTS destinations (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  meeting_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the three current destinations with their known meeting points.
INSERT INTO destinations (name, sort_order, meeting_points) VALUES
  ('Cairo', 1, '[
     {"point":"In front of the Egyptian Museum (Tahrir)","note":"Be there by 8:00 AM at the latest"},
     {"point":"In front of Marriott Mena House, Giza","note":"Be there by 8:45 AM at the latest"}
   ]'::jsonb),
  ('Luxor', 2, '[
     {"point":"In front of Steigenberger Resort Achti, Luxor (formerly Etap)","note":"East Bank tour — departs 8:30 AM"},
     {"point":"In front of Steigenberger Resort Achti, Luxor (formerly Etap)","note":"West Bank tour — departs 7:30 AM"},
     {"point":"In front of Steigenberger Resort Achti, Luxor (formerly Etap)","note":"Dendera, Abydos or Aswan — departs 7:15 AM"}
   ]'::jsonb),
  ('Aswan', 3, '[
     {"point":"Coptic Orthodox Cathedral of the Archangel Michael, Aswan","note":"Aswan day tour — departs 8:30 AM"},
     {"point":"Coptic Orthodox Cathedral of the Archangel Michael, Aswan","note":"Abu Simbel or Luxor — departs 6:30 AM"}
   ]'::jsonb)
ON CONFLICT (name) DO NOTHING;
