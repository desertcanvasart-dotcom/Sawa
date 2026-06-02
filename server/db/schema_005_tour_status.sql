-- Dashboard: allow tours/packages to be archived (hidden) without deletion.
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
