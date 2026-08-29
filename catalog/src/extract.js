// "Paste a menu / catalog page and extract" onboarding path (Phase 2, step 2).
//
// Raw merchant text -> Claude (forced tool call) -> normalized products.
// No-code merchant setup: works on any merchant with zero integration.
//
// Contract: @cca/contracts -> ExtractProductsRequest / ExtractProductsResponse.
// Per the contract, this returns products WITHOUT a product_id - the caller
// reviews them and then POSTs to /merchants/:id/products to persist.

import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, isCategory } from "./categories.js";
import { normalizeProduct } from "./normalize.js";

// Onboarding extraction runs on Anthropic (SDK) or OpenAI (raw fetch, no extra
// dep). EXTRACT_PROVIDER forces one; otherwise it follows whichever key is set.
const ANTHROPIC_MODEL = process.env.EXTRACT_MODEL ?? "claude-sonnet-5";
const OPENAI_MODEL = process.env.EXTRACT_MODEL_OPENAI ?? "gpt-4.1-mini";

const SYSTEM = `You extract structured product data from raw merchant text - a menu, a catalogue page, a price list.
Identify every distinct purchasable product.
- price: a plain number in the merchant's currency, no symbol. If a product has no clear price, skip it.
- category: use the category the caller gives unless the text plainly contradicts it.
- attributes: an object for size / colour / dietary / material / etc. Use arrays for multi-valued attributes (e.g. sizes).
- description: a short factual description from the text; do not embellish.
Never invent products, prices, or attributes that are not in the text.`;

const EMIT_TOOL = {
  name: "emit_products",
  description: "Return the list of products extracted from the merchant text.",
  input_schema: {
    type: "object",
    required: ["products"],
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "description", "price", "category"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            price: { type: "number" },
            category: { type: "string", enum: CATEGORIES },
            image_url: { type: "string" },
            attributes: {
              type: "object",
              description: "size/colour/dietary/etc. Arrays for multi-valued attributes.",
            },
            availability: { type: "boolean" },
          },
        },
      },
    },
  },
};

const userMessage = (category, raw_text) =>
  `Category: ${category}\n\nMerchant text:\n"""\n${raw_text}\n"""`;

async function callClaude({ category, raw_text, client }) {
  const anthropic = client ?? new Anthropic();
  const res = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    tools: [EMIT_TOOL],
    tool_choice: { type: "tool", name: "emit_products" },
    messages: [{ role: "user", content: userMessage(category, raw_text) }],
  });
  const block = res.content.find((b) => b.type === "tool_use" && b.name === "emit_products");
  return Array.isArray(block?.input?.products) ? block.input.products : [];
}

async function callOpenAI({ category, raw_text, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMessage(category, raw_text) },
      ],
      tools: [{ type: "function", function: { name: EMIT_TOOL.name, description: EMIT_TOOL.description, parameters: EMIT_TOOL.input_schema } }],
      tool_choice: { type: "function", function: { name: EMIT_TOOL.name } },
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  let parsed = {};
  try { parsed = JSON.parse(args || "{}"); } catch { parsed = {}; }
  return Array.isArray(parsed.products) ? parsed.products : [];
}

/** Pick the extractor by EXTRACT_PROVIDER, else whichever key is present. */
function defaultExtractor() {
  const forced = process.env.EXTRACT_PROVIDER?.toLowerCase();
  if (forced === "openai" || (!forced && !process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY))
    return callOpenAI;
  if (forced === "anthropic" || process.env.ANTHROPIC_API_KEY) return callClaude;
  throw new Error("no extraction key set - set ANTHROPIC_API_KEY or OPENAI_API_KEY (or upload a CSV / connect a feed instead)");
}

/**
 * @param {{ merchant_id: string, category: string, raw_text: string }} req
 * @param {{ client?: Anthropic, extractor?: Function }} [deps]
 *        `deps.extractor` overrides the Claude call (used by tests).
 * @returns {Promise<{ products: object[], errors: { index: number, message: string }[] }>}
 */
export async function extractProducts(req, deps = {}) {
  const { merchant_id, category, raw_text } = req;
  if (!merchant_id) throw new Error("merchant_id is required");
  if (!isCategory(category))
    throw new Error(`category must be one of ${CATEGORIES.join(", ")}`);
  if (!raw_text || !String(raw_text).trim()) throw new Error("raw_text is required");

  const run = deps.extractor ?? defaultExtractor();
  const candidates = await run({ category, raw_text, client: deps.client });

  const products = [];
  const errors = [];
  candidates.forEach((candidate, index) => {
    try {
      const product = normalizeProduct(
        { ...candidate, category: candidate.category ?? category },
        { merchant_id, category },
      );
      delete product.product_id; // contract: Omit<Product, "product_id">
      products.push(product);
    } catch (err) {
      errors.push({ index, message: err.message });
    }
  });
  return { products, errors };
}
