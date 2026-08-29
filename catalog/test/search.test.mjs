// Phase 3 DoD: search_products(query, filters) against seeded data returns
// sensible ranked results. Uses the default `hash` embedder (deterministic,
// offline). Needs Postgres up.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { migrate, pool, query } from "../src/db.js";
import { searchProducts } from "../src/search.js";
import { upsertMerchant, upsertProducts } from "../src/repo.js";
import { parseProductsCsv } from "../src/csv.js";
import { backfillEmbeddings } from "../src/embeddings.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures",
);
const fixturesCsv = await readFile(path.join(fixturesDir, "products.csv"), "utf8");

// Distinct prefix so catalog.test.mjs's `t2_%` cleanup (runs in a parallel
// process) can't delete this file's merchant mid-test.
const merchant_id = `t3_search_${Math.random().toString(16).slice(2, 8)}`;
let base;
let server;

before(async () => {
  await migrate();
  await upsertMerchant({ merchant_id, name: "Search Test Shop", category: "fashion" });
  const { products } = parseProductsCsv(fixturesCsv, { merchant_id, category: "fashion" });
  await upsertProducts(products);
  await backfillEmbeddings(merchant_id);

  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await query("DELETE FROM products WHERE merchant_id = $1", [merchant_id]);
  await query("DELETE FROM merchants WHERE merchant_id = $1", [merchant_id]);
  await pool.end();
});

test("semantic query ranks the obviously-matching product first", async () => {
  const { results } = await searchProducts(merchant_id, {
    query: "waterproof boots for hiking",
  });
  assert.ok(results.length > 0 && results.length <= 5);
  assert.equal(results[0].product_id, "prod_007"); // Waterproof Hiking Boot
  // scores are sorted descending
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i].score <= results[i - 1].score);
  }
});

test("a different query ranks a different product first", async () => {
  const { results } = await searchProducts(merchant_id, {
    query: "canvas sneaker for everyday wear",
  });
  assert.ok(["prod_001", "prod_002", "prod_017"].includes(results[0].product_id));
});

test("max_price is a hard filter", async () => {
  const { results } = await searchProducts(merchant_id, {
    query: "shoes",
    max_price: 60,
  });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.price <= 60));
});

test("out-of-stock products are hidden by default, shown on request", async () => {
  const hidden = await searchProducts(merchant_id, { query: "chelsea boot" });
  assert.ok(!hidden.results.some((r) => r.product_id === "prod_008"));

  const shown = await searchProducts(merchant_id, {
    query: "chelsea boot",
    filters: { available_only: false },
  });
  assert.ok(shown.results.some((r) => r.product_id === "prod_008"));
});

test("attribute-contains filter (size)", async () => {
  const { results } = await searchProducts(merchant_id, {
    query: "",
    filters: { size: "13" },
  });
  // no demo product is offered in size 13
  assert.equal(results.length, 0);

  const nine = await searchProducts(merchant_id, { query: "", filters: { size: "9" } });
  assert.ok(nine.results.length > 0);
  assert.ok(nine.results.every((r) => r.attributes.size.includes("9")));
});

test("empty query -> filter-only browse, cheapest first", async () => {
  const { results } = await searchProducts(merchant_id, { query: "" });
  assert.equal(results.length, 5);
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i].price >= results[i - 1].price);
  }
});

test("POST /merchants/:id/search wraps the function", async () => {
  const res = await fetch(`${base}/merchants/${merchant_id}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "insulated winter boot", max_price: 200 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.query, "insulated winter boot");
  assert.equal(body.results[0].product_id, "prod_018");

  const bad = await fetch(`${base}/merchants/${merchant_id}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ max_price: 50 }),
  });
  assert.equal(bad.status, 422);
});

test("POST /merchants/:id/embed is idempotent", async () => {
  const res = await fetch(`${base}/merchants/${merchant_id}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(body.embedded, 0); // already embedded in before()
  assert.equal(body.total, 18);
});
