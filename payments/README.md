# @cca/payments - Mock Visa payment service (Phase 1)

Standalone. Tokenize a fake card, charge/decline against the token, list a
merchant's transactions. Nothing else needs it to change once it's built.

## Run

```bash
docker compose up -d                 # Postgres must be up
npm run dev   -w @cca/payments       # http://localhost:4001  (auto-migrates on boot)
npm test      -w @cca/payments       # integration tests (needs Postgres)
npm run migrate -w @cca/payments     # run the schema by hand
```

Config: `PAYMENTS_PORT` (default `4001`), `DATABASE_URL` (default
`postgres://cca:cca@localhost:5432/cca`). Read from the repo-root `.env` if present.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/mock-visa/tokenize` | `{ card_number, user_ref }` -> `201 { payment_token, card_last4, created_at }`. The card number derives last-4 and is then discarded - never stored, never logged. |
| POST | `/mock-visa/charge` | `{ payment_token, amount, currency, merchant_id, order_ref }` -> `200` approved or declined. Idempotent on `(merchant_id, order_ref)`. |
| GET | `/mock-visa/transactions/:merchant_id` | `200 { merchant_id, transactions[] }`, newest first. |
| GET | `/health` | `{ status: "ok" }` when the DB is reachable. |

Contract shapes: `@cca/contracts` -> `src/payments.ts`.

## Behaviour

- **Demo decline:** any `amount` ending in `.13` -> `{ status: "declined", decline_reason: "insufficient_funds" }`. Reliable, repeatable failure path for the live demo.
- **Idempotency:** a repeat `charge` with an existing `(merchant_id, order_ref)` returns the *original* transaction and does not charge again - including under a concurrent race (unique constraint + `23505` catch).
- **A decline is a 200.** Non-2xx is only for real errors, using the `ErrorResponse` shape (`{ error: { code, message, details? } }`):
  - `422 invalid_request` - charge body failed validation (`details` lists each bad field)
  - `422 invalid_card_number` / `422 invalid_user_ref` - bad tokenize input
  - `422 unknown_token` - `payment_token` not recognised
  - `400 invalid_json` - unparseable body
  - `404 not_found`, `500 internal_error`

## Data model

```
payment_tokens(token PK, user_ref, card_last4, created_at)
transactions(id PK, token -> payment_tokens, merchant_id, amount NUMERIC(12,2),
             currency, status, auth_code, decline_reason, order_ref, created_at,
             UNIQUE(merchant_id, order_ref))
```

Schema lives in `src/schema.sql` and is applied on every boot (`CREATE TABLE IF NOT EXISTS`).

## Files

| File | Role |
|---|---|
| `src/index.js` | entrypoint: load env -> migrate -> listen, graceful shutdown |
| `src/app.js` | Express app + routes (exported for tests) |
| `src/db.js` | pg pool, `migrate()`, NUMERIC->number parser |
| `src/rules.js` | `isDemoDecline`, `roundMoney` (the `.13` rule) |
| `src/schema.sql` | table definitions |
| `test/payments.test.mjs` | Phase 1 DoD as `node --test` cases |
