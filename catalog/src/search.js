// search_products (Phase 3, refined) - the single function the agent calls as a tool.
//
// Contract: @cca/contracts -> SearchProductsParams / SearchProductsResponse.
//
// Pipeline:
//   1. Pull candidates (one merchant, or the whole marketplace when merchant_id is null).
//   2. HARD FILTERS (boolean keep/drop): category, max_price, availability, brand,
//      attribute-contains (size/color/activity/cushioning/width/closure/support/...),
//      numeric ranges (drop_mm, weight_g), waterproof, and `exclude`.
//   3. RANK the survivors with a blended score:
//        0.55 * cosine(query, product doc vector)
//      + 0.20 * title-token overlap
//      + 0.20 * profile match (priorities / required_features / primary_use)
//      + 0.05 * price headroom (prefer comfortably under budget)
//      The product doc vector is itself a weighted blend of per-field vectors
//      (0.5 title + 0.3 description + 0.2 facets) - see embeddings.js.
//      Empty query -> skip embeddings, browse cheapest-first.
//   4. Return the top 5, each with its `score`.

import { cosine, getEmbedder, l2normalize } from "./embedder.js";
import { backfillEmbeddings } from "./embeddings.js";
import { getEmbeddingRows, listProducts } from "./repo.js";

const TOP_N = 5;
const TEXT_ATTR_KEYS = ["size", "color", "dietary", "material", "activity", "cushioning", "width", "closure", "support"];
const RANGE_ATTR_KEYS = ["drop_mm", "weight_g"];
const vecKey = (p) => `${p.merchant_id} ${p.product_id}`;

const STOP = new Set("a an the of for and or with to in on at by from is are be this that it your you our".split(" "));
const words = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

const TRUTHY = new Set(["true", "t", "yes", "y", "1", "waterproof"]);
const isTruthy = (v) => v === true || TRUTHY.has(String(v ?? "").trim().toLowerCase());

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase());
  if (v === null || v === undefined) return [];
  return [String(v).toLowerCase()];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function passesFilters(product, ctx) {
  if (ctx.category && product.category !== ctx.category) return false;
  if (ctx.max_price != null && product.price > ctx.max_price) return false;
  if (ctx.available_only && !product.availability) return false;
  if (ctx.brand && !String(product.brand ?? "").toLowerCase().includes(ctx.brand)) return false;
  if (ctx.waterproof === true && !isTruthy(product.attributes?.waterproof)) return false;
  if (ctx.waterproof === false && isTruthy(product.attributes?.waterproof)) return false;

  for (const [key, wanted] of Object.entries(ctx.attrs)) {
    const have = toList(product.attributes?.[key]);
    if (!toList(wanted).every((w) => have.includes(w))) return false;
  }
  for (const [key, range] of Object.entries(ctx.ranges)) {
    const n = num(product.attributes?.[key]);
    if (n === undefined) return false;
    if (range.min != null && n < range.min) return false;
    if (range.max != null && n > range.max) return false;
  }
  for (const [key, vals] of Object.entries(ctx.exclude)) {
    const have = toList(product.attributes?.[key]);
    if (toList(vals).some((v) => have.includes(v))) return false;
  }
  return true;
}

// --- ranking terms ---------------------------------------------------

function titleOverlap(queryTokens, name) {
  if (!queryTokens.length) return 0;
  const nameTokens = new Set(words(name));
  return queryTokens.filter((t) => nameTokens.has(t)).length / queryTokens.length;
}

function profileMatch(product, hints) {
  const terms = [
    ...(hints.priorities ?? []),
    ...(hints.required_features ?? []),
    hints.primary_use,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().trim());
  if (!terms.length) return 0;
  const hay = [
    product.name,
    product.description,
    product.brand,
    ...Object.values(product.attributes ?? {}).flat(),
  ]
    .join(" ")
    .toLowerCase();
  const hit = terms.filter((t) => t.split(/\s+/).every((w) => hay.includes(w))).length;
  return hit / terms.length;
}

function priceHeadroom(price, budget) {
  if (!budget || budget <= 0) return 0.5; // neutral when no budget known
  if (price > budget) return 0;
  return Math.min((budget - price) / budget, 0.35) / 0.35; // 1.0 once >=35% under
}

const round4 = (n) => Number(n.toFixed(4));

/**
 * @param {string|null} merchant_id  scope to one merchant, or null for the marketplace
 * @param {import("@cca/contracts").SearchProductsParams} params
 * @returns {Promise<import("@cca/contracts").SearchProductsResponse>}
 */
export async function searchProducts(merchant_id, params = {}) {
  const query = String(params.query ?? "").trim();
  const f = params.filters ?? {};
  const hints = params.rank_hints ?? {};

  const rawMax = params.max_price ?? f.max_price;
  const attrs = {};
  for (const k of TEXT_ATTR_KEYS) if (f[k] !== undefined && f[k] !== null && f[k] !== "") attrs[k] = f[k];
  if (f.attributes && typeof f.attributes === "object") Object.assign(attrs, f.attributes);

  const ranges = {};
  for (const k of RANGE_ATTR_KEYS) {
    if (f[k] && typeof f[k] === "object") {
      const r = {};
      if (num(f[k].min) !== undefined) r.min = num(f[k].min);
      if (num(f[k].max) !== undefined) r.max = num(f[k].max);
      if (Object.keys(r).length) ranges[k] = r;
    }
  }

  const ctx = {
    category: f.category ?? null,
    max_price: rawMax === undefined || rawMax === null ? null : Number(rawMax),
    available_only: f.available_only === undefined ? true : Boolean(f.available_only),
    brand: f.brand ? String(f.brand).toLowerCase().trim() : null,
    waterproof: typeof f.waterproof === "boolean" ? f.waterproof : undefined,
    attrs,
    ranges,
    exclude: f.exclude && typeof f.exclude === "object" ? f.exclude : {},
  };

  const products = await listProducts(merchant_id);
  const candidates = products.filter((p) => passesFilters(p, ctx));

  let results;
  if (query && candidates.length) {
    await backfillEmbeddings(merchant_id); // lazy: ensure embeddings exist
    const vectors = new Map(
      (await getEmbeddingRows(merchant_id)).map((r) => [`${r.merchant_id} ${r.product_id}`, r.vector]),
    );
    const embedder = await getEmbedder();
    const [rawQueryVec] = await embedder.embed([query]);
    const queryVec = l2normalize(rawQueryVec); // stored doc vectors are unit-length; match that
    const queryTokens = words(query);
    const budget = num(hints.budget) ?? ctx.max_price ?? undefined;

    results = candidates
      .map((p) => {
        const v = vectors.get(vecKey(p));
        const cos = v ? cosine(queryVec, v) : 0;
        const score =
          0.55 * cos +
          0.2 * titleOverlap(queryTokens, p.name) +
          0.2 * profileMatch(p, hints) +
          0.05 * priceHeadroom(p.price, budget);
        return { ...p, score: round4(score) };
      })
      .sort((a, b) => b.score - a.score);
  } else {
    // No query -> filter-only browse, cheapest first.
    results = candidates
      .map((p) => ({ ...p, score: 0 }))
      .sort((a, b) => a.price - b.price);
  }

  return { query, results: results.slice(0, TOP_N) };
}
