// Phase 5 trust & consent layer (marketplace).
//
// This module owns the only path that calls the mock Visa charge endpoint. It
// loads the server-side session, reconstructs the cart per merchant from the
// catalogue, and on confirm fans out into one charge per merchant - reporting a
// per-merchant outcome and writing an audit row for each. A decline in one store
// does not block the rest.

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
    if (!response.ok)
      throw new TrustError(502, "payment_service_error", payload?.error?.message ?? `payment service returned ${response.status}`);
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

const previewItems = (items) =>
  items.map((item) => ({
    name: item.name,
    qty: item.quantity,
    price: item.unit_price,
    ...(item.options?.size ? { size: item.options.size } : {}),
    ...(item.options?.color ? { color: item.options.color } : {}),
  }));

/** groups: [{ merchant_id, merchant_name, tax_rate, items }] -> grouped TransactionPreview */
function previewFrom(cartId, groups) {
  const out = groups.map((g) => {
    const subtotal = roundMoney(g.items.reduce((s, i) => s + i.unit_price * i.quantity, 0));
    const tax = roundMoney(subtotal * Number(g.tax_rate ?? 0));
    return {
      merchant_id: g.merchant_id,
      merchant_name: g.merchant_name,
      items: previewItems(g.items),
      subtotal,
      tax,
      total: roundMoney(subtotal + tax),
    };
  });
  return {
    cart_id: cartId,
    groups: out,
    subtotal: roundMoney(out.reduce((s, g) => s + g.subtotal, 0)),
    tax: roundMoney(out.reduce((s, g) => s + g.tax, 0)),
    total: roundMoney(out.reduce((s, g) => s + g.total, 0)),
  };
}

/** A best-effort preview straight from the session cart (used for audit snapshots). */
function sessionPreview(session) {
  const byMerchant = new Map();
  for (const item of session.cart.items) {
    if (!byMerchant.has(item.merchant_id)) {
      byMerchant.set(item.merchant_id, {
        merchant_id: item.merchant_id,
        merchant_name: item.merchant_name || item.merchant_id,
        tax_rate: session.merchants?.[item.merchant_id]?.tax_rate ?? 0,
        items: [],
      });
    }
    byMerchant.get(item.merchant_id).items.push(item);
  }
  return previewFrom(session.cart.cart_id, [...byMerchant.values()]);
}

function samePreview(a, b) {
  if (!a || !b) return false;
  return (
    a.cart_id === b.cart_id &&
    a.subtotal === b.subtotal &&
    a.tax === b.tax &&
    a.total === b.total &&
    JSON.stringify(a.groups) === JSON.stringify(b.groups)
  );
}

export class TrustLayer {
  constructor({ store, catalog = new CatalogClient(), payments = new PaymentsClient(), audit } = {}) {
    if (!store) throw new Error("TrustLayer requires the agent session store");
    this.store = store;
    this.catalog = catalog;
    this.payments = payments;
    this.usesDefaultDb = !audit;
    this.audit = audit ?? { insert: insertAudit, list: listAudit, migrate };
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
    session.merchants = session.merchants ?? {};
    return session;
  }

  async saveSession(session) {
    await this.store.set(sessionKey(session.session_id), JSON.stringify(session));
  }

  async auditAttempt(session, snapshot, action, merchant_id, chargeResponse, status) {
    await this.audit.insert({
      id: id("audit"),
      session_id: session.session_id,
      cart_id: session.cart.cart_id,
      merchant_id: merchant_id ?? null,
      cart_snapshot: snapshot,
      amount_shown_to_user: roundMoney(snapshot?.total ?? 0),
      confirmation_action: action,
      charge_response: chargeResponse,
      resulting_status: status,
      created_at: now(),
    });
  }

