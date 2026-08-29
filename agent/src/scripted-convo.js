// Agent DoD smoke flow (marketplace). Start the catalog + agent first:
//   npm run convo -w @cca/agent
//
// The agent may open with a clarifying question, so we keep nudging until it
// returns products (a recommendation or a raw carousel), then build a
// cross-merchant cart and ask to check out.

const base = process.env.AGENT_URL ?? "http://localhost:4003";
const session_id = `demo_${Date.now()}`;

async function chat(message) {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id, message }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `agent returned ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  return body;
}

const say = (text) => chat({ kind: "text", text });
const productsIn = (res) =>
  res.messages.find((m) => m.type === "recommendation" || m.type === "product_carousel")?.products ?? [];

async function getProducts(firstMessage) {
  let res = await say(firstMessage);
  for (let i = 0; i < 3 && !productsIn(res).length; i += 1) {
    res = await say("Any of those is fine — show me a couple of options now.");
  }
  const products = productsIn(res);
  if (!products.length) throw new Error("agent never returned products");
  return products;
}

const addFromSearch = (product) =>
  chat({
    kind: "action",
    action: "add_to_cart",
    merchant_id: product.merchant_id,
    product_id: product.product_id,
    quantity: 1,
    size: product.attributes?.size?.[0],
    color: product.attributes?.color?.[0],
  });

// One item from each of two merchants -> a cross-merchant cart.
const first = await getProducts("waterproof hiking boots under $170, size 10");
const p1 = first[0];
await addFromSearch(p1);

const second = await getProducts("now a cushioned running shoe under $150, size 10");
const p2 = second.find((p) => p.merchant_id !== p1.merchant_id) ?? second[0];
if (p2 && p2.product_id !== p1.product_id) await addFromSearch(p2);

await say("I'm ready to check out");
