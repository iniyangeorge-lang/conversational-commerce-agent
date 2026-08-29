# Conversational Commerce Agent — Visa Challenge

A **plug-and-play conversational commerce platform**. A shopper opens one chat
thread and discovers products across independent merchants, gets explained
recommendations, compares options, builds a cart, and **pays inside the
conversation** — no redirects — behind an *enforced* trust & consent layer.
Merchants get a no-code onboarding dashboard and a one-line `<script>` embed.

**Demo storefront:** two footwear stores — **Sole & Stride** (8.25 % tax) and
**Nimbus Athletics** (7 % tax), 26 products across brands Cadence / Voyager /
Heritage / Nimbus. A cross-merchant cart checks out behind one "Confirm & pay"
and fans out into one card charge per store.

---

## Run it locally (~5 minutes)

Needs **Node 20.6+** and **Docker**.

```bash
# 1. Infra — Postgres (:5432) + Redis (:6379)
npm run infra:up

# 2. Config — copy and add an LLM key (or leave it: the agent falls back
#    to a deterministic offline planner with no key at all)
cp .env.example .env          # set OPENAI_API_KEY  (or ANTHROPIC_API_KEY)

# 3. Install every workspace
npm install

# 4. Create tables + load the demo catalog + build embeddings
npm run setup

# 5. Start all four services (Ctrl-C stops them all)
npm run dev
```

Open **http://localhost:4173** — the storefront + chat widget.
Merchant dashboard: **http://localhost:4173/merchant**
(demo login `demo@soleandstride.example` / `demo1234`).

| Service | Port | |
|---|---|---|
| `payments` | 4001 | mock Visa — tokenize / charge / decline / transactions |
| `catalog` | 4002 | onboarding, normalized catalog, semantic search |
| `agent` | 4003 | the AI shopping agent **and** the trust & consent layer |
| `frontend` | 4173 | static server: storefront, widget, merchant dashboard |

Tests (need Postgres up): `npm test -w @cca/payments` · `-w @cca/catalog` ·
`-w @cca/agent` (70 total). Type-check everything: `npm run typecheck`.

---

## Architecture

```
                         Shopper
                            │  types / taps
                            ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  frontend  (:4173, static — no build, no framework)              │
 │  • widget.js  drop-in <script>, renders in a Shadow DOM:         │
 │      chat thread · recommendation cards (match score, reasons,   │
 │      trade-offs) · comparison tables · quick-reply chips ·       │
 │      cart grouped by store · in-chat checkout card · toasts      │
 │  • merchant.html/js  onboarding dashboard                        │
 └───────────────┬───────────────────────────┬──────────────────────┘
     POST /chat  │                           │  POST /checkout/*
 (structured actions too)                    │  (payment-method, confirm, cancel)
                 ▼                            ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  agent  (:4003)                                                   │
 │                                                                  │
 │  ┌─ AI agent layer ─ LLM tool-calling loop ──────────────────┐   │
 │  │  OpenAI Chat Completions · Anthropic Messages · or an      │   │
 │  │  offline deterministic planner (no key).                   │   │
 │  │  10 controlled tools: save_shopper_profile,                │   │
 │  │  ask_clarifying_question, search_products, get_product,    │   │
 │  │  recommend_products, compare_products, add_to_cart,        │   │
 │  │  update_cart_item, get_cart_summary, request_checkout.     │   │
 │  │            ┌──────────────────────────────────────────┐    │   │
 │  │            │  NO charge_payment / purchase tool.       │    │   │
 │  │            └──────────────────────────────────────────┘    │   │
 │  └───────────────┬───────────────────────────────────────────┘   │
 │       read-only  │ search / get product                          │
 │                  │                                               │
 │  ┌─ trust & consent layer ─ the ONLY caller of /mock-visa ───┐   │
 │  │  request_checkout →  grouped TransactionPreview            │   │
 │  │  /checkout/payment-method →  tokenize (PAN never stored)   │   │
 │  │  /checkout/confirm →  re-validate every line against the   │   │
 │  │     live catalogue → if unchanged, fan out ONE charge per  │   │
 │  │     merchant → write checkout_audit_log per attempt        │   │
 │  └───────────────────────────────┬──────────────────────────┘   │
 └────────┬──────────────────────────┼─────────────────────────────┘
  session │                          │  tokenize + charge
          ▼                          ▼
   Redis (:6379)          ┌──────────────────────┐   ┌───────────────────────┐
 cca:agent:session:<id>   │  catalog  (:4002)    │   │  payments (:4001)     │
 (24 h TTL; in-memory     │  onboarding ·        │   │  mock Visa            │
  fallback if no Redis)   │  header-map →        │   │  tokenize · charge /  │
                          │  normalize → upsert ·│   │  decline (idempotent  │
                          │  multi-field vector  │   │  on merchant+order_ref)│
                          │  search + filters    │   │  · per-merchant txns  │
                          └──────────┬───────────┘   └───────────┬───────────┘
                                     ▼                           ▼
                    Postgres (:5432) — merchants · products · product_embeddings
                                       payment_tokens · transactions · checkout_audit_log
```

