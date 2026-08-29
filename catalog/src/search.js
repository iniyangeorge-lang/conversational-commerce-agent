// search_products (Phase 3) - the single function the agent calls as a tool.
//
// Contract: @cca/contracts -> SearchProductsParams / SearchProductsResponse.
//   { query: string, max_price?: number, filters?: {
//       category?, max_price?, size?, color?, dietary?, available_only?, attributes? } }
//
// Semantic similarity over name+description embeddings, then hard filters
// (category, price ceiling, attribute-contains, availability). Top 5, ranked.

import { cosine, getEmbedder } from "./embedder.js";
import { backfillEmbeddings } from "./embeddings.js";
import { getEmbeddingRows, listProducts } from "./repo.js";

const TOP_N = 5;
const ATTR_FILTER_KEYS = ["size", "color", "dietary", "material"];

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase());
  if (v === null || v === undefined) return [];
  return [String(v).toLowerCase()];
}

function passesFilters(product, ctx) {
  if (ctx.category && product.category !== ctx.category) return false;
  if (ctx.max_price != null && product.price > ctx.max_price) return false;
  if (ctx.available_only && !product.availability) return false;
  for (const [key, wanted] of Object.entries(ctx.attrs)) {
    const have = toList(product.attributes?.[key]);
    const want = toList(wanted);
    if (!want.every((w) => have.includes(w))) return false;
  }
  return true;
}

/**
 * @param {string} merchant_id
 * @param {import("@cca/contracts").SearchProductsParams} params
 * @returns {Promise<import("@cca/contracts").SearchProductsResponse>}
 */
export async function searchProducts(merchant_id, params = {}) {
  const query = String(params.query ?? "").trim();
  const f = params.filters ?? {};

  const rawMax = params.max_price ?? f.max_price;
  const attrs = {};
  for (const k of ATTR_FILTER_KEYS) if (f[k] !== undefined && f[k] !== null) attrs[k] = f[k];
  if (f.attributes && typeof f.attributes === "object") Object.assign(attrs, f.attributes);

  const ctx = {
    category: f.category ?? null,
    max_price: rawMax === undefined || rawMax === null ? null : Number(rawMax),
    // Out-of-stock products are hidden unless the caller explicitly asks.
    available_only: f.available_only === undefined ? true : Boolean(f.available_only),
    attrs,
  };

  const products = await listProducts(merchant_id);
  const candidates = products.filter((p) => passesFilters(p, ctx));

  let results;
  if (query && candidates.length) {
    await backfillEmbeddings(merchant_id); // lazy: ensure embeddings exist
    const vectors = new Map(
      (await getEmbeddingRows(merchant_id)).map((r) => [r.product_id, r.vector]),
    );
    const embedder = await getEmbedder();
    const [queryVec] = await embedder.embed([query]);

    results = candidates
      .map((p) => {
        const v = vectors.get(p.product_id);
        return { ...p, score: v ? Number(cosine(queryVec, v).toFixed(4)) : 0 };
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
