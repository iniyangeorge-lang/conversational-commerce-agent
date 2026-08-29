// Phase 5 trust & consent layer.
//
// This module owns the only path that calls the mock Visa charge endpoint. It
// loads the server-side session, reconstructs the cart from the catalog, checks
// the merchant policy, and records an audit entry for every confirm/cancel
// attempt before returning a result to the transport.

import { randomBytes } from "node:crypto";
import { CatalogClient } from "./catalog-client.js";
import { insertAudit, listAudit, migrate, pool } from "./trust-db.js";
import { roundMoney } from "./tools.js";
import { sessionKey } from "./state.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomBytes(10).toString("hex")}`;

export class TrustError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class PaymentsClient {
  constructor(baseUrl = process.env.PAYMENTS_URL ?? "http://localhost:4001", fetchImpl = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  async request(path, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new TrustError(502, "payment_service_error", payload?.error?.message ?? `payment service returned ${response.status}`);
    return payload;
  }

  tokenize({ card_number, user_ref }) {
    return this.request("/mock-visa/tokenize", { card_number, user_ref });
  }

  charge(body) {
    return this.request("/mock-visa/charge", body);
  }
}

export class MemoryAuditRepository {
  constructor() {
    this.entries = [];
  }

  async migrate() {}

  async insert(entry) {
    this.entries.push(structuredClone(entry));
  }

  async list(sessionId) {
    return this.entries.filter((entry) => entry.session_id === sessionId);
  }
}

function previewFor(session, items) {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0));
  const tax = roundMoney(subtotal * Number(session.merchant.tax_rate ?? 0));
  const total = roundMoney(subtotal + tax);
  return {
    cart_id: session.cart.cart_id,
    merchant_name: session.merchant.name,
    items: items.map((item) => ({
      name: item.name,
      qty: item.quantity,
      price: item.unit_price,
      ...(item.options?.size ? { size: item.options.size } : {}),
      ...(item.options?.color ? { color: item.options.color } : {}),
    })),
    subtotal,
    tax,
    total,
    requires_step_up: total > Number(session.merchant.step_up_threshold ?? 100),
  };
}

function samePreview(a, b) {
  if (!a || !b) return false;
  return a.cart_id === b.cart_id && a.merchant_name === b.merchant_name &&
    a.subtotal === b.subtotal && a.tax === b.tax && a.total === b.total &&
    a.requires_step_up === b.requires_step_up && JSON.stringify(a.items) === JSON.stringify(b.items);
}

function blocked(session, reason, message) {
  return {
    outcome: "blocked",
    reason,
    message,
  };
}

export class TrustLayer {
  constructor({ store, catalog = new CatalogClient(), payments = new PaymentsClient(), audit, expectedStepUpCode = process.env.STEP_UP_CODE ?? "1234" } = {}) {
    if (!store) throw new Error("TrustLayer requires the agent session store");
    this.store = store;
    this.catalog = catalog;
    this.payments = payments;
    this.usesDefaultDb = !audit;
    this.audit = audit ?? { insert: insertAudit, list: listAudit, migrate };
    this.expectedStepUpCode = String(expectedStepUpCode);
  }

  async migrate() {
    return this.audit.migrate?.();
  }

  async close() {
    if (this.usesDefaultDb) await pool.end();
  }

  async loadSession(sessionId) {
    const raw = await this.store.get(sessionKey(sessionId));
    if (!raw) throw new TrustError(404, "session_not_found", "no such checkout session");
    const session = typeof raw === "string" ? JSON.parse(raw) : raw;
    session.total_spent = Number(session.total_spent ?? 0);
    session.charge_attempt = Number(session.charge_attempt ?? 0);
    return session;
  }

  async saveSession(session) {
    await this.store.set(sessionKey(session.session_id), JSON.stringify(session));
  }

  async auditAttempt(session, snapshot, action, chargeResponse, status) {
    await this.audit.insert({
      id: id("audit"),
      session_id: session.session_id,
      cart_id: session.cart.cart_id,
      cart_snapshot: snapshot,
      amount_shown_to_user: roundMoney(snapshot?.total ?? 0),
      confirmation_action: action,
      charge_response: chargeResponse,
      resulting_status: status,
      created_at: now(),
    });
  }

  async authoritativePreview(session) {
    // Merchant policy is also server data. Refresh it so a threshold, tax rate,
    // change cannot be bypassed using an older session snapshot.
    const merchant = await this.catalog.getMerchant(session.merchant_id);
    if (!merchant) return { changed: true };
    session.merchant = merchant;
    const products = await this.catalog.listProducts(session.merchant_id);
    const items = [];
    for (const item of session.cart.items) {
      const product = products.find((candidate) => candidate.product_id === item.product_id);
      if (!product || !product.availability || roundMoney(product.price) !== roundMoney(item.unit_price))
        return { changed: true };
      items.push({
        product_id: product.product_id,
        name: product.name,
        quantity: item.quantity,
        unit_price: roundMoney(product.price),
        ...(item.options ? { options: item.options } : {}),
      });
    }
    return { changed: false, preview: previewFor(session, items), items };
  }

  async blockedResponse(session, snapshot, reason, message, action = "confirm") {
    const result = blocked(session, reason, message);
    await this.auditAttempt(session, snapshot, action, null, "blocked");
    return { session_id: session.session_id, cart_id: session.cart.cart_id, result };
  }

