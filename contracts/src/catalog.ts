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
  /** Other categories layer their own keys (food: dietary/spice_level, etc.). */
  [key: string]: unknown;
}

export interface Product {
  product_id: string;
  merchant_id: string;
  name: string;
  description: string;
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
  /** Retained for compatibility; not enforced (no spend cap, no step-up). */
  spend_limit: Money;
  step_up_threshold: Money;
  /** Applied to this merchant's slice of the cart at checkout, e.g. 0.0825. */
  tax_rate: number;
}

// --- search_products (called by the agent as a tool, Phase 4) ---

export interface SearchProductsFilters {
  category?: ProductCategory;
  max_price?: Money;
  /** Match products whose `attributes.size` contains this value (footwear demo). */
  size?: string;
  /** Match products whose `attributes.color` contains this value (footwear demo). */
  color?: string;
  /** Match products whose `attributes.dietary` contains this value (food). */
  dietary?: string;
  /** Generic attribute-contains filters: `{ material: "leather" }`. */
  attributes?: Record<string, string | string[]>;
  /** Default true - out-of-stock products are hidden unless this is false. */
  available_only?: boolean;
}

export interface SearchProductsParams {
  query: string;
  max_price?: Money;
  filters?: SearchProductsFilters;
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
