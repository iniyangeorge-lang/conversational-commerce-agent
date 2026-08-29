// Merchant ingest: flexible column mapping, CSV preview, feed-URL import,
// and the "AI shopping" go-live toggle. Needs Postgres.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { migrate, pool, query } from "../src/db.js";
import { upsertMerchant } from "../src/repo.js";
import { detectMapping, mapRow } from "../src/header-map.js";
import { parseProductsCsv, previewProductsCsv } from "../src/csv.js";
import { assertPublicUrl, importFeed } from "../src/feed.js";

const merchant_id = `t_ingest_${Math.random().toString(16).slice(2, 8)}`;
let base;
let server;

// a deliberately messy real-world CSV (the kind that used to fail entirely)
const MESSY_CSV = `SKU,Product_Name,Brand,Category,Gender,Size,Color,Cost_Price,Selling_Price,Supplier,Stock_Status
FW001,Air Runner 3000,Nike,Running Shoes,Men,9|10,Black|White,62.50,119.99,Urban Footwear,In Stock
FW003,Classic Court,Adidas,Sneakers,Women,7,White,48.00,89.99,Global Sports,Low Stock
`;

before(async () => {
  await migrate();
  await upsertMerchant({ merchant_id, name: "Ingest Test Shop", category: "fashion" });

  const feedFetch = async (url) => {
    if (url.endsWith(".json")) {
      return {
        ok: true,
        headers: { get: () => "application/json" },
        async arrayBuffer() {
          return Buffer.from(JSON.stringify([
            { sku: "JF1", title: "Feed Sneaker", brand: "Puma", price: 74.5, sizes: "8|9", stock_status: "in stock" },
            { sku: "JF2", title: "", price: 10 }, // bad row -> reported, not fatal
          ]));
        },
      };
    }
    return {
      ok: true,
      headers: { get: () => "text/csv" },
      async arrayBuffer() {
        return Buffer.from("Item No,Product Title,Brand,Price,Sizes\nCF1,Feed Boot,Timberland,159.00,10|11\n");
      },
    };
  };

  server = createApp({ auth: false, feedFetch }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await query("DELETE FROM products WHERE merchant_id = $1", [merchant_id]);
  await query("DELETE FROM merchants WHERE merchant_id = $1", [merchant_id]);
  await pool.end();
});

test("mapRow: SKU/Product_Name/Selling_Price aliases resolve; unknowns become attributes", () => {
  const mapped = mapRow({
    SKU: "FW001", Product_Name: "Air Runner", Brand: "Nike", Selling_Price: "119.99",
    Category: "Running Shoes", Size: "9|10", Stock_Status: "In Stock", Gender: "Men", Cost_Price: "62.50",
  });
  assert.equal(mapped.product_id, "FW001");
  assert.equal(mapped.name, "Air Runner");
  assert.equal(mapped.brand, "Nike");
  assert.equal(mapped.price, "119.99");
  assert.equal(mapped.category, undefined);       // "Running Shoes" isn't a real category…
  assert.equal(mapped.product_type, "Running Shoes"); // …kept as an attribute
  assert.equal(mapped.availability, "In Stock");
  assert.equal(mapped.gender, "Men");
  assert.equal(mapped.cost_price, undefined);      // cost is dropped, not shopper-facing
});

test("the messy real-world CSV now parses instead of failing every row", () => {
  const { products, errors } = parseProductsCsv(MESSY_CSV, { merchant_id, category: "fashion" });
  assert.equal(errors.length, 0);
  assert.equal(products.length, 2);
  const p = products[0];
  assert.equal(p.name, "Air Runner 3000");
  assert.equal(p.price, 119.99);
  assert.equal(p.category, "fashion");            // fell back to the merchant category
  assert.deepEqual(p.attributes.size, ["9", "10"]);
  assert.equal(p.attributes.product_type, "Running Shoes");
  assert.equal(products[1].availability, true);   // "Low Stock" -> still sellable
});

test("previewProductsCsv returns the detected mapping + a sample, no persist", () => {
  const pv = previewProductsCsv(MESSY_CSV, { merchant_id, category: "fashion" });
  assert.equal(pv.ready, 2);
  assert.equal(pv.skipped, 0);
  const price = pv.mapping.find((m) => m.source === "Selling_Price");
  assert.equal(price.target, "price");
  const supplier = pv.mapping.find((m) => m.source === "Supplier");
  assert.equal(supplier.kind, "ignored");
  assert.equal(pv.sample.length, 2);
});

test("POST /products/preview then /products/csv imports the messy file", async () => {
  const pv = await (await fetch(`${base}/merchants/${merchant_id}/products/preview`, {
    method: "POST", headers: { "content-type": "text/csv" }, body: MESSY_CSV,
  })).json();
  assert.equal(pv.ready, 2);

  const imp = await (await fetch(`${base}/merchants/${merchant_id}/products/csv`, {
    method: "POST", headers: { "content-type": "text/csv" }, body: MESSY_CSV,
  })).json();
  assert.equal(imp.inserted + imp.updated, 2);
});

test("column override: force a column to a field / to ignore", () => {
  const rows = mapRow(
    { "Item Ref": "X9", "Marketing Name": "Cool Shoe", Price: "50" },
    { "Item Ref": "product_id", "Marketing Name": "name" },
  );
  assert.equal(rows.product_id, "X9");
  assert.equal(rows.name, "Cool Shoe");

  const map = detectMapping(["Colour", "Notes"], { Notes: "ignore" });
  assert.equal(map.find((m) => m.source === "Colour").target, "color");
  assert.equal(map.find((m) => m.source === "Notes").kind, "ignored");
});

test("importFeed: CSV feed with aliased headers", async () => {
  const { products, errors, format } = await importFeed({
    merchant_id, category: "fashion", url: "https://example.com/products.csv",
    fetchImpl: async () => ({ ok: true, headers: { get: () => "text/csv" },
      async arrayBuffer() { return Buffer.from("Item No,Product Title,Brand,Price,Sizes\nCF1,Feed Boot,Timberland,159.00,10|11\n"); } }),
  });
  assert.equal(format, "csv");
  assert.equal(errors.length, 0);
  assert.equal(products[0].name, "Feed Boot");
  assert.equal(products[0].price, 159);
});

test("importFeed: JSON feed (array), bad rows reported not fatal", async () => {
  const { products, errors, format } = await importFeed({
    merchant_id, category: "fashion", url: "https://example.com/products.json",
    fetchImpl: async () => ({ ok: true, headers: { get: () => "application/json" },
      async arrayBuffer() { return Buffer.from(JSON.stringify([
        { sku: "JF1", title: "Feed Sneaker", brand: "Puma", price: 74.5, sizes: "8|9" },
        { sku: "JF2", title: "", price: 10 },
      ])); } }),
  });
  assert.equal(format, "json");
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Feed Sneaker");
  assert.equal(errors.length, 1);
});

test("feed URL guard blocks localhost / private hosts", () => {
  assert.throws(() => assertPublicUrl("http://localhost:4002/x"), /public host/);
  assert.throws(() => assertPublicUrl("http://127.0.0.1/x"), /public host/);
  assert.throws(() => assertPublicUrl("http://192.168.1.10/x"), /public host/);
  assert.throws(() => assertPublicUrl("file:///etc/passwd"), /http/);
  assert.doesNotThrow(() => assertPublicUrl("https://feeds.example.com/p.csv"));
});

test("POST /import-feed persists and reports skipped rows", async () => {
  const res = await fetch(`${base}/merchants/${merchant_id}/products/import-feed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://feed.example.com/products.json" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.format, "json");
  assert.equal(body.inserted + body.updated, 1);
  assert.equal(body.errors.length, 1);
});

test("AI shopping toggle hides the store from marketplace search, dashboard still sees it", async () => {
  await fetch(`${base}/merchants/${merchant_id}/products/csv`, {
    method: "POST", headers: { "content-type": "text/csv" }, body: MESSY_CSV,
  });
  // a distinctive query so the product ranks inside the top-5 marketplace cut
  const browse = () =>
    fetch(`${base}/search`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Air Runner 3000 Nike", filters: { available_only: false } }),
    }).then((r) => r.json());
  const setEnabled = (enabled) =>
    fetch(`${base}/merchants/${merchant_id}/ai-shopping`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
    });

  const mine = (r) => r.results.some((p) => p.merchant_id === merchant_id);

  assert.ok(mine(await browse()), "live store appears in marketplace browse");

  const off = await setEnabled(false);
  assert.equal((await off.json()).merchant.ai_enabled, false);
  assert.ok(!mine(await browse()), "disabled store is hidden from the marketplace");

  const own = await (await fetch(`${base}/merchants/${merchant_id}/products`)).json();
  assert.ok(own.count >= 2, "merchant's own dashboard list is unaffected");

  await setEnabled(true);
  assert.ok(mine(await browse()), "re-enabling brings it back");
});
