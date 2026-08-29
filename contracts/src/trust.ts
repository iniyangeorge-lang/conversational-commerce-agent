/**
 * Trust & consent layer contract (Phase 5).
 *
 * The confirmation card is a non-dismissible-by-chat mechanism. Payment happens
 * ONLY when the user clicks "Confirm & pay", which calls POST /checkout/confirm.
 *
 * MARKETPLACE: a cart can hold items from several merchants. The preview groups
 * by merchant; confirm fans out into one `/mock-visa/charge` per merchant and
 * reports a per-merchant outcome (a decline in one store does not block the rest).
 */

import type { Money } from "./common.js";
import type { DeclineReason } from "./payments.js";

/** One merchant's slice of the cart. */
export interface PreviewGroup {
  merchant_id: string;
  merchant_name: string;
  items: Array<{ name: string; qty: number; price: Money; size?: string; color?: string }>;
  subtotal: Money;
  tax: Money;
  /** What this merchant will be charged. */
  total: Money;
}

/** Payload returned to the frontend when `request_checkout` fires. */
export interface TransactionPreview {
  cart_id: string;
  groups: PreviewGroup[];
  /** Grand figures across all merchants. */
  subtotal: Money;
  tax: Money;
  total: Money;
}

// --- POST /checkout/payment-method ---

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

// --- POST /checkout/confirm ---

export interface CheckoutConfirmRequest {
  session_id: string;
  cart_id: string;
}

export interface MerchantChargeOutcome {
  merchant_id: string;
  merchant_name: string;
  outcome: "approved" | "declined" | "error";
  total: Money;
  /** Present on `approved` / `declined`. */
  transaction_id?: string;
  /** Present on `approved`. */
  auth_code?: string;
  /** Present on `declined`. */
  decline_reason?: DeclineReason;
  /** Present on `error` (the payment service could not be reached for this merchant). */
  message?: string;
}

export type CheckoutConfirmResult =
  /** Every merchant was charged; read `charges[]` for the per-merchant result.
   *  `approved_total` is the sum of the ones that went through. */
  | { outcome: "completed"; charges: MerchantChargeOutcome[]; approved_total: Money }
  /** Nothing was charged - a whole-checkout precondition failed. */
  | {
      outcome: "blocked";
      reason:
        | "cart_changed"
        | "checkout_not_pending"
        | "empty_cart"
        | "payment_method_required"
        | "payment_service_unavailable"
        | "catalog_unavailable";
      message: string;
    };

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

// --- Audit log (one row per merchant charge attempt, plus one per block) ---

export interface AuditLogEntry {
  id: string;
  session_id: string;
  cart_id: string;
  /** The merchant this row is about, or null for a whole-checkout block. */
  merchant_id: string | null;
  /** The full grouped preview shown to the shopper. */
  cart_snapshot: TransactionPreview;
  amount_shown_to_user: Money;
  confirmation_action: "confirm" | "cancel";
  charge_response: import("./payments.js").ChargeResponse | null;
  resulting_status: "approved" | "declined" | "blocked";
  created_at: string;
}
