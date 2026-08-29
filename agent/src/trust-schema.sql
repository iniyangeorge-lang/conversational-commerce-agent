-- Phase 5 trust and consent audit trail. Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS checkout_audit_log (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  cart_id               TEXT NOT NULL,
  cart_snapshot         JSONB NOT NULL,
  amount_shown_to_user  NUMERIC(12,2) NOT NULL,
  confirmation_action   TEXT NOT NULL CHECK (confirmation_action IN ('confirm', 'cancel')),
  charge_response       JSONB,
  resulting_status      TEXT NOT NULL CHECK (resulting_status IN ('approved', 'declined', 'blocked')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_audit_session_created_idx
  ON checkout_audit_log (session_id, created_at ASC);
