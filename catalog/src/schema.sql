-- Catalog schema (Phase 2). Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('food', 'fashion', 'electronics', 'travel')),
  -- Merchant "go live" switch: when false the marketplace search skips this
  -- store's products (the dashboard still shows them).
  ai_enabled        BOOLEAN NOT NULL DEFAULT true,
  -- Phase 5 trust-layer config. Defaults are the demo defaults.
  spend_limit       NUMERIC(12,2) NOT NULL DEFAULT 150.00,
  step_up_threshold NUMERIC(12,2) NOT NULL DEFAULT 100.00,
  tax_rate          NUMERIC(6,4)  NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;

-- Dashboard logins. One or more users per merchant (Phase: merchant auth).
CREATE TABLE IF NOT EXISTS merchant_users (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  merchant_id  TEXT NOT NULL REFERENCES merchants(merchant_id),
  -- product_id is unique WITHIN a merchant, not globally - two merchants may
  -- both have a "prod_001". The agent always queries inside one merchant.
  product_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  brand        TEXT NOT NULL DEFAULT '',
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

-- Additive migration for existing dev databases.
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT '';

-- Phase 3: one embedding per product. Kept as JSON (not pgvector) so the
-- prototype needs no extra Postgres extension; cosine similarity runs in-process.
CREATE TABLE IF NOT EXISTS product_embeddings (
  merchant_id TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vector      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, product_id),
  FOREIGN KEY (merchant_id, product_id)
    REFERENCES products (merchant_id, product_id) ON DELETE CASCADE
);
