// CSV onboarding path (Phase 2, step 1).
//
// Header row required, any order. Columns are mapped onto the canonical Product
// fields by `header-map.js` (case / spacing insensitive, common aliases like
// SKU / Product_Name / Selling_Price recognised); unknown columns become
// attributes. Multi-valued attributes (size, color) are `|`- or `,`-separated.

import { parse } from "csv-parse/sync";
import { detectMapping, mapRow } from "./header-map.js";
import { normalizeProduct, generateProductId } from "./normalize.js";

function parseRows(csvText) {
  return parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

/**
 * @param {string} csvText
 * @param {{ merchant_id: string, category?: string, overrides?: Record<string,string> }} ctx
 * @returns {{ products: object[], errors: { row: number, message: string }[] }}
 */
export function parseProductsCsv(csvText, ctx) {
  let rows;
  try {
    rows = parseRows(csvText);
  } catch (err) {
    return { products: [], errors: [{ row: 0, message: `CSV parse failed: ${err.message}` }] };
  }

  const overrides = ctx.overrides ?? {};
  const products = [];
  const errors = [];
  rows.forEach((row, i) => {
    try {
      const product = normalizeProduct(mapRow(row, overrides), ctx);
      if (!product.product_id) product.product_id = generateProductId();
      products.push(product);
    } catch (err) {
      errors.push({ row: i + 2, message: err.message }); // +2: header row + 1-indexing
    }
  });
  return { products, errors };
}

/**
 * Non-persisting preview for the dashboard's "map columns" step: the detected
 * column mapping, a sample of normalised products, and per-row errors.
 * @param {string} csvText
 * @param {{ merchant_id: string, category?: string, overrides?: Record<string,string> }} ctx
 */
export function previewProductsCsv(csvText, ctx) {
  let rows;
  try {
    rows = parseRows(csvText);
  } catch (err) {
    return { mapping: [], sample: [], ready: 0, skipped: 0, total: 0, errors: [{ row: 0, message: `CSV parse failed: ${err.message}` }] };
  }
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const mapping = detectMapping(headers, ctx.overrides ?? {});
  const { products, errors } = parseProductsCsv(csvText, ctx);
  return {
    mapping,
    sample: products.slice(0, 5),
    ready: products.length,
    skipped: errors.length,
    total: rows.length,
    errors: errors.slice(0, 12),
  };
}
