// Catalog service - HTTP layer (Phase 2: onboarding + normalized catalog).
//
//   GET  /health
//   GET  /categories                         -> all category templates
//   GET  /categories/:category                -> one template
//   POST /merchants                           -> create/update a merchant (+ category)
//   GET  /merchants/:merchant_id
//   POST /merchants/:merchant_id/products/csv     -> CSV upload path
//   POST /merchants/:merchant_id/products/extract -> paste-text-and-extract path (no persist)
//   POST /merchants/:merchant_id/products         -> persist a batch of normalized products
//   GET  /merchants/:merchant_id/products
//
// Phase 3 adds search_products on top of this.

import express from "express";
import { CATEGORIES, CATEGORY_TEMPLATES, isCategory } from "./categories.js";
import { parseProductsCsv } from "./csv.js";
import { extractProducts } from "./extract.js";
import { normalizeProduct } from "./normalize.js";
import {
  getMerchant,
  listProducts,
  upsertMerchant,
  upsertProducts,
} from "./repo.js";
import { query } from "./db.js";

function fail(res, status, code, message, details) {
  return res
    .status(status)
    .json({ error: { code, message, ...(details ? { details } : {}) } });
}

/**
 * @param {{ extractor?: Function }} [opts] - `opts.extractor` overrides the LLM
 *        call in the extract path (used by tests).
 */
export function createApp(opts = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.log(
        `[catalog] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms)`,
      );
    });
    next();
  });

  app.get("/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "degraded" });
    }
  });

  // --- Category templates ---------------------------------------------------
  app.get("/categories", (_req, res) => res.json({ categories: CATEGORY_TEMPLATES }));

  app.get("/categories/:category", (req, res) => {
    const { category } = req.params;
    if (!isCategory(category))
      return fail(res, 404, "unknown_category", `category must be one of ${CATEGORIES.join(", ")}`);
    res.json({ category, ...CATEGORY_TEMPLATES[category] });
  });

  // --- Merchant onboarding ------------------------------------------------
  app.post("/merchants", async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const e = {};
      if (typeof b.merchant_id !== "string" || !b.merchant_id.trim()) e.merchant_id = "is required";
      if (typeof b.name !== "string" || !b.name.trim()) e.name = "is required";
      if (!isCategory(b.category)) e.category = `must be one of ${CATEGORIES.join(", ")}`;
      for (const k of ["spend_limit", "step_up_threshold", "tax_rate"]) {
        if (b[k] !== undefined && (typeof b[k] !== "number" || !Number.isFinite(b[k]) || b[k] < 0))
          e[k] = "must be a non-negative number";
      }
      if (Object.keys(e).length) return fail(res, 422, "invalid_request", "merchant failed validation", e);

      const merchant = await upsertMerchant(b);
      res.status(201).json({ merchant });
    } catch (err) {
      next(err);
    }
  });

  app.get("/merchants/:merchant_id", async (req, res, next) => {
    try {
      const merchant = await getMerchant(req.params.merchant_id);
      if (!merchant) return fail(res, 404, "merchant_not_found", "no such merchant");
      res.json({ merchant });
    } catch (err) {
      next(err);
    }
  });

  // --- CSV upload path ---------------------------------------------------
  app.post("/merchants/:merchant_id/products/csv", async (req, res, next) => {
    try {
      const merchant = await getMerchant(req.params.merchant_id);
      if (!merchant) return fail(res, 404, "merchant_not_found", "onboard the merchant first");

      const csvText =
        typeof req.body === "string" ? req.body : typeof req.body?.csv === "string" ? req.body.csv : null;
      if (!csvText || !csvText.trim())
        return fail(res, 422, "missing_csv", "send CSV as text/csv body or { csv: \"...\" }");

      const { products, errors } = parseProductsCsv(csvText, {
        merchant_id: merchant.merchant_id,
        category: merchant.category,
      });
      const result = products.length ? await upsertProducts(products) : { inserted: 0, updated: 0 };
      res.status(errors.length && !products.length ? 422 : 200).json({ ...result, errors });
    } catch (err) {
      next(err);
    }
  });

  // --- Paste-a-menu-and-extract path -----------------------------------
  app.post("/merchants/:merchant_id/products/extract", async (req, res, next) => {
    try {
      const merchant = await getMerchant(req.params.merchant_id);
      if (!merchant) return fail(res, 404, "merchant_not_found", "onboard the merchant first");

      const b = req.body ?? {};
      const category = b.category ?? merchant.category;
      const raw_text = b.raw_text ?? b.text;

      let result;
      try {
        result = await extractProducts(
          { merchant_id: merchant.merchant_id, category, raw_text },
          { extractor: opts.extractor },
        );
      } catch (err) {
        return fail(res, 422, "invalid_request", err.message);
      }
      // Contract: products come back without a product_id for the caller to review.
      res.json({ products: result.products, errors: result.errors });
    } catch (err) {
      next(err);
    }
  });

  // --- Persist reviewed products ------------------------------------------
  app.post("/merchants/:merchant_id/products", async (req, res, next) => {
    try {
      const merchant = await getMerchant(req.params.merchant_id);
      if (!merchant) return fail(res, 404, "merchant_not_found", "onboard the merchant first");

      const list = Array.isArray(req.body?.products) ? req.body.products : null;
      if (!list) return fail(res, 422, "invalid_request", "expected { products: [...] }");

      const normalized = [];
      const errors = [];
      list.forEach((raw, index) => {
        try {
          normalized.push(
            normalizeProduct(raw, {
              merchant_id: merchant.merchant_id,
              category: merchant.category,
            }),
          );
        } catch (err) {
          errors.push({ index, message: err.message });
        }
      });

      const result = normalized.length ? await upsertProducts(normalized) : { inserted: 0, updated: 0 };
      res.status(errors.length && !normalized.length ? 422 : 200).json({ ...result, errors });
    } catch (err) {
      next(err);
    }
  });

  app.get("/merchants/:merchant_id/products", async (req, res, next) => {
    try {
      const products = await listProducts(req.params.merchant_id);
      res.json({ merchant_id: req.params.merchant_id, count: products.length, products });
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => fail(res, 404, "not_found", `no route for ${req.method} ${req.path}`));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed")
      return fail(res, 400, "invalid_json", "request body is not valid JSON");
    console.error("[catalog] unhandled error:", err.message);
    return fail(res, 500, "internal_error", "unexpected server error");
  });

  return app;
}
