# @cca/frontend - Chat widget (Phase 6)

One continuous thread, no redirects, rich cards inline.

The header shows the merchant name (`ChatResponse.merchant_name`).

## Message types

1. **text** - plain agent/user text.
2. **product_carousel** - image, name, price, size/colour dropdowns, "Add to cart".
   Only available products are shown. For apparel the button is disabled until a
   size is picked; it sends a structured action (`size`/`colour` included), not free text.
3. **cart** - itemized bag card (qty x name, chosen size/colour, subtotal). Shown
   after add/remove and when the shopper asks to see their cart.
4. **transaction_preview** - the non-dismissible-by-chat confirm/cancel card.
   Only clicking "Confirm & pay" calls `POST /checkout/confirm`. The agent
   cannot cause payment by generating text.

## Pages

| File | Route | What |
|---|---|---|
| `src/index.html` | `/` | storefront - copy + the chat widget |
| `src/widget.js` | `/widget.js` | the embeddable widget itself (Shadow DOM, self-contained) |
| `src/merchant.html` + `src/merchant.js` | `/merchant` | merchant dashboard |
| `src/server.js` | - | zero-dependency static server (`npm run dev -w @cca/frontend`, `:4173`) |

## Merchant dashboard

A thin read-through of the live services - no local mock state:

- **Store & checkout settings** - name / category / tax rate / step-up threshold from `GET :4002/merchants/:id`
- **Catalog** - the product list from `GET :4002/merchants/:id/products`, plus CSV import (`POST .../products/csv`)
- **Orders** - transactions from `GET :4001/mock-visa/transactions/:merchant_id`

Needs the catalog + payments services running (both now send permissive CORS headers).

## Embed the widget elsewhere

```html
<script src="https://your-static-host/widget.js"
  data-merchant="merchant_123"
  data-agent-url="http://localhost:4003"></script>
```

Self-contained in a Shadow DOM. Persists the thread + a merchant-scoped session ID
in `localStorage`; on reload it sends that ID back to the agent, which restores the
authoritative conversation state from Redis. Product buttons send
`message.kind: "action"`; only the checkout card's Confirm & pay button calls the
payment endpoints.

## DoD

A first-time user can complete discover -> decide -> pay without instructions.

Contracts: `@cca/contracts` -> `src/agent.ts` (`ChatRequest` / `ChatResponse`), `src/trust.ts`.
