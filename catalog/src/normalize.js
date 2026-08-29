// Turn whatever a merchant provides (a CSV row, an LLM-extracted object) into
// one normalized product - the canonical `@cca/contracts` Product shape.

import { randomBytes } from "node:crypto";
import { CATEGORIES, isCategory, arrayAttributes } from "./categories.js";

const CURRENCIES = new Set(["USD"]);

const CORE_KEYS = new Set([
  "product_id",
  "merchant_id",
  "name",
  "description",
  "brand",
  "price",
  "currency",
  "category",
  "image_url",
  "attributes",
  "availability",
]);

const roundMoney = (n) => Math.round(n * 100) / 100;

export const generateProductId = () => `prod_${randomBytes(6).toString("hex")}`;

function toBool(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || value === "") return fallback;
  const s = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["true", "t", "yes", "y", "1", "in_stock", "instock", "available", "low_stock", "limited_stock", "limited", "backorder", "back_order", "preorder", "pre_order", "active", "live", "enabled", "published"].includes(s)) return true;
  if (["false", "f", "no", "n", "0", "out_of_stock", "outofstock", "unavailable", "sold_out", "soldout", "discontinued", "inactive", "hidden", "draft", "archived", "disabled"].includes(s)) return false;
  return fallback;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return String(value)
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalize one raw product. Returns the canonical object (with `product_id`
 * only if the raw input carried one). Throws Error with a readable, joined
 * message listing every problem with the row.
 *
 * @param {Record<string, unknown>} raw
 * @param {{ merchant_id: string, category?: string }} ctx
 */
export function normalizeProduct(raw, ctx) {
  const { merchant_id } = ctx;
  const errors = [];

  const name = String(raw.name ?? "").trim();
  if (!name) errors.push("name is required");

  const priceNum = Number(raw.price);
  if (!Number.isFinite(priceNum) || priceNum < 0)
    errors.push(`price must be a non-negative number (got ${JSON.stringify(raw.price)})`);

  const category = String(raw.category ?? ctx.category ?? "").trim().toLowerCase();
  if (!isCategory(category))
    errors.push(`category must be one of ${CATEGORIES.join(", ")} (got ${JSON.stringify(category)})`);

  const currency = String(raw.currency ?? "USD").trim().toUpperCase();
  if (!CURRENCIES.has(currency)) errors.push(`currency must be USD (got ${currency})`);

  if (errors.length) throw new Error(errors.join("; "));

  const listKeys = arrayAttributes(category);
  const attributes = {};
  const merge = (key, value) => {
    if (value === "" || value === null || value === undefined) return;
    attributes[key] = listKeys.has(key) ? splitList(value) : value;
  };

  if (raw.attributes && typeof raw.attributes === "object") {
    for (const [k, v] of Object.entries(raw.attributes)) merge(k, v);
  }
  // Any non-core column (e.g. `size`, `color` in the CSV) becomes an attribute.
  for (const [k, v] of Object.entries(raw)) {
    if (!CORE_KEYS.has(k)) merge(k, v);
  }

  const product = {
    merchant_id,
    name,
    description: String(raw.description ?? "").trim(),
    brand: String(raw.brand ?? "").trim(),
    price: roundMoney(priceNum),
    currency,
    category,
    image_url: String(raw.image_url ?? "").trim(),
    attributes,
    availability: toBool(raw.availability, true),
  };

  const providedId = String(raw.product_id ?? "").trim();
  if (providedId) product.product_id = providedId;
  return product;
}
