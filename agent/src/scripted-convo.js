// Phase 4 DoD smoke flow. Start the catalog and agent first, then run:
//   npm run convo -w @cca/agent

const base = process.env.AGENT_URL ?? "http://localhost:4003";
const merchant_id = process.env.DEMO_MERCHANT_ID ?? "merchant_123";
const session_id = `demo_${Date.now()}`;

async function chat(message) {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id, merchant_id, message }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `agent returned ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  return body;
}

const search = await chat({ kind: "text", text: "I need waterproof boots for hiking under $150" });
const carousel = search.messages.find((message) => message.type === "product_carousel");
const product = carousel?.products?.[0];
if (!product) throw new Error("search returned no product carousel");

await chat({
  kind: "action",
  action: "add_to_cart",
  product_id: product.product_id,
  quantity: 1,
  size: product.attributes?.size?.[0],
  color: product.attributes?.color?.[0],
});
await chat({ kind: "text", text: "I'm ready to check out" });
