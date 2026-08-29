/**
 * Catalog service contract (Phase 2 & 3).
 *
 * Everything a merchant provides is normalized into `Product`.
 */

import type { Currency, Money } from "./common.js";

export type ProductCategory = "food" | "fashion" | "electronics" | "travel";

export interface ProductAttributes {
  /** Footwear demo: sizes the product is offered in, e.g. ["8", "9", "10"]. */
  size?: string[];
  /** Footwear demo: colorways the product is offered in. */
  color?: string[];
  /** Footwear demo — refinement attributes (all single-valued):
   *  activity: road | trail | gym | walking | casual
   *  waterproof: "yes" | "no"
   *  cushioning: minimal | balanced | high | max
   *  width: narrow | regular | wide
   *  closure: lace | slip-on | velcro
   *  support: neutral | stability
   *  drop_mm / weight_g: numeric (as strings from CSV) */
  activity?: string;
  waterproof?: string;
  cushioning?: string;
  width?: string;
  closure?: string;
  support?: string;
  drop_mm?: string;
  weight_g?: string;
  /** Other categories layer their own keys (food: dietary/spice_level, etc.). */
  [key: string]: unknown;
}

export interface Product {
  product_id: string;
  merchant_id: string;
  name: string;
  description: string;
  /** Optional brand / label, e.g. "Cadence", "Nimbus". Used in search + brand filters. */
  brand?: string;
  price: Money;
  currency: Currency;
  category: ProductCategory;
  image_url: string;
  attributes: ProductAttributes;
  availability: boolean;
}

export interface Merchant {
  merchant_id: string;
  name: string;
  category: ProductCategory;
  /** "Go live" switch. When false the marketplace search skips this store's
   *  products (the merchant dashboard still shows them). Defaults true. */
  ai_enabled: boolean;
  /** Retained for compatibility; not enforced (no spend cap, no step-up). */
  spend_limit: Money;
  step_up_threshold: Money;
  /** Applied to this merchant's slice of the cart at checkout, e.g. 0.0825. */
  tax_rate: number;
}

// --- Catalog ingest: CSV / feed / column mapping -------------------------

/** One source column and where it lands after `header-map.js` resolves it. */
export interface ColumnMapping {
  source: string;
  /** Canonical `Product` field, `attributes.<key>`, or "—" if ignored. */
  target: string;
  kind: "field" | "attribute" | "ignored";
}

/** `POST /merchants/:id/products/preview` - non-persisting "map columns" step. */
export interface CatalogPreviewResponse {
  mapping: ColumnMapping[];
  /** First few normalized products (what would be imported). */
  sample: Product[];
  ready: number;
  skipped: number;
  total: number;
  errors: Array<{ row: number; message: string }>;
}

/** `POST /merchants/:id/products/import-feed` - fetch a CSV / JSON product feed. */
export interface FeedImportRequest {
  url: string;
  /** Optional per-column overrides: sourceHeader -> canonical field | "attribute" | "ignore". */
  overrides?: Record<string, string>;
}

export interface FeedImportResponse {
  inserted: number;
  updated: number;
  format: "csv" | "json";
  fetched: number;
  errors: Array<{ row: number; message: string }>;
}

// --- search_products (called by the agent as a tool, Phase 4) ---

/** Numeric range filter on a numeric attribute (drop_mm, weight_g). */
export interface RangeFilter {
  min?: number;
  max?: number;
}

export interface SearchProductsFilters {
  category?: ProductCategory;
  max_price?: Money;
  /** Match products whose `attributes.size` contains this value (footwear demo). */
  size?: string;
  /** Match products whose `attributes.color` contains this value (footwear demo). */
  color?: string;
  /** Match products whose `brand` contains this value (case-insensitive). */
  brand?: string;
  /** Match products whose `attributes.dietary` contains this value (food). */
  dietary?: string;

  // --- Footwear refinement filters (hard, exact, case-insensitive) ---
  /** road | trail | gym | walking | casual */
  activity?: string;
  /** true keeps only waterproof products; false keeps only non-waterproof. */
  waterproof?: boolean;
  /** minimal | balanced | high | max */
  cushioning?: string;
  /** narrow | regular | wide */
  width?: string;
  /** lace | slip-on | velcro */
  closure?: string;
  /** neutral | stability */
  support?: string;
  /** Numeric range on `attributes.drop_mm`. */
  drop_mm?: RangeFilter;
  /** Numeric range on `attributes.weight_g`. */
  weight_g?: RangeFilter;

  /** Generic attribute-contains filters: `{ material: "leather" }`. */
  attributes?: Record<string, string | string[]>;
  /** Drop products matching any of these attribute values: `{ closure: "slip-on" }`. */
  exclude?: Record<string, string | string[]>;
  /** Default true - out-of-stock products are hidden unless this is false. */
  available_only?: boolean;
}

/**
 * Ranking hints derived from the shopper's profile. NEVER filter - they only
 * re-rank the survivors of the hard filters (see the blended score in search.js).
 */
export interface SearchRankHints {
  /** Ordered, most important first. */
  priorities?: string[];
  required_features?: string[];
  primary_use?: string;
  /** Used for the price-headroom term (prefer comfortably under budget). */
  budget?: number;
}

export interface SearchProductsParams {
  query: string;
  max_price?: Money;
  filters?: SearchProductsFilters;
  rank_hints?: SearchRankHints;
}

export interface RankedProduct extends Product {
  /** Cosine similarity or blended relevance score, higher is better. */
  score: number;
  /** Store the product belongs to (populated by the marketplace cross-merchant search). */
  merchant_name?: string;
}

export interface SearchProductsResponse {
  query: string;
  results: RankedProduct[]; // top 5, ranked
}

// --- Onboarding: extract-from-text (Phase 2, step 2) ---

export interface ExtractProductsRequest {
  merchant_id: string;
  category: ProductCategory;
  raw_text: string;
}

export interface ExtractProductsResponse {
  products: Omit<Product, "product_id">[];
}
