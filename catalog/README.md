# @cca/catalog - Onboarding + catalog + search (Phases 2-3)

## Phase 2 - onboarding

1. **CSV upload** - map columns to the normalized `Product` schema (fixed column order for the hackathon).
2. **Extract-from-text** - raw menu/page text -> LLM structured extraction -> `Product[]`. No-code merchant setup.
3. **Category template** - merchant picks `food` / `fashion` / `electronics` / `travel`; drives system prompt + extra attributes.

`products(product_id, merchant_id, name, description, price, currency, category, image_url, attributes JSONB, availability)`

## Phase 3 - search

`search_products(query, max_price?, filters?)`:
- semantic similarity over `name + description` embeddings (pgvector or in-memory numpy)
- hard filters on top: `category`, `price <= max_price`, `attributes.size contains X`, `availability = true`
- returns top 5, ranked

Exposed as a single internal function the agent calls as a tool.

## Seed

`npm run seed -w @cca/catalog` loads `fixtures/` into Postgres (the demo merchant + 18 products).

Contracts: `@cca/contracts` -> `src/catalog.ts`.
