// Trust-layer smoke flow (marketplace). Requires catalog, payments, Postgres, agent:
//   npm run trust:convo -w @cca/agent
//
// The agent may ask a progressive clarifying question first, so we nudge it
// until it puts products on the table, then drive a cross-merchant checkout.

const base = process.env.AGENT_URL ?? "http://localhost:4003";
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

const chat = (text) => post("/chat", { session_id, message: { kind: "text", text } });
const productsIn = (res) =>
  res.messages.find((m) => m.type === "recommendation" || m.type === "product_carousel")?.products ?? [];

async function getProducts(firstMessage) {
  let res = await chat(firstMessage);
  for (let i = 0; i < 3 && !productsIn(res).length; i += 1) {
    res = await chat("Any of those is fine — just show me a couple of options now.");
  }
  const products = productsIn(res);
  if (!products.length) throw new Error("agent never returned products");
  return products;
}

const addFromSearch = (p) =>
  post("/chat", {
    session_id,
    message: {
      kind: "action",
      action: "add_to_cart",
      merchant_id: p.merchant_id,
      product_id: p.product_id,
      quantity: 1,
      size: p.attributes?.size?.[0],
      color: p.attributes?.color?.[0],
    },
  });

const first = await getProducts("a comfortable canvas shoe under $60, size 9, colour doesn't matter");
const p1 = first[0];
await addFromSearch(p1);

const second = await getProducts("now some running socks, size medium");
const p2 = second.find((p) => p.merchant_id !== p1.merchant_id) ?? second[0];
if (p2 && p2.product_id !== p1.product_id) await addFromSearch(p2);

const checkout = await chat("I'm ready to check out");
const preview = checkout.messages.find((m) => m.type === "transaction_preview")?.preview;
if (!preview) throw new Error("checkout did not return a transaction preview");

await post("/checkout/payment-method", { session_id, card_number: "4242424242424242" });
await post("/checkout/confirm", { session_id, cart_id: preview.cart_id });
