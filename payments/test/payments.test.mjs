// Phase 1 DoD: tokenize -> charge -> row in transactions, and the .13 decline
// path works reliably. Needs Postgres up (docker compose up -d).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { migrate, pool } from "../src/db.js";

let base;
let server;

const newMerchant = () =>
  `test_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const tokenize = () =>
  post("/mock-visa/tokenize", {
    card_number: "4111111111111111",
    user_ref: "user_test",
  }).then((r) => r.json());

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test("tokenize returns a vtk_ token and last-4, never the PAN", async () => {
  const res = await post("/mock-visa/tokenize", {
    card_number: "4242 4242 4242 4242",
    user_ref: "user_1",
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.payment_token, /^vtk_[0-9a-f]{24}$/);
  assert.equal(body.card_last4, "4242");
  assert.ok(!("card_number" in body));
});

test("tokenize -> charge (approved) -> shows up in the merchant's transactions", async () => {
  const merchant_id = newMerchant();
  const { payment_token } = await tokenize();

  const res = await post("/mock-visa/charge", {
    payment_token,
    amount: 42.5,
    currency: "USD",
    merchant_id,
    order_ref: "ord_1",
  });
  assert.equal(res.status, 200);
  const charged = await res.json();
  assert.equal(charged.status, "approved");
  assert.equal(charged.auth_code, "00");
  assert.match(charged.transaction_id, /^txn_/);

  const list = await fetch(
    `${base}/mock-visa/transactions/${merchant_id}`,
  ).then((r) => r.json());
  assert.equal(list.merchant_id, merchant_id);
  assert.equal(list.transactions.length, 1);
  assert.equal(list.transactions[0].id, charged.transaction_id);
  assert.equal(list.transactions[0].amount, 42.5);
  assert.equal(list.transactions[0].order_ref, "ord_1");
  assert.equal(list.transactions[0].decline_reason, null);
});

test("amount ending in .13 is declined with insufficient_funds", async () => {
  const merchant_id = newMerchant();
  const { payment_token } = await tokenize();

  for (const amount of [89.13, 0.13, 150.13]) {
    const body = await post("/mock-visa/charge", {
      payment_token,
      amount,
      currency: "USD",
      merchant_id,
      order_ref: `ord_${amount}`,
    }).then((r) => r.json());
    assert.equal(body.status, "declined", `amount ${amount}`);
    assert.equal(body.decline_reason, "insufficient_funds");
    assert.ok(!("auth_code" in body));
  }

  const nonDecline = await post("/mock-visa/charge", {
    payment_token,
    amount: 89.14,
    currency: "USD",
    merchant_id,
    order_ref: "ord_ok",
  }).then((r) => r.json());
  assert.equal(nonDecline.status, "approved");
});

test("repeat order_ref returns the original transaction, never double-charges", async () => {
  const merchant_id = newMerchant();
  const { payment_token } = await tokenize();
  const req = {
    payment_token,
    amount: 10,
    currency: "USD",
    merchant_id,
    order_ref: "dup",
  };

  const first = await post("/mock-visa/charge", req).then((r) => r.json());
  const replay = await post("/mock-visa/charge", { ...req, amount: 999 }).then(
    (r) => r.json(),
  );
  assert.equal(replay.transaction_id, first.transaction_id);

  const list = await fetch(
    `${base}/mock-visa/transactions/${merchant_id}`,
  ).then((r) => r.json());
  assert.equal(list.transactions.length, 1);
  assert.equal(list.transactions[0].amount, 10); // the second call did nothing
});

test("concurrent charges with the same order_ref settle to one transaction", async () => {
  const merchant_id = newMerchant();
  const { payment_token } = await tokenize();
  const req = {
    payment_token,
    amount: 25,
    currency: "USD",
    merchant_id,
    order_ref: "race",
  };

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      post("/mock-visa/charge", req).then((r) => r.json()),
    ),
  );
  const ids = new Set(results.map((r) => r.transaction_id));
  assert.equal(ids.size, 1);

  const list = await fetch(
    `${base}/mock-visa/transactions/${merchant_id}`,
  ).then((r) => r.json());
  assert.equal(list.transactions.length, 1);
});

test("charge validation rejects bad input with an ErrorResponse", async () => {
  const res = await post("/mock-visa/charge", { amount: -1, currency: "EUR" });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, "invalid_request");
  assert.ok(body.error.details.payment_token);
  assert.ok(body.error.details.amount);
  assert.ok(body.error.details.currency);
});

test("charge with an unknown token is rejected", async () => {
  const res = await post("/mock-visa/charge", {
    payment_token: "vtk_deadbeef",
    amount: 5,
    currency: "USD",
    merchant_id: newMerchant(),
    order_ref: "x",
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "unknown_token");
});