  async tokenizePaymentMethod(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim()) throw new TrustError(422, "invalid_request", "session_id is required");
    const digits = typeof request?.card_number === "string" ? request.card_number.replace(/[\s-]/g, "") : "";
    if (!/^\d{12,19}$/.test(digits)) throw new TrustError(422, "invalid_card_number", "card_number must be 12-19 digits");
    const session = await this.loadSession(request.session_id);
    // The PAN exists only in this call and is passed directly to the tokenizer.
    const tokenized = await this.payments.tokenize({ card_number: digits, user_ref: session.session_id });
    session.payment_token = tokenized.payment_token;
    session.card_last4 = tokenized.card_last4;
    if (session.state === "declined" && session.checkout_preview) {
      session.state = "awaiting_confirmation";
      session.checkout_result = null;
    }
    await this.saveSession(session);
    return { session_id: session.session_id, card_last4: tokenized.card_last4 };
  }

  async confirm(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim()) throw new TrustError(422, "invalid_request", "session_id is required");
    if (typeof request?.cart_id !== "string" || !request.cart_id.trim()) throw new TrustError(422, "invalid_request", "cart_id is required");
    const session = await this.loadSession(request.session_id);
    const snapshot = session.checkout_preview ?? previewFor(session, session.cart.items);

    if (request.cart_id !== session.cart.cart_id)
      return this.blockedResponse(session, snapshot, "cart_changed", "This checkout cart is no longer current.");

    if ((session.state === "paid" || session.state === "declined") && session.checkout_result) {
      await this.auditAttempt(session, snapshot, "confirm", session.last_charge_response ?? null, session.checkout_result.outcome === "approved" ? "approved" : "declined");
      return { session_id: session.session_id, cart_id: session.cart.cart_id, result: session.checkout_result };
    }

    if (session.state !== "awaiting_confirmation" || !session.checkout_preview)
      return this.blockedResponse(session, snapshot, "checkout_not_pending", "There is no active checkout confirmation for this cart.");

    if (!session.cart.items.length)
      return this.blockedResponse(session, snapshot, "cart_changed", "The cart is empty or has changed.");

    let authoritative;
    try {
      authoritative = await this.authoritativePreview(session);
    } catch {
      return this.blockedResponse(session, snapshot, "catalog_unavailable", "The catalog could not be revalidated; no payment was made.");
    }
    if (authoritative.changed || !samePreview(session.checkout_preview, authoritative.preview))
      return this.blockedResponse(session, snapshot, "cart_changed", "The cart or a product price changed after the preview was shown.");

    const preview = authoritative.preview;
    const spent = roundMoney(session.total_spent); // running total, still tracked for the audit trail

    if (preview.requires_step_up && String(request.step_up_code ?? "") === "")
      return this.blockedResponse(session, snapshot, "step_up_required", "Additional verification is required before payment.");
    if (preview.requires_step_up && String(request.step_up_code) !== this.expectedStepUpCode)
      return this.blockedResponse(session, snapshot, "step_up_invalid", "The verification code is invalid.");

    if (!session.payment_token)
      return this.blockedResponse(session, snapshot, "payment_method_required", "Add a tokenized payment method before confirming payment.");

    session.charge_attempt += 1;
    const chargeRequest = {
      payment_token: session.payment_token,
      amount: preview.total,
      currency: "USD",
      merchant_id: session.merchant_id,
      order_ref: `ord_${session.session_id}_${session.cart.cart_id}_${session.charge_attempt}`,
    };

    let charge;
    try {
      charge = await this.payments.charge(chargeRequest);
    } catch (err) {
      const result = blocked(session, "payment_service_unavailable", "The payment service is unavailable; no payment was confirmed.");
      await this.auditAttempt(session, snapshot, "confirm", null, "blocked");
      await this.saveSession(session);
      return { session_id: session.session_id, cart_id: session.cart.cart_id, result };
    }

    session.last_charge_response = charge;
    let result;
    let status;
    if (charge.status === "approved") {
      result = { outcome: "approved", transaction_id: charge.transaction_id, auth_code: charge.auth_code, total: preview.total };
      session.total_spent = roundMoney(spent + preview.total);
      session.state = "paid";
      status = "approved";
    } else {
      result = { outcome: "declined", transaction_id: charge.transaction_id, decline_reason: charge.decline_reason };
      session.state = "declined";
      status = "declined";
    }
    session.checkout_result = result;
    await this.auditAttempt(session, snapshot, "confirm", charge, status);
    await this.saveSession(session);
    return { session_id: session.session_id, cart_id: session.cart.cart_id, result };
  }

  async cancel(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim()) throw new TrustError(422, "invalid_request", "session_id is required");
    if (typeof request?.cart_id !== "string" || !request.cart_id.trim()) throw new TrustError(422, "invalid_request", "cart_id is required");
    const session = await this.loadSession(request.session_id);
    const snapshot = session.checkout_preview ?? previewFor(session, session.cart.items);
    if (request.cart_id !== session.cart.cart_id)
      return this.blockedResponse(session, snapshot, "cart_changed", "This checkout cart is no longer current.", "cancel");
    if (session.state !== "awaiting_confirmation" || !session.checkout_preview)
      return this.blockedResponse(session, snapshot, "checkout_not_pending", "There is no active checkout confirmation to cancel.", "cancel");
    session.state = "abandoned";
    await this.auditAttempt(session, snapshot, "cancel", null, "blocked");
    await this.saveSession(session);
    return { session_id: session.session_id, cart_id: session.cart.cart_id, result: { outcome: "cancelled" } };
  }

  async auditForSession(sessionId) {
    return this.audit.list(sessionId);
  }
}

export function createDefaultTrust(options = {}) {
  return new TrustLayer(options);
}
