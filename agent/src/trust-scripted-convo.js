// Phase 5 smoke flow. Requires catalog, payments, Postgres, and the agent:
//   npm run trust:convo -w @cca/agent

const base = process.env.AGENT_URL ?? "http://localhost:4003";
const merchant_id = process.env.DEMO_MERCHANT_ID ?? "merchant_123";
const session_id = `trust_demo_${Date.now()}`;

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: ${payload?.error?.message ?? response.status}`);
  console.log(`${path}:`, JSON.stringify(payload, null, 2));
  return payload;
}

const search = await post("/chat", {
  session_id,
  merchant_id,
  message: { kind: "text", text: "show me a comfortable canvas shoe under $60" },
});
const product = search.messages.find((message) => message.type === "product_carousel")?.products?.[0];
if (!product) throw new Error("search returned no product carousel");

await post("/chat", {
  session_id,
  merchant_id,
  message: {
    kind: "action",
    action: "add_to_cart",
    product_id: product.product_id,
    quantity: 1,
    size: product.attributes?.size?.[0],
    color: product.attributes?.color?.[0],
  },
});
const checkout = await post("/chat", { session_id, merchant_id, message: { kind: "text", text: "I'm ready to check out" } });
const preview = checkout.messages.find((message) => message.type === "transaction_preview")?.preview;
if (!preview) throw new Error("checkout did not return a transaction preview");

await post("/checkout/payment-method", { session_id, card_number: "4242424242424242" });
await post("/checkout/confirm", { session_id, cart_id: preview.cart_id });
