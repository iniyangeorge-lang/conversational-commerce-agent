// Phase 5 trust layer - marketplace fan-out checkout.

import test from "node:test";
import assert from "node:assert/strict";
import { CommerceAgent, MemoryStore } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { sessionKey } from "../src/state.js";
import { MemoryAuditRepository, TrustLayer } from "../src/trust.js";

const loadSession = async (store, sessionId) => JSON.parse(await store.get(sessionKey(sessionId)));
const DECLINE_CARD = "4000000000000002";

const merchants = {
  m_alpha: { merchant_id: "m_alpha", name: "Alpha Shoes", category: "fashion", tax_rate: 0.1, step_up_threshold: 100 },
  m_beta: { merchant_id: "m_beta", name: "Beta Runners", category: "fashion", tax_rate: 0.05, step_up_threshold: 100 },
};
const products = [
  { merchant_id: "m_alpha", product_id: "a_shoe", name: "Alpha Everyday", description: "shoe", price: 40, currency: "USD", category: "fashion", image_url: "", attributes: { size: ["9"], color: ["black"] }, availability: true },
  { merchant_id: "m_alpha", product_id: "a_boot", name: "Alpha Boot", description: "boot", price: 120, currency: "USD", category: "fashion", image_url: "", attributes: { size: ["9"] }, availability: true },
  { merchant_id: "m_beta", product_id: "b_run", name: "Beta Runner", description: "running shoe", price: 60, currency: "USD", category: "fashion", image_url: "", attributes: { size: ["9"], color: ["blue"] }, availability: true },
  { merchant_id: "m_beta", product_id: "b_sock", name: "Beta Socks", description: "socks", price: 15, currency: "USD", category: "fashion", image_url: "", attributes: {}, availability: true },
];

function fakeCatalog() {
  return {
    async getMerchant(id) { return merchants[id] ?? null; },
    async listProducts(id) { return products.filter((p) => p.merchant_id === id); },
    async getProduct(mid, pid) { return products.find((p) => p.merchant_id === mid && p.product_id === pid) ?? null; },
    async searchProducts(params) {
      const q = String(params.query ?? "").toLowerCase();
      const results = products
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
        .map((p) => ({ ...p, merchant_name: merchants[p.merchant_id].name, score: 1 }));
      return { query: params.query, results };
    },
  };
}

function fakePayments({ declineMerchants = [] } = {}) {
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
      const n = charges.length;
      if (badTokens.has(request.payment_token) || declineMerchants.includes(request.merchant_id))
        return { status: "declined", transaction_id: `txn_${n}`, decline_reason: "card_declined" };
      return { status: "approved", transaction_id: `txn_${n}`, auth_code: "00" };
    },
  };
}

/** cart: [{ merchant_id, product_id, size?, color?, qty? }] */
async function prepared(cart, paymentsOpts) {
  const sid = `s_${Math.random().toString(16).slice(2)}`;
  const store = new MemoryStore();
  const catalog = fakeCatalog();
  const agent = new CommerceAgent({ catalog, store, offline: true });

  await agent.handle({ session_id: sid, message: { kind: "text", text: "hi" } });
  for (const line of cart) {
    const r = await agent.handle({
      session_id: sid,
      message: { kind: "action", action: "add_to_cart", merchant_id: line.merchant_id, product_id: line.product_id, quantity: line.qty ?? 1, size: line.size, color: line.color },
    });
    assert.equal(r.state, "cart_building", JSON.stringify(r.messages));
  }
  const checkout = await agent.handle({ session_id: sid, message: { kind: "text", text: "check out" } });
  assert.equal(checkout.state, "awaiting_confirmation");
  const preview = checkout.messages.find((m) => m.type === "transaction_preview").preview;

  const audit = new MemoryAuditRepository();
  const payments = fakePayments(paymentsOpts);
  const trust = new TrustLayer({ store, catalog, payments, audit });
  return { agent, store, catalog, trust, payments, audit, session_id: sid, cart_id: preview.cart_id, preview };
}

const addPayment = (c, card_number = "4242424242424242") =>
  c.trust.tokenizePaymentMethod({ session_id: c.session_id, card_number });

