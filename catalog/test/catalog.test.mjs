// Phase 2 DoD: seeded products land in the products table via the CSV path,
// and the extract-from-text path produces normalized products.
// Needs Postgres up (docker compose up -d). The extract test uses a stub in
// place of the live Claude call.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { migrate, pool, query } from "../src/db.js";
import { normalizeProduct } from "../src/normalize.js";
import { parseProductsCsv } from "../src/csv.js";
import { extractProducts } from "../src/extract.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures",
);
const fixturesCsv = await readFile(path.join(fixturesDir, "products.csv"), "utf8");

let base;
let server;
const newMerchantId = () => `t2_${Math.random().toString(16).slice(2, 10)}`;

const req = (method, p, body, headers) =>
  fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

async function onboard(category = "fashion") {
  const merchant_id = newMerchantId();
  const res = await req("POST", "/merchants", {
    merchant_id,
    name: `Test Shop ${merchant_id}`,
    category,
  });
  assert.equal(res.status, 201, await res.text());
  return merchant_id;
}

before(async () => {
  await migrate();
  server = createApp({
    // stub the LLM: pretend the text described two shoes
    extractor: async () => [
      {
        name: "Trail Runner X",
        description: "Grippy trail shoe",
        price: 129.99,
        category: "fashion",
        attributes: { size: ["8", "9", "10"], color: ["black"] },
      },
      { name: "No Price Sandal", description: "missing a price" },
    ],
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await query("DELETE FROM products WHERE merchant_id LIKE 't2_%'");
  await query("DELETE FROM merchants WHERE merchant_id LIKE 't2_%'");
  await pool.end();
});

// --- normalize.js --------------------------------------------------------

test("normalizeProduct: CSV-style row -> canonical product", () => {
  const p = normalizeProduct(
    {
      product_id: "prod_x",
      merchant_id: "ignored_from_row",
      name: "  Suede Boot ",
      description: "nice",
      price: "120.005",
      currency: "usd",
      category: "FASHION",
      image_url: "https://img",
      size: "8|9|10",
      color: "sand|grey",
      availability: "true",
    },
    { merchant_id: "m_ctx" },
  );
  assert.equal(p.merchant_id, "m_ctx"); // context wins over row
  assert.equal(p.name, "Suede Boot");
  assert.equal(p.price, 120.01); // rounded to cents
  assert.equal(p.currency, "USD");
  assert.equal(p.category, "fashion");
  assert.deepEqual(p.attributes.size, ["8", "9", "10"]);
  assert.deepEqual(p.attributes.color, ["sand", "grey"]);
  assert.equal(p.availability, true);
});

test("normalizeProduct: bad row throws with a joined message", () => {
  assert.throws(
    () => normalizeProduct({ name: "", price: -1, category: "widgets" }, { merchant_id: "m" }),
    /name is required.*price.*category/s,
  );
});

// --- csv.js against the real fixtures -----------------------------------

test("parseProductsCsv: the 18 demo products parse cleanly", () => {
  const { products, errors } = parseProductsCsv(fixturesCsv, {
    merchant_id: "merchant_123",
    category: "fashion",
  });
  assert.equal(errors.length, 0);
  assert.equal(products.length, 18);
  assert.equal(products[0].product_id, "prod_001");
  const chelsea = products.find((p) => p.product_id === "prod_008");
  assert.equal(chelsea.availability, false);
  assert.ok(Array.isArray(chelsea.attributes.size));
});

// --- CSV onboarding endpoint (the DoD path) ---------------------------

test("POST /merchants/:id/products/csv seeds the products table", async () => {
  const merchant_id = await onboard("fashion");

  const res = await req("POST", `/merchants/${merchant_id}/products/csv`, fixturesCsv, {
    "content-type": "text/csv",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.inserted, 18);
  assert.equal(body.updated, 0);
  assert.equal(body.errors.length, 0);

  // re-upload -> all updates, no new rows
  const again = await req("POST", `/merchants/${merchant_id}/products/csv`, fixturesCsv, {
    "content-type": "text/csv",
  });
  assert.equal((await again.json()).updated, 18);

  const list = await (await req("GET", `/merchants/${merchant_id}/products`)).json();
  assert.equal(list.count, 18);
  assert.equal(list.products.filter((p) => !p.availability).length, 1);
});

test("CSV upload for an unknown merchant is rejected", async () => {
  const res = await req("POST", "/merchants/nope/products/csv", fixturesCsv, {
    "content-type": "text/csv",
  });
  assert.equal(res.status, 404);
});

// --- extract-from-text path -------------------------------------------

test("extractProducts: normalizes candidates, drops product_id, reports bad ones", async () => {
  const { products, errors } = await extractProducts(
    { merchant_id: "m_ctx", category: "fashion", raw_text: "irrelevant - extractor is stubbed" },
    {
      extractor: async () => [
        { name: "Runner", description: "x", price: 99.9, category: "fashion", attributes: { size: ["9"] } },
        { name: "Broken", description: "no price" },
      ],
    },
  );
  assert.equal(products.length, 1);
  assert.equal(products[0].price, 99.9);
  assert.ok(!("product_id" in products[0]));
  assert.equal(errors.length, 1);
});

test("POST /merchants/:id/products/extract returns reviewable products", async () => {
  const merchant_id = await onboard("fashion");
  const res = await req("POST", `/merchants/${merchant_id}/products/extract`, {
    raw_text: "Trail Runner X - $129.99. Also a sandal.",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.products.length, 1); // the priced one
  assert.equal(body.products[0].name, "Trail Runner X");
  assert.ok(!("product_id" in body.products[0]));
  assert.equal(body.errors.length, 1);

  // persist the reviewed product
  const saved = await req("POST", `/merchants/${merchant_id}/products`, {
    products: body.products,
  });
  assert.equal((await saved.json()).inserted, 1);
});

test("extract endpoint requires raw_text", async () => {
  const merchant_id = await onboard("fashion");
  const res = await req("POST", `/merchants/${merchant_id}/products/extract`, {});
  assert.equal(res.status, 422);
});

// --- category templates ----------------------------------------------

test("GET /categories/:category returns the template", async () => {
  const res = await req("GET", "/categories/fashion");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.refine_attributes, ["size", "color"]);

  assert.equal((await req("GET", "/categories/widgets")).status, 404);
});
