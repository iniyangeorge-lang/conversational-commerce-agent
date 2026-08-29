// CSV onboarding path (Phase 2, step 1).
//
// Fixed column order, header row required. Core columns map to the Product
// schema; any extra column (e.g. `size`, `color`) becomes an attribute.
// Multi-valued attribute columns are `|`-separated.

import { parse } from "csv-parse/sync";
import { normalizeProduct, generateProductId } from "./normalize.js";

/**
 * @param {string} csvText
 * @param {{ merchant_id: string, category?: string }} ctx
 * @returns {{ products: object[], errors: { row: number, message: string }[] }}
 */
export function parseProductsCsv(csvText, ctx) {
  let rows;
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    return { products: [], errors: [{ row: 0, message: `CSV parse failed: ${err.message}` }] };
  }

  const products = [];
  const errors = [];
  rows.forEach((row, i) => {
    try {
      const product = normalizeProduct(row, ctx);
      if (!product.product_id) product.product_id = generateProductId();
      products.push(product);
    } catch (err) {
      // +2: 1 for the header row, 1 for 1-indexing
      errors.push({ row: i + 2, message: err.message });
    }
  });
  return { products, errors };
}