test("checkout fans out into one charge per merchant; approved cart is emptied; idempotent", async () => {
  const c = await prepared([
    { merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" },
    { merchant_id: "m_beta", product_id: "b_run", size: "9", color: "blue" },
  ]);

  const noPay = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(noPay.result.reason, "payment_method_required");

  await addPayment(c);
  const done = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(done.result.outcome, "completed");
  assert.equal(done.result.charges.length, 2);
  assert.ok(done.result.charges.every((ch) => ch.outcome === "approved"));
  assert.equal(c.payments.charges.length, 2);
  // one order_ref per merchant
  assert.equal(new Set(c.payments.charges.map((ch) => ch.merchant_id)).size, 2);
  // 40*1.10 + 60*1.05 = 44 + 63 = 107
  assert.equal(done.result.approved_total, 107);

  const replay = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.deepEqual(replay.result, done.result);
  assert.equal(c.payments.charges.length, 2); // no re-charge

  const session = await loadSession(c.store, c.session_id);
  assert.equal(session.state, "paid");
  assert.equal(session.cart.items.length, 0);
  assert.equal((await c.audit.list(c.session_id)).filter((a) => a.merchant_id).length, 2);
});

test("grouped preview: per-merchant tax + a grand total", async () => {
  const c = await prepared([
    { merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" },
    { merchant_id: "m_beta", product_id: "b_sock" },
  ]);
  const g = c.preview.groups;
  assert.equal(g.length, 2);
  const alpha = g.find((x) => x.merchant_id === "m_alpha");
  const beta = g.find((x) => x.merchant_id === "m_beta");
  assert.equal(alpha.subtotal, 40);
  assert.equal(alpha.tax, 4); // 10%
  assert.equal(beta.tax, 0.75); // 5% of 15
  assert.equal(c.preview.total, 40 + 4 + 15 + 0.75);
});

test("a declined card declines every merchant; cart kept for a retry", async () => {
  const c = await prepared([
    { merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" },
    { merchant_id: "m_beta", product_id: "b_run", size: "9", color: "blue" },
  ]);
  await addPayment(c, DECLINE_CARD);
  const done = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(done.result.outcome, "completed");
  assert.ok(done.result.charges.every((ch) => ch.outcome === "declined"));
  assert.equal(done.result.approved_total, 0);
  assert.equal((await loadSession(c.store, c.session_id)).cart.items.length, 2);
});

test("partial: one merchant approves, the other declines - approved items go, declined stay", async () => {
  const c = await prepared(
    [
      { merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" },
      { merchant_id: "m_beta", product_id: "b_run", size: "9", color: "blue" },
    ],
    { declineMerchants: ["m_beta"] },
  );
  await addPayment(c);
  const done = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(done.result.outcome, "completed");
  const byM = Object.fromEntries(done.result.charges.map((ch) => [ch.merchant_id, ch.outcome]));
  assert.equal(byM.m_alpha, "approved");
  assert.equal(byM.m_beta, "declined");

  const session = await loadSession(c.store, c.session_id);
  assert.equal(session.state, "paid"); // some approved
  assert.equal(session.cart.items.length, 1);
  assert.equal(session.cart.items[0].merchant_id, "m_beta");
});

test("a price change after the preview blocks the whole checkout", async () => {
  const c = await prepared([{ merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" }]);
  products.find((p) => p.product_id === "a_shoe").price = 41;
  await addPayment(c);
  const done = await c.trust.confirm({ session_id: c.session_id, cart_id: c.cart_id });
  assert.equal(done.result.outcome, "blocked");
  assert.equal(done.result.reason, "cart_changed");
  assert.equal(c.payments.charges.length, 0);
  products.find((p) => p.product_id === "a_shoe").price = 40;
});

test("cancel abandons the pending checkout and records a cancel audit", async () => {
  const c = await prepared([{ merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" }]);
  const r = await c.trust.cancel({ session_id: c.session_id, cart_id: c.cart_id });
  assert.deepEqual(r.result, { outcome: "cancelled" });
  assert.equal((await c.audit.list(c.session_id)).at(-1).confirmation_action, "cancel");
});

test("HTTP checkout: a client-supplied amount is ignored; server charges the real totals", async () => {
  const c = await prepared([
    { merchant_id: "m_alpha", product_id: "a_shoe", size: "9", color: "black" },
    { merchant_id: "m_beta", product_id: "b_run", size: "9", color: "blue" },
  ]);
  const server = createApp(c.agent, c.trust).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tok = await fetch(`${base}/checkout/payment-method`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: c.session_id, card_number: "4242 4242 4242 4242" }),
  });
  assert.deepEqual(await tok.json(), { session_id: c.session_id, card_last4: "4242" });

  const res = await fetch(`${base}/checkout/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: c.session_id, cart_id: c.cart_id, amount: 0.01 }),
  });
  const body = await res.json();
  assert.equal(body.result.outcome, "completed");
  assert.equal(body.result.approved_total, 107);
  await new Promise((r) => server.close(r));
});
