# @cca/contracts

The single source of truth for every inter-service contract. Build against these
types so services can be developed in parallel without blocking on each other.

## Layout

| File | Owner phase | Covers |
|---|---|---|
| `src/payments.ts` | Phase 1 | `tokenize`, `charge` (approved/declined), `transactions` list, `.13` demo decline rule |
| `src/catalog.ts` | Phase 2 & 3 | normalized `Product`, `Merchant`, `search_products` params/response, extract-from-text |
| `src/agent.ts` | Phase 4 | conversation state machine, tool param shapes, cart, chat transport |
| `src/trust.ts` | Phase 5 | `TransactionPreview`, `POST /checkout/confirm`, audit log entry |
| `src/common.ts` | - | `Currency`, `Money`, `Timestamp`, `ErrorResponse` |
| `schemas/*.json` | - | JSON Schema mirrors for the highest-stakes payloads |

## Rules baked into the types

- Downstream services only ever see a `payment_token`, never a PAN.
- The agent toolset has **no** `charge_payment` function - only `request_checkout`,
  which produces a confirmation card. The `/mock-visa/charge` call lives in the
  trust layer, triggered by the UI confirm button.
- `request_checkout` is only valid from `cart_building` with a non-empty cart
  (`CHECKOUT_ALLOWED_FROM`).
- Demo decline: any charge `amount` ending in `.13` is declined (`DEMO_DECLINE_CENTS`).
- `Money` is a float. Every server-side total and comparison goes through
  `roundMoney` (`src/common.ts`) before use.

## Consuming

Workspace packages import it directly:

```ts
import type { ChargeRequest, Product, TransactionPreview } from "@cca/contracts";
```

Changing a contract is a team-wide event - announce it, don't silently edit.
