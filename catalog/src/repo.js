// Database operations for merchants and products.

import { query } from "./db.js";
import { generateProductId } from "./normalize.js";

function toMerchant(row) {
  return {
    merchant_id: row.merchant_id,
    name: row.name,
    category: row.category,
    spend_limit: Number(row.spend_limit),
    step_up_threshold: Number(row.step_up_threshold),
    tax_rate: Number(row.tax_rate),
  };
}

function toProduct(row) {
  return {
    product_id: row.product_id,
    merchant_id: row.merchant_id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    currency: row.currency,
    category: row.category,
    image_url: row.image_url,
    attributes: row.attributes ?? {},
    availability: row.availability,
  };
}

export async function upsertMerchant(m) {
  const { rows } = await query(
    `INSERT INTO merchants (merchant_id, name, category, spend_limit, step_up_threshold, tax_rate)
     VALUES ($1, $2, $3, COALESCE($4::numeric, 150.00), COALESCE($5::numeric, 100.00), COALESCE($6::numeric, 0))
     ON CONFLICT (merchant_id) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       spend_limit = EXCLUDED.spend_limit,
       step_up_threshold = EXCLUDED.step_up_threshold,
       tax_rate = EXCLUDED.tax_rate
     RETURNING *`,
    [
      m.merchant_id,
      m.name,
      m.category,
      m.spend_limit ?? null,
      m.step_up_threshold ?? null,
      m.tax_rate ?? null,
    ],
  );
  return toMerchant(rows[0]);
}

export async function getMerchant(merchant_id) {
  const { rows } = await query(`SELECT * FROM merchants WHERE merchant_id = $1`, [merchant_id]);
  return rows[0] ? toMerchant(rows[0]) : null;
}

/**
 * Upsert a batch of normalized products (keyed on product_id). Missing ids are
 * generated. Returns counts of inserted vs updated rows.
 */
export async function upsertProducts(products) {
  let inserted = 0;
  let updated = 0;
  for (const p of products) {
    const id = p.product_id || generateProductId();
    const { rows } = await query(
      `INSERT INTO products
         (product_id, merchant_id, name, description, price, currency, category, image_url, attributes, availability)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (merchant_id, product_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         currency = EXCLUDED.currency,
         category = EXCLUDED.category,
         image_url = EXCLUDED.image_url,
         attributes = EXCLUDED.attributes,
         availability = EXCLUDED.availability,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        id,
        p.merchant_id,
        p.name,
        p.description,
        p.price,
        p.currency,
        p.category,
        p.image_url,
        JSON.stringify(p.attributes ?? {}),
        p.availability,
      ],
    );
    if (rows[0].inserted) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}

export async function listProducts(merchant_id) {
  const { rows } = await query(
    `SELECT * FROM products WHERE merchant_id = $1 ORDER BY product_id`,
    [merchant_id],
  );
  return rows.map(toProduct);
}

// --- Phase 3: embeddings ------------------------------------------------

export async function upsertEmbedding({ merchant_id, product_id, model, dim, vector }) {
  await query(
    `INSERT INTO product_embeddings (merchant_id, product_id, model, dim, vector)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (merchant_id, product_id) DO UPDATE SET
       model = EXCLUDED.model,
       dim = EXCLUDED.dim,
       vector = EXCLUDED.vector,
       updated_at = now()`,
    [merchant_id, product_id, model, dim, JSON.stringify(vector)],
  );
}

/** @returns {Promise<{ product_id: string, model: string, vector: number[] }[]>} */
export async function getEmbeddingRows(merchant_id) {
  const { rows } = await query(
    `SELECT product_id, model, vector FROM product_embeddings WHERE merchant_id = $1`,
    [merchant_id],
  );
  return rows;
}
