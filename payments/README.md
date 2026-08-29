# @cca/payments - Mock Visa payment service (Phase 1)

Standalone. Once built, nothing else should need it to change.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/mock-visa/tokenize` | Fake PAN in -> `payment_token` out. Never store/log the PAN beyond this call. |
| POST | `/mock-visa/charge` | Charge a token. Idempotent on `order_ref`. Returns `approved` or `declined`. |
| GET | `/mock-visa/transactions/:merchant_id` | List transactions (merchant dashboard + audit verification). |

## Rules

- **Demo decline:** any `amount` ending in `.13` -> `{ status: "declined", decline_reason: "insufficient_funds" }`.
- **Idempotency:** a repeat `charge` with an existing `order_ref` returns the original transaction, does not charge again.

## Data model

`payment_tokens(token, user_ref, card_last4, created_at)`
`transactions(id, token, merchant_id, amount, currency, status, auth_code, decline_reason, order_ref, created_at)`

Contracts: `@cca/contracts` -> `src/payments.ts`.
