# @cca/frontend - Conversational-commerce widget

One continuous thread, no redirects, rich cards inline. No `data-merchant` -
search spans every store. The widget is the primary shopping interface.

## Message types

1. **text** - plain agent/user text. A three-dot "thinking" bubble shows while a
   reply is in flight.
2. **product_carousel** - raw search results: store, 4:3 image (lazy-loaded,
   hover-zoom on desktop), name, price, size/colour dropdowns, **Why / Compare /
   Add**. Dropped from a turn once a richer view (recommendation/comparison/cart)
   of the same products is present. `PriceDisplay` shows a struck original + a
   "Sale" badge when a product carries `compare_at_price` / `original_price`.
3. **recommendation** - an explained shortlist: each card adds a **Match n/10**
   bar (animates on mount), ✓ reasons tied to the shopper's stated needs, and –
   trade-offs.
4. **comparison** - a horizontally-scrollable side-by-side table (rows derived
   from real product fields), followed by the agent's 1-2 sentence verdict.
5. **choices** - a clarifying question rendered as tappable chips (single- or
   multi-select). Tapping sends the answer back into the thread.
6. **cart** - the bag, **grouped by store**, with an item-count badge and a grand
   subtotal. Each line has −/+/Remove controls that send a structured
   `update_cart_item` action (no LLM round-trip); the shopper can also edit it in
   chat ("remove the boots"). Adding an item fires a toast + a subtle bag pulse.
   Empty state: "Your bag is waiting for something great."
7. **transaction_preview** - the non-dismissible-by-chat card (focus moves to it
   on arrival): per-store subtotal/tax + a grand total, one card field, one
   **Confirm & pay $X**. It arrives on its own - no accompanying agent text. That
   button calls `POST /checkout/confirm`, which charges each store separately and
   returns a per-store outcome. The agent cannot cause payment by generating text.

A viewport toast system (`role="status"`, tap-to-dismiss, auto-timeout) handles
transient confirmations ("Added to cart", "Forgot 'cushioning'", "payment
approved"); durable messages (decline reasons, errors) stay in the thread.

## Transparency

The chat header has a small **ⓘ** button that opens a static panel stating what
the agent can and cannot do (it cannot charge a card, cannot see the card
number, cannot change an approved amount without re-approval).

The bag sidebar shows **What I know** - the shopper profile as chips (budget,
primary use, priorities, size…), updated live as the conversation progresses.
Each chip has a **×**: clicking it calls `POST /profile/forget` and the agent
drops that preference (gone from the next turn's reasoning too).

`agent_activity[]` still ships on every `ChatResponse` for anyone consuming the
API; the widget no longer surfaces it as a panel.

## Pages

| File | Route | What |
|---|---|---|
| `src/theme.css` | `/theme.css` | shared design system - tokens (colour, radius, shadow, motion) + primitives (`.btn`, `.card`, `.badge`, `.field`, `.skeleton`, `.reveal`) + `prefers-reduced-motion` reset. Used by the two HTML pages. |
| `src/index.html` | `/` | landing page - sticky header, gradient hero + CTAs, a 3-step "how it works", the chat widget framed in a branded panel, footer. Reveal-on-scroll via `IntersectionObserver` (skipped under reduced-motion). |
| `src/widget.js` | `/widget.js` | the embeddable widget (Shadow DOM, self-contained). Carries its own copy of the `theme.css` tokens so it stays dependency-free on any host page. |
| `src/merchant.html` + `src/merchant.js` | `/merchant` | merchant dashboard |
| `src/server.js` | - | zero-dependency static server (`npm run dev -w @cca/frontend`, `:4173`) |

## Design system

No framework, no build, no font/JS dependency. `theme.css` is the single source
for the palette (indigo-violet primary `#5b4be6`, warm-coral accent `#ff6a5d`,
brand gradient, status colours), radius/shadow/motion scales, and the reusable
primitives. The widget mirrors the same token values inside its shadow root.
Motion durations: micro ~130ms, normal ~220ms, larger ~400ms, all on one
`cubic-bezier(.22,1,.36,1)` easing; every transition animates `transform` /
`opacity` only. A `@media (prefers-reduced-motion: reduce)` block neutralises
animation everywhere while keeping the full layout.

## Merchant dashboard

Gated by a **merchant login** (sign in or create a store). The catalog service
issues a JWT; it's kept in `localStorage` and sent as `Authorization: Bearer` on
every write and on the transaction history. Demo logins (after `npm run seed`):
`demo@soleandstride.example` or `demo@nimbusathletics.example`, both `demo1234`.
Each sees only its own store.

Once in, it's a thin read-through of the live services - no local mock state:

- **Catalog** - the product list, plus CSV import (`POST .../products/csv`, 🔒)
- **AI shopping readiness** - a score computed from the live catalog: per-dimension
  ✓/⚠ (product info, pricing, inventory, specifications, images, variants) with a
  count of the products missing each, and an overall %.
- **Connect a commerce API** - a mock onboarding panel (endpoint + key →
  "✓ Connection successful — N products detected"). No real request is made.
- **Orders** - transactions from `GET :4001/mock-visa/transactions/:merchant_id` (🔒)

Needs the catalog + payments services running (both send permissive CORS headers).

## Embed the widget elsewhere

```html
<script src="https://your-static-host/widget.js"
  data-agent-url="http://localhost:4003"></script>
```

Self-contained in a Shadow DOM. Persists the thread + a session ID in
`localStorage`; on reload it sends that ID back to the agent, which restores the
authoritative conversation state from Redis. Product buttons send
`message.kind: "action"`; only the checkout card's Confirm & pay button calls the
payment endpoints.

## DoD

A first-time user can complete discover -> decide -> pay without instructions.

Contracts: `@cca/contracts` -> `src/agent.ts` (`ChatRequest` / `ChatResponse`), `src/trust.ts`.
