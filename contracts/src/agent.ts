/**
 * AI agent layer contract (Phase 4) + conversational-commerce upgrade.
 *
 * ARCHITECTURAL RULE: the agent's toolset has NO `charge_payment` function.
 * `request_checkout` only produces a confirmation card for the user to act on.
 * The `/mock-visa/charge` calls live in the trust & consent layer, triggered
 * by the UI confirm button - never by an LLM tool call.
 *
 * MARKETPLACE: a session is not tied to one merchant. Search spans every
 * merchant's catalogue and cart lines carry their own `merchant_id`; checkout
 * fans out into one charge per merchant.
 *
 * TRUST BOUNDARY: the model may propose products, quantities and reasons, but
 * the application re-validates every product (exists / available / authoritative
 * price) before it reaches the shopper, and totals are always computed server
 * side. See `recommend_products` and the trust layer.
 */

import type { RankedProduct, SearchProductsParams } from "./catalog.js";

export type ConversationState =
  | "browsing"
  | "clarifying"
  | "comparing"
  | "cart_building"
  | "awaiting_confirmation"
  | "paid"
  | "declined"
  | "abandoned";

/** `request_checkout` may only be called from this state with a non-empty cart. */
export const CHECKOUT_ALLOWED_FROM: ConversationState = "cart_building";

// --- Shopper preference profile ------------------------------------------

/**
 * A structured, evolving representation of what the shopper wants. The agent
 * maintains it with `save_shopper_profile` and uses it to rank, recommend and
 * explain. It is never shown to the user as raw JSON - the widget renders a few
 * chips - but it IS returned on every `ChatResponse` for transparency.
 */
export interface ShopperProfile {
  category?: string;
  /** Budget ceiling in dollars. The primary hard constraint. */
  budget_max?: number;
  budget_min?: number;
  /** e.g. "road running", "university + programming", "gym". */
  primary_use?: string;
  /** e.g. "beginner", "marathon runner". */
  experience?: string;
  preferred_brands?: string[];
  avoided_brands?: string[];
  size?: string;
  color?: string;
  /** Must-haves. A product missing one of these should not be recommended. */
  required_features?: string[];
  /** Nice-to-haves - break ties, don't filter. */
  preferred_features?: string[];
  /** Absolute no-gos. */
  deal_breakers?: string[];
  /** Ordered, most important first: e.g. ["comfort", "durability", "price"]. */
  priorities?: string[];
  /** Anything else worth remembering in the shopper's own words. */
  notes?: string;
}

// --- Tool call parameter shapes (function-calling schema) ---

/** Per-line customization. For apparel `size` is required when the product lists sizes. */
export interface CartItemOptions {
  size?: string;
  color?: string;
}

export interface AddToCartParams {
  /** Which merchant's product - take it from the search result. */
  merchant_id: string;
  product_id: string;
  quantity: number;
  size?: string;
  color?: string;
}

/** Change a line already in the cart. `quantity: 0` removes it. */
export interface UpdateCartItemParams {
  merchant_id: string;
  product_id: string;
  size?: string;
  color?: string;
  quantity: number;
}

export type GetCartSummaryParams = Record<string, never>;

export interface RequestCheckoutParams {
  cart_id: string;
}

/** Merge these fields into the running shopper profile (only pass what changed). */
export type SaveShopperProfileParams = ShopperProfile;

/** Ask ONE progressive clarifying question, optionally with selectable answers. */
export interface AskClarifyingQuestionParams {
  question: string;
  /** Selectable quick replies. Omit for an open question. */
  options?: string[];
  /** Allow the shopper to pick more than one option. */
  allow_multiple?: boolean;
}

export interface GetProductParams {
  merchant_id: string;
  product_id: string;
}

export interface CompareProductsParams {
  /** 2-4 products to compare side by side. */
  items: Array<{ merchant_id: string; product_id: string }>;
}

/** Present an explainable shortlist. The app re-validates every item. */
export interface RecommendProductsParams {
  /** One short lead-in line, e.g. "Based on your priorities, I'd look at these:". */
  intro: string;
  items: Array<{
    merchant_id: string;
    product_id: string;
    /** 0-10, how well it fits the profile. */
    match_score: number;
    /** Concrete reasons tied to the shopper's stated needs. */
    reasons: string[];
    /** Honest downsides. */
    tradeoffs?: string[];
  }>;
}

