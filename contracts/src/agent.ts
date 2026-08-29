/**
 * AI agent layer contract (Phase 4).
 *
 * ARCHITECTURAL RULE: the agent's toolset has NO `charge_payment` function.
 * `request_checkout` only produces a confirmation card for the user to act on.
 * The `/mock-visa/charge` call lives in the trust & consent layer, triggered
 * by the UI confirm button - never by an LLM tool call.
 */

import type { SearchProductsParams } from "./catalog.js";

export type ConversationState =
  | "browsing"
  | "comparing"
  | "cart_building"
  | "awaiting_confirmation"
  | "paid"
  | "declined"
  | "abandoned";

/** `request_checkout` may only be called from this state with a non-empty cart. */
export const CHECKOUT_ALLOWED_FROM: ConversationState = "cart_building";

// --- Tool call parameter shapes (function-calling schema) ---

export interface AddToCartParams {
  product_id: string;
  quantity: number;
}

export type GetCartSummaryParams = Record<string, never>;

export interface RequestCheckoutParams {
  cart_id: string;
}

export interface AgentToolParams {
  search_products: SearchProductsParams;
  add_to_cart: AddToCartParams;
  get_cart_summary: GetCartSummaryParams;
  request_checkout: RequestCheckoutParams;
}

export type AgentToolName = keyof AgentToolParams;

export const AGENT_TOOL_NAMES: AgentToolName[] = [
  "search_products",
  "add_to_cart",
  "get_cart_summary",
  "request_checkout",
];

// --- Cart ---

export interface CartItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
}

export interface Cart {
  cart_id: string;
  session_id: string;
  merchant_id: string;
  items: CartItem[];
  subtotal: number;
}

// --- Chat transport (frontend <-> agent, Phase 6) ---

export type ChatMessageType = "text" | "product_carousel" | "transaction_preview";

export interface ChatRequest {
  session_id: string;
  merchant_id: string;
  /** Free text, or a structured action from a card button click. */
  message:
    | { kind: "text"; text: string }
    | { kind: "action"; action: "add_to_cart"; product_id: string; quantity: number };
}

export interface ChatResponse {
  session_id: string;
  state: ConversationState;
  messages: Array<
    | { type: "text"; text: string }
    | { type: "product_carousel"; products: import("./catalog.js").RankedProduct[] }
    | { type: "transaction_preview"; preview: import("./trust.js").TransactionPreview }
  >;
}
