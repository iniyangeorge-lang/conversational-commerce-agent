# Conversational Commerce Agent — Visa Challenge

A chat-native **marketplace**: shoppers discover products across several
independent merchants, build one cart, and pay inside a single conversation -
with an **enforced** trust & consent layer around every payment.

**Demo data:** two footwear stores - **Sole & Stride** (8.25 % tax) and
**Nimbus Athletics** (7 % tax) - so a cross-merchant cart, one "Confirm & pay",
and a checkout that fans out into one card charge per merchant.

---

## Run it locally (< 5 minutes)

```bash
# 1. Infra (Postgres + Redis)
docker compose up -d          # or: npm run infra:up

# 2. Config
cp .env.example .env          # fill in ANTHROPIC_API_KEY

# 3. Dependencies
npm install                   # installs all workspaces

# 4. Seed the demo merchant + 18 products (after Phase 2 lands)
npm run seed -w @cca/catalog
```

Requires Node 20+ and Docker. Nothing is committed to `.env`.

---

## Monorepo layout

| Folder | Package | Phase | Responsibility |
|---|---|---|---|
| `contracts/` | `@cca/contracts` | 0 | **Shared types + JSON schemas.** Single source of truth for every inter-service contract. |
| `payments/` | `@cca/payments` | 1 | Mock Visa service: tokenize + charge/decline + transactions. Decline test cards. Idempotent on `order_ref`. |
| `catalog/` | `@cca/catalog` | 2–3 | Merchant onboarding (CSV + extract-from-text), normalized catalog, marketplace `search_products` (`POST /search`), merchant auth. |
| `agent/` | `@cca/agent` | 4 (+5) | AI **shopping assistant**: progressive clarifying questions, a structured shopper profile, explainable recommendations, comparison, conversational cart control, an activity trail — plus the trust & consent code path (`POST /checkout/confirm` fans out per merchant). |
| `frontend/` | `@cca/frontend` | 6 | Landing page + conversational-commerce widget (one thread: recommendation cards with match scores, comparison tables, quick-reply chips, a bag grouped by store, a grouped checkout card, toasts, a trust panel). Plus a merchant dashboard with an AI-readiness score. Shared design system in `theme.css`; no framework/build/font dependency. |
| `fixtures/` | — | 0 | Two demo merchants + their products (CSV). |

`docker-compose.yml` runs Postgres (`:5432`) and Redis (`:6379`).

---

## The one architectural rule

The agent's toolset has **no** `charge_payment` / `purchase` function. It can only
call `request_checkout`, which produces a confirmation card. The real
`/mock-visa/charge` call lives in the trust layer and fires **only** when the
user clicks "Confirm & pay" — never from an LLM tool call.

Never cut: the non-skippable confirmation card, the tokenized payment mock, and
the audit log.

---

## The four capabilities

| Capability | Where |
|---|---|
| **AI agent layer** | `agent/src/tools.js` — 10 controlled tools: `save_shopper_profile`, `ask_clarifying_question`, `search_products`, `get_product`, `recommend_products`, `compare_products`, cart tools, `request_checkout`. Progressive questioning + a live `ShopperProfile` + explainable recs (`match` score, ✓ reasons, trade-offs) in `agent/src/prompt.js` / `agent.js`. |
| **Merchant integration** | `catalog/` — signup, CSV upload, marketplace search. Dashboard (`frontend/src/merchant.*`) adds an **AI shopping readiness** score and a mock **Connect API** panel. |
| **Seamless payment** | Entirely in-conversation. `agent/src/trust.js` → `payments/` mock Visa. Card is tokenised (PAN never stored, never shown to the model); one charge per merchant. |
| **Trust, consent & transparency** | Server-authoritative totals; every recommended product re-validated against the live catalogue; `agent_activity[]` trail on every response; a **Trust & safety** panel in the widget; re-validation blocks a checkout whose cart or price changed after the preview; `checkout_audit_log` per attempt. |

**Trust boundary:** the model proposes (products, quantities, reasons); the app
disposes (existence, availability, price, totals). See `recommend_products` in
`agent/src/tools.js` and `authoritativePreview` in `agent/src/trust.js`.

---

## Build phases

0. **Setup & scaffolding** ← *this commit*
1. Mock Visa payment service
2. Merchant onboarding & catalog schema
3. Catalog search & recommendation
4. AI agent layer
5. Trust & consent layer
6. Chat frontend
7. End-to-end + failure-path testing
8. Demo & writeup

See `Detailed_Build_Plan.md` for the full plan.

---

## Phase 0 — Definition of done

- [x] Monorepo with `agent/`, `catalog/`, `payments/`, `frontend/` + root `docker-compose.yml` (Postgres + Redis).
- [x] Inter-service contracts written up front in `contracts/` (TS types + JSON schemas).
- [x] Shared `.env.example` (LLM key, Postgres URL, Redis URL, service URLs).
- [x] Demo category chosen: **footwear** (`fashion` category).
- [x] Test merchant seeded with 18 real-looking products (`fixtures/`).
- [ ] `docker compose up` verified on each machine; every team member has cloned the repo and reviewed `contracts/`.
