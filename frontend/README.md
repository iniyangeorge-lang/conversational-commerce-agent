# @cca/frontend - Chat widget (Phase 6)

One continuous thread, no redirects, rich cards inline.

## Message types

1. **text** - plain agent/user text.
2. **product_carousel** - image, name, price, "add to cart" (button sends a
   structured action message, not free text).
3. **transaction_preview** - the non-dismissible-by-chat confirm/cancel card.
   Only clicking "Confirm & pay" calls `POST /checkout/confirm`. The agent
   cannot cause payment by generating text.

## Also

- Session persistence: reload mid-conversation, resume from Redis-backed state.
- Embeddable widget: `<script src=".../widget.js" data-merchant="merchant_123">`

## Run and embed

Serve `src/` from any static host, then include:

```html
<script src="https://your-static-host/widget.js"
  data-merchant="merchant_123"
  data-agent-url="http://localhost:4000"></script>
```

The widget is self-contained in a Shadow DOM. It persists the displayed thread
and a merchant-scoped session ID in `localStorage`; on reload it sends that ID
back to the agent, which restores the authoritative conversation state from
Redis. Product buttons send `message.kind: "action"`; only the checkout card's
explicit Confirm & pay button calls the payment endpoints.
  (a minimal iframe embed is enough for the demo).

## DoD

A first-time user can complete discover -> decide -> pay without instructions.

Contracts: `@cca/contracts` -> `src/agent.ts` (`ChatRequest` / `ChatResponse`), `src/trust.ts`.
