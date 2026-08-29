// Column / field mapping for merchant catalog ingest.
//
// Merchants arrive with whatever headers their spreadsheet, PIM or product feed
// happens to use ("SKU", "Product_Name", "Selling Price", "Stock Status"…). This
// module maps those onto the canonical `Product` fields; anything it doesn't
// recognise becomes a lowercase-snake_case attribute (never a hard failure).
//
// Matching is case / space / underscore / hyphen insensitive. The dashboard's
// preview step shows the detected mapping and lets the merchant override it.

import { isCategory } from "./categories.js";

/** Canonical Product fields an ingest column can map to. */
export const CANONICAL_FIELDS = [
  "product_id",
  "name",
  "description",
  "brand",
  "price",
  "currency",
  "category",
  "image_url",
  "size",
  "color",
  "availability",
];

/** canonical field -> accepted source-header aliases. */
const ALIASES = {
  product_id: ["product id", "productid", "sku", "id", "item", "item no", "item number", "item id", "item code", "style", "style code", "style number", "variant id", "handle", "ref", "code"],
  name: ["name", "product name", "title", "product title", "item name", "product", "listing title"],
  description: ["description", "desc", "long description", "short description", "product description", "details", "summary", "about", "body", "body html"],
  brand: ["brand", "manufacturer", "make", "vendor", "label", "designer", "brand name"],
  price: ["price", "selling price", "sale price", "retail price", "unit price", "list price", "price usd", "amount", "rrp", "msrp", "srp", "our price", "current price"],
  currency: ["currency", "currency code", "ccy"],
  category: ["category", "product category"],
  image_url: ["image url", "image", "image link", "img", "img url", "photo", "picture", "image src", "thumbnail", "image 1", "main image", "primary image"],
  size: ["size", "sizes", "size options", "available sizes", "size range", "shoe size"],
  color: ["color", "colour", "colors", "colours", "color options", "colorway", "colourway"],
  availability: ["availability", "available", "in stock", "stock status", "status", "stock", "inventory status", "stock state"],
};

/** Columns we recognise but deliberately drop (merchant-internal, not shopper-facing). */
const IGNORED_ALIASES = new Set(
  ["cost price", "cost", "wholesale price", "buy price", "margin", "reorder level", "reorder point", "supplier", "supplier name", "warehouse", "bin", "location", "created at", "updated at", "last modified", "internal notes"].map(norm),
);

function norm(s) {
  return String(s ?? "").trim().toLowerCase().replace(/[\s_\-./]+/g, " ").trim();
}
export function snake(s) {
  return norm(s).replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "");
}

const LOOKUP = new Map();
for (const [field, aliases] of Object.entries(ALIASES)) {
  LOOKUP.set(norm(field), field);
  for (const a of aliases) LOOKUP.set(norm(a), field);
}

/** Canonical field for a source header, `"(ignore)"`, or null (=> attribute). */
export function resolveField(header) {
  const n = norm(header);
  if (LOOKUP.has(n)) return LOOKUP.get(n);
  if (IGNORED_ALIASES.has(n)) return "(ignore)";
  return null;
}

function targetFor(sourceHeader, overrides) {
  const ov = overrides[sourceHeader] ?? overrides[norm(sourceHeader)];
  if (ov === "ignore" || ov === "(ignore)") return "(ignore)";
  if (ov === "attribute" || ov === "(attribute)") return "(attribute)";
  if (ov && CANONICAL_FIELDS.includes(ov)) return ov;
  return resolveField(sourceHeader);
}

/**
 * @param {string[]} headers
 * @param {Record<string,string>} [overrides]  sourceHeader -> canonical field | "attribute" | "ignore"
 * @returns {{ source:string, target:string, kind:"field"|"attribute"|"ignored" }[]}
 */
export function detectMapping(headers, overrides = {}) {
  return headers.map((source) => {
    const t = targetFor(source, overrides);
    if (t === "(ignore)") return { source, target: "—", kind: "ignored" };
    if (t && t !== "(attribute)") return { source, target: t, kind: "field" };
    return { source, target: `attributes.${snake(source)}`, kind: "attribute" };
  });
}

/**
 * Rewrite one raw row (from CSV or a JSON feed) to canonical keys. Unknown
 * columns become lowercase-snake attributes. A `category` value that isn't a
 * real category is kept as `product_type` so the row still imports.
 * @param {Record<string, unknown>} row
 * @param {Record<string,string>} [overrides]
 */
export function mapRow(row, overrides = {}) {
  const out = {};
  const put = (k, v) => { if (k && !(k in out) && v !== "" && v != null) out[k] = v; };

  for (const [rawKey, value] of Object.entries(row)) {
    const target = targetFor(rawKey, overrides);
    if (target === "(ignore)") continue;

    if (target === "category") {
      if (isCategory(String(value).trim().toLowerCase())) put("category", value);
      else put("product_type", value); // keep the merchant's own category label as an attribute
      continue;
    }
    if (target && target !== "(attribute)") put(target, value);
    else put(snake(rawKey), value);
  }
  return out;
}
