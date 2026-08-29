/**
 * Trust & consent layer contract (Phase 5).
 *
 * The confirmation card is a non-dismissible-by-chat mechanism. Payment happens
 * ONLY when the user clicks "Confirm & pay", which calls POST /checkout/confirm.
 */

import type { Money } from "./common.js";
import type { ChargeResponse, DeclineReason } from "./payments.js";

/** Payload returned to the frontend when `request_checkout` fires. */
export interface TransactionPreview {
  cart_id: string;
  merchant_name: string;
  items: Array<{ name: string; qty: number; price: Money }>;
  subtotal: Money;
  tax: Money;
  total: Money;
  /** True when total exceeds the merchant's step-up threshold. */
  requires_step_up: boolean;
}

// --- POST /checkout/confirm ---

export interface CheckoutConfirmRequest {
  session_id: string;
  cart_id: string;
  /** Present only when the preview had `requires_step_up: true`. Mock 4-digit code. */
  step_up_code?: string;
}

/** Tokenize a card before checkout. The PAN is used only in this request and is
 * never persisted by the trust layer; the session stores only the Visa token. */
export interface PaymentMethodTokenizeRequest {
  session_id: string;
  card_number: string;
}

export interface PaymentMethodTokenizeResponse {
  session_id: string;
  card_last4: string;
}

export type CheckoutConfirmResult =
  | { outcome: "approved"; transaction_id: string; auth_code: string; total: Money }
  | { outcome: "declined"; transaction_id: string; decline_reason: DeclineReason }
  | { outcome: "blocked"; reason: "spend_cap_exceeded" | "step_up_required" | "step_up_invalid" | "cart_changed" | "checkout_not_pending" | "payment_method_required" | "payment_service_unavailable" | "catalog_unavailable"; message: string };

export interface CheckoutConfirmResponse {
  session_id: string;
  cart_id: string;
  result: CheckoutConfirmResult;
}

export interface CheckoutCancelRequest {
  session_id: string;
  cart_id: string;
}

export interface CheckoutCancelResponse {
  session_id: string;
  cart_id: string;
  result: { outcome: "cancelled" } | CheckoutConfirmResult;
}

// --- Audit log (written on every confirm attempt) ---

export interface AuditLogEntry {
  id: string;
  session_id: string;
  cart_id: string;
  cart_snapshot: TransactionPreview;
  amount_shown_to_user: Money;
  confirmation_action: "confirm" | "cancel";
  charge_response: ChargeResponse | null;
  resulting_status: "approved" | "declined" | "blocked";
  created_at: string;
}