export interface AgentToolParams {
  save_shopper_profile: SaveShopperProfileParams;
  ask_clarifying_question: AskClarifyingQuestionParams;
  search_products: SearchProductsParams;
  get_product: GetProductParams;
  recommend_products: RecommendProductsParams;
  compare_products: CompareProductsParams;
  add_to_cart: AddToCartParams;
  update_cart_item: UpdateCartItemParams;
  get_cart_summary: GetCartSummaryParams;
  request_checkout: RequestCheckoutParams;
}

export type AgentToolName = keyof AgentToolParams;

export const AGENT_TOOL_NAMES: AgentToolName[] = [
  "save_shopper_profile",
  "ask_clarifying_question",
  "search_products",
  "get_product",
  "recommend_products",
  "compare_products",
  "add_to_cart",
  "update_cart_item",
  "get_cart_summary",
  "request_checkout",
];

// --- Cart (marketplace: lines span merchants) ---

export interface CartItem {
  merchant_id: string;
  merchant_name: string;
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  /** Present when a size/colour was chosen. Lines are keyed by merchant + product + options. */
  options?: CartItemOptions;
}

export interface Cart {
  cart_id: string;
  session_id: string;
  items: CartItem[];
  /** Grand subtotal across all merchants (no tax). */
  subtotal: number;
}

export interface CartGroup {
  merchant_id: string;
  merchant_name: string;
  items: CartItem[];
  subtotal: number;
}

// --- Rich conversation messages ---

/** A search result carrying the agent's explanation of why it fits. */
export interface RecommendedProduct extends RankedProduct {
  match: {
    /** 0-10. */
    score: number;
    reasons: string[];
    tradeoffs: string[];
  };
}

/** One row of a side-by-side comparison. `values[i]` lines up with `products[i]`. */
export interface ComparisonRow {
  label: string;
  values: string[];
}

// --- Chat transport (frontend <-> agent, Phase 6) ---

export type ChatMessageType =
  | "text"
  | "product_carousel"
  | "recommendation"
  | "comparison"
  | "choices"
  | "cart"
  | "transaction_preview";

export interface ChatRequest {
  session_id: string;
  /** Optional - a storefront embed may pass its own id; the marketplace does not. */
  merchant_id?: string;
  /** Free text, or a structured action from a card / cart button click. */
  message:
    | { kind: "text"; text: string }
    | {
        kind: "action";
        /** `add_to_cart` from a product card; `update_cart_item` from the cart's +/-/remove controls (quantity 0 removes). */
        action: "add_to_cart" | "update_cart_item";
        merchant_id: string;
        product_id: string;
        quantity: number;
        size?: string;
        color?: string;
      };
}

export interface CartMessage {
  type: "cart";
  cart: Cart;
  /** Cart lines grouped by merchant, for display. */
  groups: CartGroup[];
  /** Grand subtotal (no tax). Tax + per-merchant totals appear on the checkout preview. */
  subtotal: number;
}

export type ChatMessage =
  | { type: "text"; text: string }
  | { type: "product_carousel"; products: RankedProduct[] }
  | { type: "recommendation"; intro: string; products: RecommendedProduct[] }
  | {
      type: "comparison";
      products: RankedProduct[];
      rows: ComparisonRow[];
      verdict?: string;
    }
  | { type: "choices"; question: string; options: string[]; allow_multiple: boolean }
  | CartMessage
  | { type: "transaction_preview"; preview: import("./trust.js").TransactionPreview };

// --- POST /profile/forget (widget "×" on a "What I know" chip) ---

/** Drop one preference. For a list field, `value` removes just that entry. */
export interface ForgetPreferenceRequest {
  session_id: string;
  key: keyof ShopperProfile;
  value?: string;
}

export interface ForgetPreferenceResponse {
  session_id: string;
  profile: ShopperProfile;
}

export interface ChatResponse {
  session_id: string;
  state: ConversationState;
  messages: ChatMessage[];
  /**
   * Human-readable trail of what the agent did this turn (searched, filtered,
   * compared, recommended, updated the cart...). Rendered as the transparency
   * strip. Empty when the turn was pure conversation.
   */
  agent_activity: string[];
  /** The structured profile the agent is working from (transparency). */
  profile: ShopperProfile;
}
