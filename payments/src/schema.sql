-- Mock Visa payment service schema (Phase 1).
-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS payment_tokens (
  token       TEXT PRIMARY KEY,
  user_ref    TEXT NOT NULL,
  card_last4  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL REFERENCES payment_tokens(token),
  merchant_id    TEXT NOT NULL,
  amount         NUMERIC(12,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  status         TEXT NOT NULL CHECK (status IN ('approved', 'declined')),
  auth_code      TEXT,
  decline_reason TEXT,
  order_ref      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency key, scoped to the merchant. A repeat charge with the same
  -- (merchant_id, order_ref) returns the original transaction instead of
  -- charging again.
  UNIQUE (merchant_id, order_ref)
);

CREATE INDEX IF NOT EXISTS transactions_merchant_created_idx
  ON transactions (merchant_id, created_at DESC);
