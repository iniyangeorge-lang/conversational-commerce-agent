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
  (a minimal iframe embed is enough for the demo).

## DoD

A first-time user can complete discover -> decide -> pay without instructions.

Contracts: `@cca/contracts` -> `src/agent.ts` (`ChatRequest` / `ChatResponse`), `src/trust.ts`.
