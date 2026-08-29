/**
 * Mock Visa payment service contract (Phase 1).
 *
 * Downstream services only ever see a `payment_token` - never a PAN.
 * The real `/mock-visa/charge` call is made ONLY by the trust & consent
 * layer (Phase 5), never by an LLM tool call.
 */

import type { Currency, Money, Timestamp } from "./common.js";

// --- POST /mock-visa/tokenize ---

export interface TokenizeRequest {
  /** Fake card number. Never stored or logged beyond this call. */
  card_number: string;
  /** Opaque reference for the end user / session. */
  user_ref: string;
}

export interface TokenizeResponse {
  payment_token: string; // e.g. "vtk_9f8a..."
  card_last4: string;
  created_at: Timestamp;
}

// --- POST /mock-visa/charge ---

export interface ChargeRequest {
  payment_token: string;
  amount: Money;
  currency: Currency;
  merchant_id: string;
  /** Idempotency key. A repeat charge with the same order_ref returns the original transaction. */
  order_ref: string;
}

export type ChargeStatus = "approved" | "declined";

export type DeclineReason =
  | "insufficient_funds"
  | "card_declined"
  | "expired_card"
  | "suspected_fraud";

export interface ChargeApprovedResponse {
  status: "approved";
  transaction_id: string; // e.g. "txn_789"
  auth_code: string; // e.g. "00"
}

export interface ChargeDeclinedResponse {
  status: "declined";
  transaction_id: string;
  decline_reason: DeclineReason;
}

export type ChargeResponse = ChargeApprovedResponse | ChargeDeclinedResponse;

// --- GET /mock-visa/transactions/:merchant_id ---

export interface Transaction {
  id: string;
  token: string;
  merchant_id: string;
  amount: Money;
  currency: Currency;
  status: ChargeStatus;
  auth_code: string | null;
  decline_reason: DeclineReason | null;
  order_ref: string;
  created_at: Timestamp;
}

export interface TransactionsListResponse {
  merchant_id: string;
  transactions: Transaction[];
}

/**
 * Demo decline rule: any charge whose `amount` ends in `.13` is declined
 * with `insufficient_funds`. Gives a reliable, repeatable failure path.
 */
export const DEMO_DECLINE_CENTS = 13;
