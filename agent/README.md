# @cca/agent - AI shopping agent

The core of the build. A conversational **personal shopping assistant** for a
**marketplace**: it asks progressive clarifying questions, maintains a structured
shopper profile, recommends with explanations, compares options, builds one cart
whose lines carry their own `merchant_id`, and - only on explicit user
confirmation - produces a checkout preview grouped by store. The trust layer then
fans out into one card charge per merchant.

The model proposes; the app validates. Every recommended product is re-checked
against the live catalogue (exists / in stock / authoritative price) before it
reaches the shopper, and all totals are computed server side.

## Run

Start Postgres and Redis, seed the catalog, and start the catalog service:

```bash
docker compose up -d
npm install
npm run seed -w @cca/catalog
npm run dev -w @cca/catalog
npm run dev -w @cca/agent
```

The agent listens on `http://localhost:4003`. Copy `.env.example` to `.env` and
set a key to enable the tool-calling loop:

- `OPENAI_API_KEY` + `LLM_MODEL=gpt-4o` → OpenAI Chat Completions
- `ANTHROPIC_API_KEY` + `LLM_MODEL=claude-sonnet-5` → Anthropic Messages

`LLM_PROVIDER` (`openai` | `anthropic`) forces one when both keys are present;
otherwise it's auto-detected. With **no** key the server uses a deterministic
offline planner (used by demos and the unit tests). Set `AGENT_URL` and run
`npm run convo -w @cca/agent` for the scripted search → add → checkout-preview flow.

## HTTP API

`POST /chat` accepts the shared `ChatRequest` shape (`merchant_id` is optional -
the marketplace does not fix one):

```json
{
  "session_id": "demo_1",
  "message": { "kind": "text", "text": "waterproof hiking boots under $150" }
}
```

Card / cart-control clicks use a structured action (no LLM round-trip). It
carries the `merchant_id` from the search result; `size` is required for apparel
that lists sizes. `action` is `add_to_cart` (product card) or `update_cart_item`
(the cart's −/+/Remove controls - `quantity: 0` removes the line):

```json
{
  "kind": "action",
  "action": "add_to_cart",
  "merchant_id": "merchant_123",
  "product_id": "prod_007",
  "quantity": 1,
  "size": "10",
  "color": "black"
}
```

The shopper can also edit the cart in plain language ("remove the trail runner",
"change the boots to 2") - the model calls `update_cart_item`; the offline
planner handles the same phrasings.

`GET /health` is available for local orchestration. Sessions are JSON values in
Redis under `cca:agent:session:<session_id>`. The service falls back to an
in-memory store if Redis is not reachable, so the agent remains usable during
development; restart loses those in-memory sessions.

## Trust & consent API (Phase 5)

The agent service also hosts the trust layer. The browser uses these endpoints;
the LLM never has access to them as tools:

| Method | Path | Purpose |
|---|---|---|
| POST | `/profile/forget` | `{ session_id, key, value? }` → drop one `ShopperProfile` preference (the widget's "×" on a "What I know" chip). For a list field, `value` removes just that entry. Returns `{ session_id, profile }`. |
| POST | `/checkout/payment-method` | Tokenize a card through the payments service; only the token and last-4 are stored in the session. |
| POST | `/checkout/confirm` | Rebuild + revalidate every merchant's slice of the cart, then charge each merchant separately. |
| POST | `/checkout/cancel` | Cancel the pending confirmation and write a cancel audit entry. |
| GET | `/checkout/audit/:session_id` | Inspect the demo audit trail (one row per merchant charge). |

`/checkout/confirm` does not accept an amount from the client. The server reads
the session cart, groups it by merchant, re-checks each merchant's current
prices/availability + tax rate, and issues one idempotent `/mock-visa/charge`
per merchant (`order_ref = ord_<session>_<cart>_<merchant>_<attempt>`). The
result is `{ outcome: "completed", charges: [...], approved_total }` - a decline
in one store does not block the rest, and only the settled merchants' items are
cleared from the cart. There is no step-up. Audit rows land in `checkout_audit_log`.

## `ChatResponse`

Beyond `messages`, every response carries:

- **`agent_activity: string[]`** - a human-readable trail of what the agent did
  this turn (`🔎 Searched…`, `📝 Noted — budget ≤ $140`, `✅ Recommended 2 of 6`,
  `↔️ Compared 2 products`, `🛒 Added…`, `🧾 Prepared the checkout preview`). The
  widget shows it in the "Activity" panel.
- **`profile: ShopperProfile`** - the structured preferences the agent is working
  from (budget, primary_use, priorities, required_features, size…). The widget
  renders it as chips ("What I know").

Message types: `text`, `product_carousel`, `recommendation` (cards + match score
+ ✓ reasons + trade-offs), `comparison` (side-by-side table), `choices` (a
clarifying question with tappable options), `cart`, `transaction_preview`.

## Tools (function-calling schema)

| Tool | Does |
|---|---|
| `save_shopper_profile` | Merge changed preference fields into the session profile (or drop fields via `clear: [...]`). Called as soon as the shopper reveals or retracts a preference. |
| `ask_clarifying_question` | One progressive question + 2-6 tappable options. Renders as a `choices` message. |
| `search_products` | Marketplace catalogue search (`POST /search`, all merchants). Results carry `merchant_id` + `merchant_name`; out-of-stock dropped. |
| `get_product` | Full detail for one product. |
| `recommend_products` | An explained shortlist (1-4). Model supplies match_score / reasons / tradeoffs; **the app re-validates each product and substitutes the catalogue's price.** Renders as a `recommendation` message. |
| `compare_products` | 2-4 products → a `comparison` table (rows derived from real product fields). |
| `add_to_cart` | `merchant_id` + `product_id` + `quantity` (+ `size`/`color`). Size required for apparel; lines keyed by merchant + product + size + colour. |
| `update_cart_item` | Change a line's quantity, or remove it with `quantity: 0`. |
| `get_cart_summary` | The cart, grouped by merchant, + running subtotal. |
| `request_checkout` | Trigger the trust layer to show the grouped confirmation card. **Does NOT charge.** The response is the preview card alone - model text that turn is stripped. |

**There is no `charge_payment` / `purchase` tool.** The `/mock-visa/charge` calls
live in the trust layer, triggered by the UI confirm button only.

## System prompt

`src/prompt.js` - shopping-assistant persona + rules: progressive questioning
(one useful question at a time, don't interrogate, skip straight to search when
the shopper already gave enough), maintain the profile, present products via
`recommend_products` not prose, never fabricate a spec, pass merchant_id /
product_id back exactly as given, never guess a size, never call
`request_checkout` until the shopper explicitly asks to buy.

## State machine (Redis, per session)

`browsing -> clarifying -> comparing -> cart_building -> awaiting_confirmation -> paid | declined | abandoned`

`request_checkout` is rejected unless state is `cart_building` and the cart is non-empty.

## DoD

`npm run convo -w @cca/agent` runs a scripted search -> pick -> add -> checkout flow
end-to-end against seed data, before the frontend exists.

The Phase 4 unit tests use a fake catalog and the offline planner, so they do
not require Postgres, Redis, or an LLM key:

```bash
npm test -w @cca/agent
```

After starting the catalog, payments, and agent services, the Phase 5 smoke
flow exercises tokenization → preview → explicit confirm → approved payment:

```bash
npm run trust:convo -w @cca/agent
```

Contracts: `@cca/contracts` -> `src/agent.ts`.
