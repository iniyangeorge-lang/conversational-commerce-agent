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

import { randomBytes } from "node:crypto";
import express from "express";
import { CATEGORIES, CATEGORY_TEMPLATES, isCategory } from "./categories.js";
import { parseProductsCsv } from "./csv.js";
import { extractProducts } from "./extract.js";
import { normalizeProduct } from "./normalize.js";
import {
  createMerchantUser,
  getMerchant,
  getMerchantUser,
  listMerchants,
  listProducts,
  upsertMerchant,
  upsertProducts,
} from "./repo.js";
import { backfillEmbeddings } from "./embeddings.js";
import { searchProducts } from "./search.js";
import { bearerAuth, hashPassword, signToken, verifyPassword } from "./auth.js";
import { query } from "./db.js";

function fail(res, status, code, message, details) {
  return res
    .status(status)
    .json({ error: { code, message, ...(details ? { details } : {}) } });
}

/**
 * @param {{ extractor?: Function, auth?: boolean }} [opts]
 *        `opts.extractor` overrides the LLM call in the extract path (tests).
 *        `opts.auth === false` disables the merchant-token guard (tests).
 */
export function createApp(opts = {}) {
  const app = express();
  app.disable("x-powered-by");

  // Merchant-token guard for catalog writes. Shopper-facing reads stay open.
  const requireMerchant = (req, res, next) => {
    const auth = bearerAuth(req);
    if (!auth) return fail(res, 401, "unauthenticated", "sign in as the merchant first");
    const target = req.params.merchant_id ?? req.body?.merchant_id;
    if (target && auth.merchant_id !== target)
      return fail(res, 403, "forbidden", "this token is for a different merchant");
    req.auth = auth;
    next();
  };
  const guard = opts.auth === false ? (_req, _res, next) => next() : requireMerchant;

  // Allow the merchant dashboard (static page on another port) to call this API.
  app.use((req, res, next) => {
    res.set("access-control-allow-origin", "*");
    res.set("access-control-allow-headers", "content-type, authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

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

  // --- Merchant auth (dashboard) -----------------------------------------
  app.post("/auth/signup", async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const e = {};
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email ?? ""))) e.email = "a valid email is required";
      if (typeof b.password !== "string" || b.password.length < 8) e.password = "at least 8 characters";
      if (typeof b.name !== "string" || !b.name.trim()) e.name = "store name is required";
      if (!isCategory(b.category)) e.category = `must be one of ${CATEGORIES.join(", ")}`;
      if (Object.keys(e).length) return fail(res, 422, "invalid_request", "signup failed validation", e);

      const email = b.email.toLowerCase();
      if (await getMerchantUser(email)) return fail(res, 409, "email_taken", "that email is already registered");

      const merchant = await upsertMerchant({
        merchant_id: `m_${randomBytes(6).toString("hex")}`,
        name: b.name.trim(),
        category: b.category,
        tax_rate: typeof b.tax_rate === "number" ? b.tax_rate : undefined,
        step_up_threshold: typeof b.step_up_threshold === "number" ? b.step_up_threshold : undefined,
      });
      await createMerchantUser({ merchant_id: merchant.merchant_id, email, password_hash: hashPassword(b.password) });
      res.status(201).json({ token: signToken({ merchant_id: merchant.merchant_id, email }), merchant });
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/login", async (req, res, next) => {
    try {
      const email = String(req.body?.email ?? "").toLowerCase();
      const user = await getMerchantUser(email);
      if (!user || !verifyPassword(req.body?.password, user.password_hash))
        return fail(res, 401, "invalid_credentials", "email or password is incorrect");
      const merchant = await getMerchant(user.merchant_id);
      res.json({ token: signToken({ merchant_id: user.merchant_id, email }), merchant });
    } catch (err) {
      next(err);
    }
  });

  app.get("/auth/me", guard, async (req, res, next) => {
    try {
      res.json({ email: req.auth?.email, merchant: await getMerchant(req.auth?.merchant_id) });
    } catch (err) {
      next(err);
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
  app.post("/merchants", guard, async (req, res, next) => {
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

  app.get("/merchants", async (_req, res, next) => {
    try {
      res.json({ merchants: await listMerchants() });
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
  app.post("/merchants/:merchant_id/products/csv", guard, async (req, res, next) => {
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
  app.post("/merchants/:merchant_id/products/extract", guard, async (req, res, next) => {
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
  app.post("/merchants/:merchant_id/products", guard, async (req, res, next) => {
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

  // --- Phase 3: search + embedding backfill -------------------------------

  // Marketplace search: spans every merchant, results carry merchant_id + merchant_name.
  app.post("/search", async (req, res, next) => {
    try {
      const b = req.body ?? {};
      if (typeof b.query !== "string")
        return fail(res, 422, "invalid_request", "query (string) is required; use \"\" to browse by filter only");
      if (b.filters !== undefined && (typeof b.filters !== "object" || b.filters === null))
        return fail(res, 422, "invalid_request", "filters must be an object");
      res.json(await searchProducts(null, { query: b.query, max_price: b.max_price, filters: b.filters }));
    } catch (err) {
      next(err);
    }
  });

  app.post("/merchants/:merchant_id/search", async (req, res, next) => {
    try {
      const merchant = await getMerchant(req.params.merchant_id);
      if (!merchant) return fail(res, 404, "merchant_not_found", "onboard the merchant first");

      const b = req.body ?? {};
      if (typeof b.query !== "string")
        return fail(res, 422, "invalid_request", "query (string) is required; use \"\" to browse by filter only");
      if (b.filters !== undefined && (typeof b.filters !== "object" || b.filters === null))
        return fail(res, 422, "invalid_request", "filters must be an object");

      const result = await searchProducts(merchant.merchant_id, {
        query: b.query,
        max_price: b.max_price,
        filters: b.filters,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/merchants/:merchant_id/embed", async (req, res, next) => {
    try {
      const merchant = await getMerchant(req.params.merchant_id);
      if (!merchant) return fail(res, 404, "merchant_not_found", "onboard the merchant first");
      const result = await backfillEmbeddings(merchant.merchant_id, { force: Boolean(req.body?.force) });
      res.json(result);
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
