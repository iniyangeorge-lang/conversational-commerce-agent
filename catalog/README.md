# @cca/catalog - Onboarding, normalized catalog, search (Phases 2-3)

Turn whatever a merchant provides into one normalized `Product` schema, store it
in Postgres, and expose `search_products` for the agent.

## Run

```bash
docker compose up -d
npm run migrate -w @cca/catalog      # create tables
npm run seed    -w @cca/catalog      # fixtures/ -> Postgres (CSV path) + embeddings
npm run embed   -w @cca/catalog      # (re)build embeddings for every merchant; --force to redo
npm run dev     -w @cca/catalog      # http://localhost:4002 (auto-migrates on boot)
npm test        -w @cca/catalog      # needs Postgres; LLM + embedder are offline in tests
```

Config: `CATALOG_PORT` (4002), `DATABASE_URL`, `ANTHROPIC_API_KEY` + `LLM_MODEL`
(`claude-sonnet-5`) for extract, `EMBEDDING_PROVIDER` for search.

## Endpoints

🔒 = needs `Authorization: Bearer <merchant token>` **for that merchant**. Everything
else is open (the shopping agent calls the reads with no token).

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | ok when the DB is reachable |
| POST | `/auth/signup` | `{ email, password, name, category, tax_rate?, step_up_threshold? }` -> `201 { token, merchant }` (creates a new `m_…` merchant) |
| POST | `/auth/login` | `{ email, password }` -> `{ token, merchant }` |
| GET | `/auth/me` | 🔒 -> `{ email, merchant }` |
| GET | `/categories` / `/categories/:category` | category templates |
| POST | `/search` | **marketplace search** - spans every merchant; results carry `merchant_id` + `merchant_name`. Used by the agent. |
| POST | `/merchants` | 🔒 update your own merchant config |
| GET | `/merchants` | list all merchants |
| GET | `/merchants/:merchant_id` | merchant + trust-layer config |
| POST | `/merchants/:merchant_id/products/csv` | 🔒 `text/csv` body -> `{ inserted, updated, errors }` |
| POST | `/merchants/:merchant_id/products/extract` | 🔒 `{ raw_text, category? }` -> `{ products, errors }` (LLM; **does not persist**) |
| POST | `/merchants/:merchant_id/products` | 🔒 `{ products: [...] }` -> normalize + upsert |
| GET | `/merchants/:merchant_id/products` | `{ count, products[] }` |
| POST | `/merchants/:merchant_id/search` | `{ query, max_price?, filters? }` -> `{ query, results[] }` (Phase 3) |
| POST | `/merchants/:merchant_id/embed` | `{ force? }` -> rebuild this merchant's embeddings |

Auth = scrypt password hashing + a stateless HS256 JWT signed with `AUTH_SECRET`
(the payments service verifies transaction-history requests with the same secret).
`src/auth.js`. `createApp({ auth: false })` disables the guard for tests.
`npm run seed` creates two stores + a login each:
`demo@soleandstride.example` and `demo@nimbusathletics.example`, both `demo1234`.

Contract shapes: `@cca/contracts` -> `src/catalog.ts`.

## Search (Phase 3)

`searchProducts(merchant_id | null, { query, max_price?, filters? })`. The agent
calls `POST /search` (merchant_id = null) so results span every store and each
carries `merchant_id` + `merchant_name`. `POST /merchants/:id/search` scopes to one.

- **Semantic rank**: cosine similarity of the query embedding vs each product's
  `name + description` embedding. Empty `query` -> filter-only browse, cheapest first.
- **Hard filters** (applied after ranking, they remove not re-rank):
  `filters.category`, `max_price` (top-level or `filters.max_price`),
  `filters.size` / `filters.color` / `filters.dietary` (attribute-contains),
  `filters.attributes: { key: value }` (generic), `filters.available_only`
  (**default true** - out-of-stock hidden unless set false).
- Returns the **top 5**, each with a `score`.

### Embeddings

"Any small model is fine." Provider is pluggable (`src/embedder.js`):

| `EMBEDDING_PROVIDER` | What |
|---|---|
| `hash` (default) | zero-dependency, offline, deterministic lexical embedding (word tokens + char trigrams -> 512-d, L2-normalized). Good when the query and catalogue share vocabulary. |
| `voyage` | real semantic embeddings via api.voyageai.com; auto-selected when `VOYAGE_API_KEY` is set. |

Vectors live in `product_embeddings` as JSON (no pgvector - documented future swap);
cosine runs in-process. `seed` and every `/search` lazily backfill missing embeddings.

Example (seeded data):

```
POST /merchants/merchant_123/search  { "query": "waterproof boots for muddy trails" }
  0.413  prod_007  Waterproof Hiking Boot   $159
  0.244  prod_003  Trail Running Shoe       $128
  0.240  prod_018  Insulated Winter Boot    $148
```

### Trying the extract path (needs a key)

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run extract:demo -w @cca/catalog
# or:
curl -s -X POST localhost:4002/merchants/merchant_123/products/extract \
  -H 'content-type: application/json' \
  -d '{"raw_text":"Trailhead GTX waterproof boot $164, sizes 8-13. Cloudline Runner $138."}'
```

## Data model

```
merchants(merchant_id PK, name, category, spend_limit, step_up_threshold, tax_rate, created_at)
products(merchant_id -> merchants, product_id, name, description, price NUMERIC(12,2),
         currency, category, image_url, attributes JSONB, availability, timestamps,
         PRIMARY KEY (merchant_id, product_id))
product_embeddings(merchant_id, product_id -> products, model, dim, vector JSONB, updated_at,
         PRIMARY KEY (merchant_id, product_id))
```

`product_id` is unique **within** a merchant. Schema applied on every boot
(`CREATE TABLE IF NOT EXISTS`); changing it means dropping the tables in dev.

## Files

| File | Role |
|---|---|
| `src/app.js` | Express app + routes (`createApp({ extractor })` stubs the LLM) |
| `src/normalize.js` | raw row/object -> canonical `Product`, with validation |
| `src/csv.js` | CSV text -> normalized products + per-row errors |
| `src/extract.js` | raw text -> Claude forced tool call -> normalized products |
| `src/categories.js` | the four category templates |
| `src/embedder.js` | `hash` / `voyage` providers + cosine |
| `src/embeddings.js` | `backfillEmbeddings(merchant_id)` - idempotent |
| `src/search.js` | `searchProducts()` - semantic rank + hard filters, top 5 |
| `src/repo.js` | merchant / product / embedding DB ops |
| `src/db.js`, `src/migrate.js` | Postgres |
| `src/seed.js`, `src/embed.js` | fixtures loader, embedding backfill CLI |
| `test/catalog.test.mjs`, `test/search.test.mjs` | Phase 2-3 DoD as `node --test` |