**Repo layout** (npm workspaces):

| Folder | Package | Responsibility | Details |
|---|---|---|---|
| `contracts/` | `@cca/contracts` | TS types + JSON-schema mirrors — the single source of truth for every inter-service payload | [readme](contracts/README.md) |
| `payments/` | `@cca/payments` | Mock Visa: tokenize, charge/decline, transaction history. Zero-dependency logic, standalone. | [readme](payments/README.md) |
| `catalog/` | `@cca/catalog` | Merchant auth + 4 ingest paths + normalized `Product` schema + semantic `search_products`. | [readme](catalog/README.md) |
| `agent/` | `@cca/agent` | LLM tool-calling loop, conversation state (Redis), **and** the trust/consent checkout path. | [readme](agent/README.md) |
| `frontend/` | `@cca/frontend` | Storefront + Shadow-DOM chat widget + merchant dashboard + `theme.css`. No framework/build. | [readme](frontend/README.md) |
| `fixtures/` | — | The two demo stores + their product CSVs. | [readme](fixtures/README.md) |

**Stack:** Node ESM, plain `node:http` (agent) / Express (catalog, payments),
`pg`, Postgres 16, Redis 7. The only runtime dependencies anywhere are
`express`, `pg`, `csv-parse`, and `@anthropic-ai/sdk` (OpenAI is called over raw
`fetch`). The frontend ships nothing — `widget.js` / `merchant.js` / `theme.css`
import no libraries, no fonts, no build step.

### AI ↔ payments integration — the trust boundary

The agent **proposes**; the application **disposes**.

- The model's toolset has **no way to move money.** `request_checkout` only
  builds a preview card. `/mock-visa/charge` is reachable from exactly one place
  — `agent/src/trust.js` — and only from the `/checkout/confirm` HTTP endpoint
  the shopper's "Confirm & pay" button hits.
- Every product the model recommends is **re-fetched from the catalogue** and
  its price/availability substituted before it reaches the shopper
  (`recommend_products` in `tools.js`) — the model can't invent a spec, price or
  stock level.
- `/checkout/confirm` **ignores any client-supplied amount.** It rebuilds each
  merchant's slice of the cart from live catalogue data, re-applies tax, and
  charges that. If the cart or a price changed since the preview, it returns
  `blocked: cart_changed` and the shopper must review again.
- Charges are **idempotent** on `(merchant_id, order_ref)` — a retry or a double
  click never double-charges.

---

## Merchant onboarding flow

```
 sign up  ──▶  choose one ingest path  ──▶  header-map → normalize → upsert
 (email/pw/       │                              │
  category)       ├─ Upload CSV  — any headers; aliases auto-detected
                  │                 (SKU→product_id, Selling_Price→price,
                  │                  "In Stock"→availability…). A preview
                  │                  step shows the mapping and lets the
                  │                  merchant override any column.
                  ├─ Connect a feed — a public CSV or JSON product-feed URL
                  │                   (SSRF-guarded, ≤ 5 MB). Re-run to re-sync.
                  ├─ Paste a list  — raw text (a menu, a price sheet) → LLM →
                  │                   structured products → review → save.
                  └─ Batch API     — POST { products: [...] }
                                       │
                                       ▼
                          embeddings auto-backfill on the next search
                                       │
                                       ▼
                    AI-readiness score (product info · pricing · inventory ·
                      specs · images · variants → overall %)
                                       │
                                       ▼
                         Live / Paused toggle  ("go live")
                   off ⇒ the marketplace search skips this store;
                         the dashboard still shows everything.
```

