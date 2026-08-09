-- 023: everything that can only be captured at the moment of the write.
--
-- `pledges` has never held a row. That is the asset this migration spends, and
-- it is temporary: every field here records something that cannot be
-- reconstructed once real bookings exist, so adding them afterwards means
-- backfilling with guesses about facts that were never written down.
--
-- Approved under QQ4 with the RR-series amendments. The reasoning for each
-- field, and for the two candidates that were REJECTED by the same filter
-- (operator verification fields, anchor flags — both reconstructible at any
-- time), is in docs/audit/migration-023-proposal.md.
--
-- NOTHING WRITES TO ANY COLUMN HERE. Adding a column and adding the code that
-- fills it are separate changes; shipping them together would mean a schema
-- change and a behaviour change reviewed as one piece.
--
-- Excluded on principle: no payment schema. Not deposit state, not transaction
-- records, not refund state, not gateway identifiers. If legal question 1
-- answers that Sawa may not hold funds, that schema encodes a model which may
-- be prohibited, and schema is a statement about what a system is designed to
-- do. See QQ3.
--
-- Safe on current data, verified against production immediately before writing
-- this: `pledges` holds 0 rows, and `blog_posts` holds 1 row with status
-- 'published', which is inside the constraint below.
--
-- MIGRATIONS DO NOT RUN ON DEPLOY (B5). Run by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Why a booking ended
--
-- 'cancelled' is one value covering two different events: the traveller
-- cancelled, and the date was cancelled under them. LL3 keeps those apart on
-- the read side; without this column there is nothing behind that distinction.
-- audit_log records the DEPARTURE being cancelled, not which pledges were on it
-- at the time, so the backfill would be a guess.

ALTER TABLE pledges ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_cancelled_reason_chk') THEN
    -- NULL is the normal case: a pledge that has not been cancelled has no
    -- reason, so the constraint permits NULL and constrains only the values.
    --
    -- 'operator' is DECLARED AND UNWRITTEN. No path writes it and none should
    -- until one exists — but adding a permitted value later means altering a
    -- constraint on a table holding real rows, and declaring it now costs
    -- nothing. It must not appear in any UI until something writes it: an empty
    -- category rendered as a filter is data that renders as if real.
    ALTER TABLE pledges ADD CONSTRAINT pledges_cancelled_reason_chk
      CHECK (cancelled_reason IS NULL OR cancelled_reason IN
        ('traveler', 'date_cancelled', 'minimum_not_reached', 'admin', 'operator'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. How a booking got here — D3
--
-- A booking's origin exists for one instant. Reconstructed afterwards it is not
-- attribution, it is a guess — and the bookings that most need it are the
-- earliest ones, because they are the evidence the content programme works
-- before there is enough volume to see it in aggregate.
--
-- `ref_code` (011) and `source` already exist and answer different questions:
-- which partner widget, and how the row was created. Neither answers "which
-- article sent this person".
--
-- ⚠️ These are behavioural data about an identified person. The columns may
-- exist; the WRITES may not land until the privacy notice describes the
-- processing (RR3). The blocker is TRANSPARENCY, not consent — recording how
-- someone reached the booking they made is incidental to the transaction;
-- emailing them afterwards is what needs consent. Do not gate this behind
-- marketing_consent.

ALTER TABLE pledges ADD COLUMN IF NOT EXISTS origin_article   TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS first_touch_at   TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS first_touch_path TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS last_touch_at    TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS last_touch_path  TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS referral_source  TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS referral_brand   TEXT;

-- Deliberately NO foreign key to blog_posts. An article can be deleted or its
-- slug changed, and losing a real booking's attribution because a post was
-- renamed is worse than a dangling reference. The slug is recorded as the
-- historical fact it is.
--
-- referral_brand is free text, not an enum: the brand list is a commercial fact
-- that changes without a migration, and a CHECK would make adding a sister
-- brand a database change.
CREATE INDEX IF NOT EXISTS idx_pledges_origin_article ON pledges(origin_article);
CREATE INDEX IF NOT EXISTS idx_pledges_first_touch    ON pledges(first_touch_at);

-- ---------------------------------------------------------------------------
-- 3. Consent — QQ2.2
--
-- Same property as cancelled_reason: it exists only at the moment of the write.
-- Added afterwards, consent cannot be proven for existing rows and the early
-- alerts list — the one the content programme depends on — becomes unmailable.
--
-- These gate MARKETING and nothing else. Attribution has a different basis and
-- a different blocker; see above.

-- NULLABLE, WITH NO DEFAULT, deliberately. Three states are needed and must not
-- collapse: given, refused, and never asked. DEFAULT false would turn every row
-- into a refusal nobody made — a different claim from having no record. Same
-- discipline as PP2's loud zero.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS marketing_consent      BOOLEAN;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS marketing_consent_at   TIMESTAMPTZ;
-- The exact wording shown at the moment of consent. This is the genuinely
-- unrecoverable part: proving consent means proving WHAT was agreed to, and the
-- copy will change.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS marketing_consent_text TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS lawful_basis           TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_lawful_basis_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_lawful_basis_chk
      CHECK (lawful_basis IS NULL OR lawful_basis IN ('consent', 'contract', 'legitimate_interest'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. blog_posts.status — CONSTRAINT HARDENING, not empty-window capture
--
-- Labelled deliberately. This fails the empty-window test: nothing is captured
-- and the constraint could be added at any time. Its argument is different and
-- weaker, and recording it under the right one matters — a correct change filed
-- under the wrong justification is how the next person derives "the empty
-- window justifies schema" instead of "a constraint gets harder to add as rows
-- accumulate".
--
-- The column is unconstrained today, which is why 'published' and 'draft' sit
-- in scripts/check-status-literals.js as APPLICATION_ONLY exceptions — every
-- entry in that list is a place the schema is not the authority.
--
-- Production holds one row, status 'published'. Safe now; riskier with every
-- post written.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_status_chk') THEN
    ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_status_chk
      CHECK (status IN ('draft', 'published'));
  END IF;
END $$;
