/** Shared primitives used across every service contract. */

export type Currency = "USD";

/** ISO-8601 timestamp string, e.g. "2026-08-29T12:34:56.000Z". */
export type Timestamp = string;

/**
 * A monetary amount in major units (dollars), 2 decimal places.
 *
 * Stored/transported as a float for hackathon speed. To avoid drift, every
 * server-side total and comparison MUST go through `roundMoney` first
 * (per-merchant subtotal + tax, charge amounts, audit-log amounts).
 */
export type Money = number;

/** Round a computed amount to cents. Use before any Money total or comparison. */
export const roundMoney = (amount: number): Money => Math.round(amount * 100) / 100;

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    /** Optional machine-readable details. */
    details?: Record<string, unknown>;
  };
}