  /** Rebuild each merchant's slice from live catalogue data. */
  async authoritativePreview(session) {
    const order = [];
    const byMerchant = new Map();
    for (const item of session.cart.items) {
      if (!byMerchant.has(item.merchant_id)) {
        order.push(item.merchant_id);
        byMerchant.set(item.merchant_id, []);
      }
      byMerchant.get(item.merchant_id).push(item);
    }

    const groups = [];
    for (const merchant_id of order) {
      const merchant = await this.catalog.getMerchant(merchant_id);
      if (!merchant) return { changed: true };
      session.merchants[merchant_id] = merchant;
      const products = await this.catalog.listProducts(merchant_id);
      const items = [];
      for (const item of byMerchant.get(merchant_id)) {
        const product = products.find((p) => p.product_id === item.product_id);
        if (!product || !product.availability || roundMoney(product.price) !== roundMoney(item.unit_price))
          return { changed: true };
        items.push({
          merchant_id,
          merchant_name: merchant.name,
          product_id: product.product_id,
          name: product.name,
          quantity: item.quantity,
          unit_price: roundMoney(product.price),
          ...(item.options ? { options: item.options } : {}),
        });
      }
      groups.push({ merchant_id, merchant_name: merchant.name, tax_rate: merchant.tax_rate, items });
    }

    return { changed: false, preview: previewFrom(session.cart.cart_id, groups), groups };
  }

  async blockedResponse(session, snapshot, reason, message, action = "confirm") {
    await this.auditAttempt(session, snapshot, action, null, null, "blocked");
    return {
      session_id: session.session_id,
      cart_id: session.cart.cart_id,
      result: { outcome: "blocked", reason, message },
    };
  }

