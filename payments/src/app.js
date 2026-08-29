// Mock Visa payment service - HTTP layer.
//
// Contract: @cca/contracts -> src/payments.ts
//   POST /mock-visa/tokenize                  -> 201 { payment_token, card_last4, created_at }
//   POST /mock-visa/charge                    -> 200 approved | declined  (idempotent on order_ref)
//   GET  /mock-visa/transactions/:merchant_id -> 200 { merchant_id, transactions[] }
//
// A declined charge is a normal business outcome, so it returns 200 with a
// `{ status: "declined", ... }` body. Non-2xx is reserved for actual errors
// (bad request, unknown token, server fault) and uses the ErrorResponse shape.

import { randomBytes } from "node:crypto";
import express from "express";
import { classifyCard, roundMoney } from "./rules.js";
import { query } from "./db.js";

const rand = (n) => randomBytes(n).toString("hex");
const newPaymentToken = () => `vtk_${rand(12)}`;
const newTransactionId = () => `txn_${rand(10)}`;

/** ErrorResponse helper (see contracts/src/common.ts). */
function fail(res, status, code, message, details) {
  return res
    .status(status)
    .json({ error: { code, message, ...(details ? { details } : {}) } });
}

function validateCharge(b) {
  const e = {};
  if (typeof b.payment_token !== "string" || !b.payment_token.startsWith("vtk_"))
    e.payment_token = "must be a string starting with 'vtk_'";
  if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0)
    e.amount = "must be a positive number";
  if (b.currency !== "USD") e.currency = "must be 'USD'";
  if (typeof b.merchant_id !== "string" || b.merchant_id.trim() === "")
    e.merchant_id = "is required";
  if (typeof b.order_ref !== "string" || b.order_ref.trim() === "")
    e.order_ref = "is required (idempotency key)";
  return Object.keys(e).length ? e : null;
}

/** transactions row -> ChargeResponse */
function toChargeResponse(row) {
  return row.status === "approved"
    ? { status: "approved", transaction_id: row.id, auth_code: row.auth_code }
    : { status: "declined", transaction_id: row.id, decline_reason: row.decline_reason };
}

/** transactions row -> Transaction (contract shape) */
function toTransaction(row) {
  return {
    id: row.id,
    token: row.token,
    merchant_id: row.merchant_id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    auth_code: row.auth_code,
    decline_reason: row.decline_reason,
    order_ref: row.order_ref,
    created_at: row.created_at.toISOString(),
  };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Request log - method + path + status only. Never the body (tokenize carries
  // a card number that must not be logged).
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.log(
        `[payments] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms)`,
      );
    });
    next();
  });

  app.get("/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "degraded" });
    }
  });

  // --- POST /mock-visa/tokenize ------------------------------------------------
  // Simulates Visa Token Service. The card number is used to derive last-4 and is
  // then discarded - never stored, never logged.
  app.post("/mock-visa/tokenize", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const digits = String(body.card_number ?? "").replace(/[\s-]/g, "");
      if (!/^\d{12,19}$/.test(digits))
        return fail(res, 422, "invalid_card_number", "card_number must be 12-19 digits");
      if (typeof body.user_ref !== "string" || body.user_ref.trim() === "")
        return fail(res, 422, "invalid_user_ref", "user_ref is required");

      const card_last4 = digits.slice(-4);
      const token = newPaymentToken();
      const { rows } = await query(
        `INSERT INTO payment_tokens (token, user_ref, card_last4, decline_reason)
         VALUES ($1, $2, $3, $4)
         RETURNING created_at`,
        [token, body.user_ref, card_last4, classifyCard(digits)],
      );

      return res.status(201).json({
        payment_token: token,
        card_last4,
        created_at: rows[0].created_at.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- POST /mock-visa/charge ------------------------------------------------
  app.post("/mock-visa/charge", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const invalid = validateCharge(body);
      if (invalid)
        return fail(res, 422, "invalid_request", "charge request failed validation", invalid);

      const { payment_token, amount, currency, merchant_id, order_ref } = body;

      const tok = await query(
        `SELECT token, decline_reason FROM payment_tokens WHERE token = $1`,
        [payment_token],
      );
      if (tok.rowCount === 0)
        return fail(res, 422, "unknown_token", "payment_token is not recognised");

      // Idempotency: replay the original transaction for a repeated order_ref.
      const existing = await query(
        `SELECT * FROM transactions WHERE merchant_id = $1 AND order_ref = $2`,
        [merchant_id, order_ref],
      );
      if (existing.rowCount > 0)
        return res.status(200).json(toChargeResponse(existing.rows[0]));

      const rounded = roundMoney(amount);
      // Decline behaviour is a property of the card, set at tokenization.
      const declineReason = tok.rows[0].decline_reason;
      const draft = {
        id: newTransactionId(),
        status: declineReason ? "declined" : "approved",
        auth_code: declineReason ? null : "00",
        decline_reason: declineReason ?? null,
      };

      try {
        const ins = await query(
          `INSERT INTO transactions
             (id, token, merchant_id, amount, currency, status, auth_code, decline_reason, order_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            draft.id,
            payment_token,
            merchant_id,
            rounded,
            currency,
            draft.status,
            draft.auth_code,
            draft.decline_reason,
            order_ref,
          ],
        );
        return res.status(200).json(toChargeResponse(ins.rows[0]));
      } catch (err) {
        if (err.code === "23505") {
          // Lost an idempotency race - return the row the winner wrote.
          const race = await query(
            `SELECT * FROM transactions WHERE merchant_id = $1 AND order_ref = $2`,
            [merchant_id, order_ref],
          );
          return res.status(200).json(toChargeResponse(race.rows[0]));
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // --- GET /mock-visa/transactions/:merchant_id -----------------------------
  app.get("/mock-visa/transactions/:merchant_id", async (req, res, next) => {
    try {
      const { merchant_id } = req.params;
      const { rows } = await query(
        `SELECT * FROM transactions
         WHERE merchant_id = $1
         ORDER BY created_at DESC, id DESC`,
        [merchant_id],
      );
      return res.json({ merchant_id, transactions: rows.map(toTransaction) });
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) =>
    fail(res, 404, "not_found", `no route for ${req.method} ${req.path}`),
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed")
      return fail(res, 400, "invalid_json", "request body is not valid JSON");
    console.error("[payments] unhandled error:", err.message);
    return fail(res, 500, "internal_error", "unexpected server error");
  });

  return app;
}
