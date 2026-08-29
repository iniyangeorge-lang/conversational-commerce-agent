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
import { getEmbeddingRows, upsertMerchant, upsertProducts } from "../src/repo.js";
import { parseProductsCsv } from "../src/csv.js";
import { backfillEmbeddings, embedFields } from "../src/embeddings.js";

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

  server = createApp({ auth: false }).listen(0);
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

test("embedFields: builds from whichever fields are present, drops empties", () => {
  const full = embedFields({
    name: "Trail Shoe", brand: "Cadence", description: "grippy outsole for mud",
    category: "fashion", attributes: { size: ["9"], activity: "trail" },
  });
  assert.equal(full.length, 3); // title + description + facets
  assert.deepEqual(full.map((f) => f.weight), [0.5, 0.3, 0.2]);
  assert.equal(full[0].text, "Trail Shoe. Cadence");

  const sparse = embedFields({ name: "Trail Shoe", description: "", category: "fashion", attributes: {} });
  assert.deepEqual(sparse.map((f) => f.text), ["Trail Shoe", "fashion"]); // no description component
});

test("stored doc vectors are the unit-length blend, tagged with the doc version", async () => {
  const rows = await getEmbeddingRows(merchant_id);
  assert.ok(rows.length >= 18);
  for (const r of rows) {
    assert.ok(String(r.model).endsWith("#mf1"));
    const norm = Math.sqrt(r.vector.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `${r.product_id} vector should be unit length (got ${norm})`);
  }
});

test("a name match outranks a body-only mention", async () => {
  // "chukka" appears only in prod_006's name; other suede/boot products mention
  // similar materials in prose. The 0.5-weighted title field should win.
  const { results } = await searchProducts(merchant_id, { query: "chukka boot" });
  assert.equal(results[0].product_id, "prod_006");
});

test("footwear filters: activity, waterproof, brand, numeric range", async () => {
  const trail = await searchProducts(merchant_id, { query: "", filters: { activity: "trail" } });
  assert.ok(trail.results.length > 0);
  assert.ok(trail.results.every((r) => r.attributes.activity === "trail"));

  const wp = await searchProducts(merchant_id, { query: "", filters: { waterproof: true } });
  assert.ok(wp.results.length > 0);
  assert.ok(wp.results.every((r) => String(r.attributes.waterproof).toLowerCase() === "yes"));
  assert.ok(wp.results.some((r) => r.product_id === "prod_007"));

  const cadence = await searchProducts(merchant_id, { query: "", filters: { brand: "cadence" } });
  assert.ok(cadence.results.length > 0);
  assert.ok(cadence.results.every((r) => /cadence/i.test(r.brand)));

  const light = await searchProducts(merchant_id, { query: "racing shoe", filters: { weight_g: { max: 200 } } });
  assert.ok(light.results.every((r) => Number(r.attributes.weight_g) <= 200));
  assert.ok(light.results.some((r) => r.product_id === "prod_005")); // 181 g racing flat

  const notSlipOn = await searchProducts(merchant_id, { query: "", filters: { exclude: { closure: "slip-on" } } });
  assert.ok(notSlipOn.results.every((r) => r.attributes.closure !== "slip-on"));
});

test("rank_hints re-rank the survivors toward the shopper's priorities", async () => {
  const q = "running shoe";
  const plain = await searchProducts(merchant_id, { query: q });
  const hinted = await searchProducts(merchant_id, {
    query: q,
    rank_hints: { priorities: ["cushioning", "road"], primary_use: "road running", budget: 150 },
  });
  const rank = (r, id) => r.results.findIndex((x) => x.product_id === id);

  // hints never filter
  assert.equal(plain.results.length, hinted.results.length);

  // once we know the shopper wants road + cushioning, the cushioned road shoe
  // (prod_004) should outrank the trail shoe (prod_003), and not drop vs plain
  assert.ok(rank(hinted, "prod_004") >= 0 && rank(hinted, "prod_003") >= 0);
  assert.ok(rank(hinted, "prod_004") < rank(hinted, "prod_003"));
  assert.ok(rank(hinted, "prod_004") <= rank(plain, "prod_004"));
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