  async tokenizePaymentMethod(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim())
      throw new TrustError(422, "invalid_request", "session_id is required");
    const digits = typeof request?.card_number === "string" ? request.card_number.replace(/[\s-]/g, "") : "";
    if (!/^\d{12,19}$/.test(digits)) throw new TrustError(422, "invalid_card_number", "card_number must be 12-19 digits");
    const session = await this.loadSession(request.session_id);
    const tokenized = await this.payments.tokenize({ card_number: digits, user_ref: session.session_id });
    session.payment_token = tokenized.payment_token;
    session.card_last4 = tokenized.card_last4;
    if ((session.state === "declined" || session.state === "paid") && session.checkout_preview && session.cart.items.length) {
      session.state = "awaiting_confirmation";
      session.checkout_result = null;
    }
    await this.saveSession(session);
    return { session_id: session.session_id, card_last4: tokenized.card_last4 };
  }

  async confirm(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim())
      throw new TrustError(422, "invalid_request", "session_id is required");
    if (typeof request?.cart_id !== "string" || !request.cart_id.trim())
      throw new TrustError(422, "invalid_request", "cart_id is required");
    const session = await this.loadSession(request.session_id);
    const snapshot = session.checkout_preview ?? sessionPreview(session);

    if (request.cart_id !== session.cart.cart_id)
      return this.blockedResponse(session, snapshot, "cart_changed", "This checkout cart is no longer current.");

    // Idempotent replay of a settled checkout.
    if ((session.state === "paid" || session.state === "declined") && session.checkout_result) {
      await this.auditAttempt(session, snapshot, "confirm", null, null, "blocked");
      return { session_id: session.session_id, cart_id: session.cart.cart_id, result: session.checkout_result };
    }

    if (session.state !== "awaiting_confirmation" || !session.checkout_preview)
      return this.blockedResponse(session, snapshot, "checkout_not_pending", "There is no active checkout confirmation for this cart.");
    if (!session.cart.items.length)
      return this.blockedResponse(session, snapshot, "empty_cart", "The cart is empty.");
    if (!session.payment_token)
      return this.blockedResponse(session, snapshot, "payment_method_required", "Add a tokenized payment method before confirming payment.");

    let authoritative;
    try {
      authoritative = await this.authoritativePreview(session);
    } catch {
      return this.blockedResponse(session, snapshot, "catalog_unavailable", "The catalogue could not be revalidated; no payment was made.");
    }
    if (authoritative.changed || !samePreview(session.checkout_preview, authoritative.preview))
      return this.blockedResponse(session, snapshot, "cart_changed", "The cart or a product price changed after the preview was shown.");

    const preview = authoritative.preview;
    session.charge_attempt += 1;

    // Fan out: one charge per merchant.
    const charges = [];
    for (const group of preview.groups) {
      const orderRef = `ord_${session.session_id}_${session.cart.cart_id}_${group.merchant_id}_${session.charge_attempt}`;
      let charge;
      try {
        charge = await this.payments.charge({
          payment_token: session.payment_token,
          amount: group.total,
          currency: "USD",
          merchant_id: group.merchant_id,
          order_ref: orderRef,
        });
      } catch (err) {
        charges.push({ merchant_id: group.merchant_id, merchant_name: group.merchant_name, outcome: "error", total: group.total, message: err.message });
        await this.auditAttempt(session, preview, "confirm", group.merchant_id, null, "blocked");
        continue;
      }
      if (charge.status === "approved") {
        charges.push({ merchant_id: group.merchant_id, merchant_name: group.merchant_name, outcome: "approved", transaction_id: charge.transaction_id, auth_code: charge.auth_code, total: group.total });
        await this.auditAttempt(session, preview, "confirm", group.merchant_id, charge, "approved");
      } else {
        charges.push({ merchant_id: group.merchant_id, merchant_name: group.merchant_name, outcome: "declined", transaction_id: charge.transaction_id, decline_reason: charge.decline_reason, total: group.total });
        await this.auditAttempt(session, preview, "confirm", group.merchant_id, charge, "declined");
      }
    }

    const approved = charges.filter((c) => c.outcome === "approved");
    if (!approved.length && charges.every((c) => c.outcome === "error")) {
      // nothing went through and it was all service errors - treat as a whole-checkout block
      const result = { outcome: "blocked", reason: "payment_service_unavailable", message: "The payment service is unavailable; no payment was confirmed." };
      session.charge_attempt = Math.max(0, session.charge_attempt - 1); // let a retry reuse the ref
      await this.saveSession(session);
      return { session_id: session.session_id, cart_id: session.cart.cart_id, result };
    }

    const approvedTotal = roundMoney(approved.reduce((s, c) => s + c.total, 0));
    session.total_spent = roundMoney(Number(session.total_spent) + approvedTotal);
    // Keep only the lines whose merchant did NOT get charged - so they can retry.
    const settled = new Set(approved.map((c) => c.merchant_id));
    session.cart.items = session.cart.items.filter((i) => !settled.has(i.merchant_id));
    session.cart.subtotal = roundMoney(session.cart.items.reduce((s, i) => s + i.unit_price * i.quantity, 0));
    session.state = approved.length ? "paid" : "declined";
    if (!session.cart.items.length) session.checkout_preview = null;

    const result = { outcome: "completed", charges, approved_total: approvedTotal };
    session.checkout_result = result;
    await this.saveSession(session);
    return { session_id: session.session_id, cart_id: session.cart.cart_id, result };
  }

  async cancel(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim())
      throw new TrustError(422, "invalid_request", "session_id is required");
    if (typeof request?.cart_id !== "string" || !request.cart_id.trim())
      throw new TrustError(422, "invalid_request", "cart_id is required");
    const session = await this.loadSession(request.session_id);
    const snapshot = session.checkout_preview ?? sessionPreview(session);
    if (request.cart_id !== session.cart.cart_id)
      return this.blockedResponse(session, snapshot, "cart_changed", "This checkout cart is no longer current.", "cancel");
    if (session.state !== "awaiting_confirmation" || !session.checkout_preview)
      return this.blockedResponse(session, snapshot, "checkout_not_pending", "There is no active checkout confirmation to cancel.", "cancel");
    session.state = "abandoned";
    await this.auditAttempt(session, snapshot, "cancel", null, null, "blocked");
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
