// Merchant auth: signup / login, and the token gate on catalog writes.
// Needs Postgres up.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { migrate, pool, query } from "../src/db.js";
import { hashPassword, verifyPassword, signToken, verifyToken } from "../src/auth.js";

let base;
let server;
const uniq = () => Math.random().toString(16).slice(2, 10);
const createdMerchants = [];

async function signup(overrides = {}) {
  const email = `authtest_${uniq()}@shop.test`;
  const res = await call("POST", "/auth/signup", {
    email, password: "passphrase1", name: "Test Shop", category: "fashion", ...overrides,
  });
  const body = await res.json();
  if (body.merchant?.merchant_id) createdMerchants.push(body.merchant.merchant_id);
  return { status: res.status, email, ...body };
}

const call = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  await migrate();
  server = createApp().listen(0); // auth ON
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  for (const id of createdMerchants) {
    await query("DELETE FROM product_embeddings WHERE merchant_id = $1", [id]);
    await query("DELETE FROM products WHERE merchant_id = $1", [id]);
    await query("DELETE FROM merchant_users WHERE merchant_id = $1", [id]);
    await query("DELETE FROM merchants WHERE merchant_id = $1", [id]);
  }
  await pool.end();
});

test("scrypt hash round-trips; JWT verifies and rejects tampering", () => {
  const stored = hashPassword("hunter2");
  assert.ok(verifyPassword("hunter2", stored));
  assert.ok(!verifyPassword("wrong", stored));

  const token = signToken({ merchant_id: "m_x" });
  assert.equal(verifyToken(token).merchant_id, "m_x");
  assert.equal(verifyToken(token.slice(0, -2) + "xx"), null);
  assert.equal(verifyToken("not.a.jwt"), null);
});

test("signup creates a merchant + user and returns a scoped token", async () => {
  const a = await signup({ name: "Auth Test Shop" });
  assert.equal(a.status, 201);
  assert.match(a.merchant.merchant_id, /^m_/);
  assert.equal(a.merchant.name, "Auth Test Shop");
  assert.equal(verifyToken(a.token).merchant_id, a.merchant.merchant_id);

  const dup = await call("POST", "/auth/signup", { email: a.email, password: "passphrase1", name: "x", category: "food" });
  assert.equal(dup.status, 409);
});

test("login checks the password; /auth/me returns the merchant", async () => {
  const a = await signup({ password: "correcthorse" });

  assert.equal((await call("POST", "/auth/login", { email: a.email, password: "nope" })).status, 401);

  const ok = await call("POST", "/auth/login", { email: a.email, password: "correcthorse" });
  assert.equal(ok.status, 200);
  const { token, merchant } = await ok.json();

  const me = await (await call("GET", "/auth/me", undefined, token)).json();
  assert.equal(me.email, a.email);
  assert.equal(me.merchant.merchant_id, merchant.merchant_id);
});

test("catalog writes need a token for THIS merchant", async () => {
  const a = await signup({ name: "Merchant A" });
  const b = await signup({ name: "Merchant B" });

  const csv = "name,price,currency,category\nSneaker,80,USD,fashion";
  const path = `/merchants/${a.merchant.merchant_id}/products/csv`;

  assert.equal((await call("POST", path)).status, 401); // no token
  const wrong = await fetch(base + path, {
    method: "POST", headers: { "content-type": "text/csv", authorization: `Bearer ${b.token}` }, body: csv,
  });
  assert.equal(wrong.status, 403); // wrong merchant's token
  const ok = await fetch(base + path, {
    method: "POST", headers: { "content-type": "text/csv", authorization: `Bearer ${a.token}` }, body: csv,
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).inserted, 1);
});

test("shopper reads stay open (no token needed)", async () => {
  const { merchant } = await signup({ name: "Open Reads" });
  assert.equal((await call("GET", `/merchants/${merchant.merchant_id}`)).status, 200);
  assert.equal((await call("GET", `/merchants/${merchant.merchant_id}/products`)).status, 200);
  assert.equal((await call("POST", `/merchants/${merchant.merchant_id}/search`, { query: "shoe" })).status, 200);
});
