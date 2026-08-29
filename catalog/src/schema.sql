-- Catalog schema (Phase 2). Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('food', 'fashion', 'electronics', 'travel')),
  -- Phase 5 trust-layer config. Defaults are the demo defaults.
  spend_limit       NUMERIC(12,2) NOT NULL DEFAULT 150.00,
  step_up_threshold NUMERIC(12,2) NOT NULL DEFAULT 100.00,
  tax_rate          NUMERIC(6,4)  NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  merchant_id  TEXT NOT NULL REFERENCES merchants(merchant_id),
  -- product_id is unique WITHIN a merchant, not globally - two merchants may
  -- both have a "prod_001". The agent always queries inside one merchant.
  product_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  currency     TEXT NOT NULL DEFAULT 'USD',
  category     TEXT NOT NULL CHECK (category IN ('food', 'fashion', 'electronics', 'travel')),
  image_url    TEXT NOT NULL DEFAULT '',
  attributes   JSONB NOT NULL DEFAULT '{}'::jsonb,
  availability BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, product_id)
);
