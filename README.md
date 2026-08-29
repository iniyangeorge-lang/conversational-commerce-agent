# Conversational Commerce Agent — Visa Challenge

A chat-native storefront: shoppers discover, compare, and pay inside one
conversation, with an **enforced** trust & consent layer around every payment.

**Demo category:** footwear (Sole & Stride), modelled as the `fashion` category.
Rich product cards, a natural size/color refinement turn, and price points that
make the trust-layer paths (step-up, decline) easy to show on demand.

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
| `payments/` | `@cca/payments` | 1 | Mock Visa service: tokenize + charge/decline + transactions. `.13` demo decline. Idempotent on `order_ref`. |
| `catalog/` | `@cca/catalog` | 2–3 | Merchant onboarding (CSV + extract-from-text), normalized catalog, `search_products`. |
| `agent/` | `@cca/agent` | 4 (+5) | Conversational agent (function-calling), state machine, and the trust & consent code path (`POST /checkout/confirm`). |
| `frontend/` | `@cca/frontend` | 6 | Chat widget: one thread, inline product + transaction-preview cards. |
| `fixtures/` | — | 0 | Demo merchant (footwear) + 18 products (JSON + CSV). |

`docker-compose.yml` runs Postgres (`:5432`) and Redis (`:6379`).

---

## The one architectural rule

The agent's toolset has **no** `charge_payment` function. It can only call
`request_checkout`, which produces a confirmation card. The real
`/mock-visa/charge` call lives in the trust layer and fires **only** when the
user clicks "Confirm & pay" — never from an LLM tool call.

Never cut: the non-skippable confirmation card, the tokenized payment mock, and
the audit log.

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
