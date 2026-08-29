import test from "node:test";
import assert from "node:assert/strict";
import { CommerceAgent, MemoryStore } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { sessionKey } from "../src/state.js";
import { MemoryAuditRepository, TrustLayer } from "../src/trust.js";

const loadSession = async (store, sessionId) => JSON.parse(await store.get(sessionKey(sessionId)));

const merchant = {
  merchant_id: "merchant_test",
  name: "Test Shop",
  category: "fashion",
  spend_limit: 150,
  step_up_threshold: 100,
  tax_rate: 0.0825,
};

const products = [
  { product_id: "cheap", merchant_id: merchant.merchant_id, name: "Everyday Shoe", description: "A comfortable shoe", price: 40, currency: "USD", category: "fashion", image_url: "https://example.com/cheap", attributes: { size: ["9"], color: ["black"] }, availability: true },
  { product_id: "premium", merchant_id: merchant.merchant_id, name: "Premium Boot", description: "A premium boot", price: 120, currency: "USD", category: "fashion", image_url: "https://example.com/premium", attributes: { size: ["9"], color: ["black"] }, availability: true },
];

const DECLINE_CARD = "4000000000000002";

function fakeCatalog() {
  return {
    async getMerchant() { return merchant; },
    async listProducts() { return products; },
    async searchProducts(_id, params) {
      const q = params.query.toLowerCase();
      const results = products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
      return { query: params.query, results: results.map((p) => ({ ...p, score: 1 })) };
    },
  };
}

function fakePayments() {
  const charges = [];
  const badTokens = new Set();
  return {
    charges,
    async tokenize({ card_number }) {
      const token = `vtk_${String(card_number).replace(/\D/g, "").slice(-8)}`;
      if (card_number === DECLINE_CARD) badTokens.add(token);
      return { payment_token: token, card_last4: String(card_number).slice(-4) };
    },
    async charge(request) {
      charges.push(request);
      if (badTokens.has(request.payment_token))
        return { status: "declined", transaction_id: `txn_${charges.length}`, decline_reason: "card_declined" };
      return { status: "approved", transaction_id: `txn_${charges.length}`, auth_code: "00" };
    },
  };
}

async function prepared(productId, quantity = 1) {
  const store = new MemoryStore();
  const catalog = fakeCatalog();
  const agent = new CommerceAgent({ catalog, store, offline: true });
  await agent.handle({ session_id: `s_${productId}_${quantity}`, merchant_id: merchant.merchant_id, message: { kind: "text", text: products.find((p) => p.product_id === productId).name } });
  await agent.handle({ session_id: `s_${productId}_${quantity}`, merchant_id: merchant.merchant_id, message: { kind: "action", action: "add_to_cart", product_id: productId, quantity, size: "9", color: "black" } });
  const checkout = await agent.handle({ session_id: `s_${productId}_${quantity}`, merchant_id: merchant.merchant_id, message: { kind: "text", text: "check out" } });
  assert.equal(checkout.state, "awaiting_confirmation");
  const audit = new MemoryAuditRepository();
  const payments = fakePayments();
  const trust = new TrustLayer({ store, catalog, payments, audit, expectedStepUpCode: "1234" });
  return { agent, store, catalog, trust, payments, audit, session_id: `s_${productId}_${quantity}`, cart_id: checkout.messages.find((m) => m.type === "transaction_preview").preview.cart_id };
}

async function addPayment(preparedCheckout, card_number = "4242424242424242") {
  await preparedCheckout.trust.tokenizePaymentMethod({ session_id: preparedCheckout.session_id, card_number });
}

test("confirm recomputes the total, charges only after tokenization, and is idempotent", async () => {
  const c = await prepared("cheap");
  const missingPayment = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(missingPayment.result.outcome, "blocked");
  assert.equal(missingPayment.result.reason, "payment_method_required");
  await addPayment(c);
  const approved = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.deepEqual(approved.result, { outcome: "approved", transaction_id: "txn_1", auth_code: "00", total: 43.3 });
  const replay = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.deepEqual(replay.result, approved.result);
  assert.equal(c.payments.charges.length, 1);
  assert.equal((await c.audit.list(c.session_id)).length, 3);

  const session = await loadSession(c.store, c.session_id);
  assert.equal(session.state, "paid");
  assert.equal(session.cart.items.length, 0);
  assert.equal(session.cart.subtotal, 0);
});

test("step-up is required above the merchant threshold and accepts the mock code", async () => {
  const c = await prepared("premium");
  await addPayment(c);
  const required = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(required.result.reason, "step_up_required");
  const invalid = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id, step_up_code: "0000" });
  assert.equal(invalid.result.reason, "step_up_invalid");
  const approved = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id, step_up_code: "1234" });
  assert.equal(approved.result.outcome, "approved");
});

test("large carts are not capped (spend cap removed)", async () => {
  const c = await prepared("premium", 2); // subtotal 240, total 259.80
  await addPayment(c);
  const result = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id, step_up_code: "1234" });
  assert.equal(result.result.outcome, "approved");
  assert.equal(result.result.total, 259.8);
  assert.equal(c.payments.charges.length, 1);
});

test("a decline test card is surfaced and audited; cart is kept for a retry", async () => {
  const c = await prepared("cheap");
  await addPayment(c, DECLINE_CARD);
  const result = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(result.result.outcome, "declined");
  assert.equal(result.result.decline_reason, "card_declined");
  assert.equal((await c.audit.list(c.session_id)).at(-1).resulting_status, "declined");
  // a declined charge keeps the cart so the shopper can retry with another card
  assert.equal((await loadSession(c.store, c.session_id)).cart.items.length, 1);
});

test("cart price changes after preview are blocked", async () => {
  const c = await prepared("cheap");
  products.find((p) => p.product_id === "cheap").price = 41;
  await addPayment(c);
  const result = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(result.result.reason, "cart_changed");
  products.find((p) => p.product_id === "cheap").price = 40;
});

test("cancel abandons the pending checkout and records a cancel audit", async () => {
  const c = await prepared("cheap");
  const result = await c.trust.cancel({ session_id: c.session_id, cart_id: c.cart_id });
  assert.deepEqual(result.result, { outcome: "cancelled" });
  assert.equal((await c.audit.list(c.session_id)).at(-1).confirmation_action, "cancel");
});

test("HTTP checkout endpoints keep the card flow separate from chat", async () => {
  const c = await prepared("cheap");
  const server = createApp(c.agent, c.trust).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenized = await fetch(`${base}/checkout/payment-method`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: c.session_id, card_number: "4242 4242 4242 4242" }),
  });
  assert.equal(tokenized.status, 200);
  assert.deepEqual(await tokenized.json(), { session_id: c.session_id, card_last4: "4242" });
  const confirmed = await fetch(`${base}/checkout/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: c.session_id, cart_id: c.cart_id, amount: 0.01 }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).result.outcome, "approved");
  await new Promise((resolve) => server.close(resolve));
});
