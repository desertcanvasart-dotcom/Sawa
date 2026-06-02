-- Phase 5 — capture traveller email on bookings so we can send confirmations.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS customer_email TEXT;