Unknown columns become lowercase attributes; merchant-internal ones (cost,
supplier, reorder level) are dropped; a category value outside the four
supported (`food / fashion / electronics / travel`) is kept as `product_type`.
Everything funnels through one pipeline so all four paths behave identically.
Full endpoint list: [catalog/README.md](catalog/README.md).

---

## Trust, consent & transparency

| Safeguard | How |
|---|---|
| **Agent can't transact** | No `charge_payment` tool. Architectural, not a prompt rule. |
| **Explicit authorization** | The checkout card is non-dismissible-by-chat and its button reads **`Confirm & pay $X`** — never "Next" / "Continue". Nothing is charged until it's clicked. |
| **Transaction preview** | Grouped by store: per-merchant items, subtotal, tax, and a grand total. Delivered on its own turn with no agent chatter. |
| **Server-authoritative totals** | `/checkout/confirm` recomputes everything from live catalogue data and ignores the client. |
| **Stale approval is void** | A cart or price change after the preview → `blocked: cart_changed` → the shopper re-reviews. |
| **Card safety** | PAN → Visa-style token at `/checkout/payment-method`; only the token + last-4 are kept, and the model never sees any of it. CVV stays in the browser. |
| **Audit trail** | `checkout_audit_log` — one row per charge attempt *and* per block, each with the full preview snapshot and the amount shown to the shopper. `GET /checkout/audit/:session_id`. |
| **Merchant revenue data** | Transaction history is gated behind the merchant's own JWT (`403` otherwise). |
| **In-widget disclosure** | An ⓘ panel in the chat header states what the agent can and cannot do. |

Conversation state machine (per session, in Redis):
`browsing → clarifying → comparing → cart_building → awaiting_confirmation → paid | declined | abandoned`.

**Not yet built** (called out in the problem statement): a simulated
identity-verification step and a delegated "spend up to $X this session"
pre-authorization. Every purchase is a fresh manual confirm.

---

## Demo walkthrough — discover → decide → pay

1. Open `http://localhost:4173`. In the chat: *"I need cushioned road-running
   shoes, around $140, size 10."*
2. The agent asks **one** clarifying question (tap a chip) instead of dumping a
   list, and records what it learns as chips in the sidebar ("What I know").
3. *"What do you recommend?"* → 2–3 **recommendation cards** with a match score,
   ✓ reasons tied to what you said, and honest trade-offs.
4. Tap **Compare** on two cards → **Compare 2 selected** → a side-by-side table
   plus the agent's verdict on which one fits *you*.
5. Pick a size on a card → **Add**. The bag (grouped by store) updates; a toast
   confirms. Add a second shoe from the other store for a cross-merchant cart.
6. *"Check out."* → the **preview card**: per-store subtotal + tax, one grand
   total, a card field + CVV, one **Confirm & pay $X**.
7. Card `4242 4242 4242 4242` → each store is charged separately →
   **`✓ Processed`**, approved items leave the cart, per-store result notices.
   (`4000 0000 0000 0002` declines — the cart keeps the declined store's items
   for a retry.)
8. **Merchant side:** `/merchant` → sign in → drop a CSV (even a messy
   real-world one) into **Upload CSV** → map columns → import → watch the
   readiness score → the products are searchable in the chat immediately.

Decline test cards and the full mock-Visa contract:
[payments/README.md](payments/README.md).

---

## Embed the widget on any site

```html
<script src="https://your-host/widget.js"
        data-agent-url="https://your-agent-host"
        data-currency="USD"></script>
```

Self-contained (Shadow DOM, no external requests beyond the agent API). It
persists the thread + a session id in `localStorage`; on reload it replays that
id and the agent restores authoritative state from Redis.

---

## Configuration (`.env`)

| Key | Purpose |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Agent chat loop. Neither set → deterministic offline planner. |
| `LLM_PROVIDER`, `LLM_MODEL` | Force a provider / model (else auto-detected). |
| `EMBEDDING_PROVIDER` | `hash` (default, offline) · `voyage` · `openai` (opt-in). |
| `EXTRACT_PROVIDER` | Which LLM structures a pasted product list. |
| `AUTH_SECRET` | Signs the merchant JWT (shared: catalog issues, payments verifies). |
| `DATABASE_URL`, `REDIS_URL` | Datastores (match `docker-compose.yml`). |

`.env` is git-ignored — never commit it.
