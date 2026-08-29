-- Phase 5 trust and consent audit trail. Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS checkout_audit_log (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  cart_id               TEXT NOT NULL,
  -- The merchant this row is about (one row per merchant charge), or NULL for a
  -- whole-checkout block / cancel.
  merchant_id           TEXT,
  cart_snapshot         JSONB NOT NULL,
  amount_shown_to_user  NUMERIC(12,2) NOT NULL,
  confirmation_action   TEXT NOT NULL CHECK (confirmation_action IN ('confirm', 'cancel')),
  charge_response       JSONB,
  resulting_status      TEXT NOT NULL CHECK (resulting_status IN ('approved', 'declined', 'blocked')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE checkout_audit_log ADD COLUMN IF NOT EXISTS merchant_id TEXT;

CREATE INDEX IF NOT EXISTS checkout_audit_session_created_idx
  ON checkout_audit_log (session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS checkout_audit_merchant_created_idx
  ON checkout_audit_log (merchant_id, created_at DESC);
