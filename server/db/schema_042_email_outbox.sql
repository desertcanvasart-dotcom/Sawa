-- 042: email_log becomes an outbox (O01).
--
-- Booking receipts and ops notices were sent by a background promise after the
-- booking committed. A Resend outage, a timeout or a process restart in that
-- window lost the email for good: email_log recorded "failed", but not the
-- message, so nothing could send it again.
--
-- Each email is now written here, WITH its content, before it is sent, and a
-- scheduled job (retryPendingEmails in server/email.js) re-sends the ones that
-- failed or were left mid-send. Resend's Idempotency-Key (the row id) makes a
-- repeat of a send that actually succeeded harmless.
--
-- Additive and nullable: rows written before this keep working, and the code
-- falls back to the old log-only insert until this is applied.
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS html            TEXT;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS text_body       TEXT;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS attempts        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ;

-- The retry job reads only undelivered rows.
CREATE INDEX IF NOT EXISTS idx_email_log_retry
  ON email_log (next_attempt_at)
  WHERE status IN ('pending', 'failed');
