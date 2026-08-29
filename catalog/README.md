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

Config: `CATALOG_PORT` (4002), `DATABASE_URL`, `EMBEDDING_PROVIDER` for search,
and for the paste-to-extract path `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
(`EXTRACT_PROVIDER` forces one; `EXTRACT_MODEL` / `EXTRACT_MODEL_OPENAI` set the
model).

## Merchant onboarding

Four ways to get a catalog in - all funnel through the same
`header-map.js → normalize.js → upsert` pipeline:

1. **CSV upload** (`/products/csv`) - headers in any order; `header-map.js` maps
   common aliases (`SKU`→`product_id`, `Product Name`→`name`,
   `Selling Price`→`price`, `Stock Status`→`availability` with "in stock" /
   "low stock" / "out of stock" parsing, …). Unknown columns become lowercase
   attributes; merchant-internal ones (cost, supplier, reorder level) are
   dropped. A `category` value that isn't one of the four is kept as
   `product_type`. `/products/preview` returns the detected mapping + a sample so
   the dashboard can show it and let the merchant override any column.
2. **Feed URL** (`/products/import-feed`) - point at a public CSV or JSON product
   feed; same mapping. SSRF-guarded (no localhost / private IPs, ≤ 5 MB). Manual
   "fetch & import" today; scheduled re-sync is a documented follow-up.
3. **Paste a list** (`/products/extract`) - raw text (a menu, a price sheet) →
   LLM → structured products for review → `/products` to save.
4. **Batch API** (`/products`) - `{ products: [...] }`, also mapped + normalized.

`/ai-shopping { enabled }` is the merchant's "go live" switch - when off, the
marketplace `/search` skips the store (the dashboard still shows everything).

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
| POST | `/merchants/:merchant_id/products/csv` | 🔒 `text/csv` body **or** `{ csv, overrides? }` -> `{ inserted, updated, errors }`. Columns are auto-mapped (`header-map.js`). |
| POST | `/merchants/:merchant_id/products/preview` | 🔒 `{ csv, overrides? }` -> `{ mapping, sample, ready, skipped, total, errors }` — non-persisting "map columns" step for the dashboard |
| POST | `/merchants/:merchant_id/products/import-feed` | 🔒 `{ url, overrides? }` -> fetch a **public** CSV or JSON product feed, map + upsert -> `{ inserted, updated, format, fetched, errors }` |
| POST | `/merchants/:merchant_id/products/extract` | 🔒 `{ text \| raw_text, category? }` -> `{ products, errors }` (LLM: Anthropic or OpenAI; **does not persist**) |
| POST | `/merchants/:merchant_id/products` | 🔒 `{ products: [...] }` -> normalize + upsert |
| GET | `/merchants/:merchant_id/products` | `{ count, products[] }` (all of them - unaffected by the go-live toggle) |
| POST | `/merchants/:merchant_id/ai-shopping` | 🔒 `{ enabled: boolean }` -> `{ merchant }`. Off = the marketplace search skips this store. |
| POST | `/merchants/:merchant_id/search` | `{ query, max_price?, filters?, rank_hints? }` -> `{ query, results[] }` |
| POST | `/merchants/:merchant_id/embed` | `{ force? }` -> rebuild this merchant's embeddings |

Auth = scrypt password hashing + a stateless HS256 JWT signed with `AUTH_SECRET`
(the payments service verifies transaction-history requests with the same secret).
`src/auth.js`. `createApp({ auth: false })` disables the guard for tests.
`npm run seed` creates two stores + a login each:
`demo@soleandstride.example` and `demo@nimbusathletics.example`, both `demo1234`.

Contract shapes: `@cca/contracts` -> `src/catalog.ts`.

## Search (Phase 3, refined)

`searchProducts(merchant_id | null, { query, max_price?, filters?, rank_hints? })`.
The agent calls `POST /search` (merchant_id = null) so results span every store
and each carries `merchant_id` + `merchant_name`. `POST /merchants/:id/search`
scopes to one.

**Pipeline** (`src/search.js`):

1. **Hard filters** — boolean keep/drop, applied first:
   - `filters.category`, `max_price` (top-level or `filters.max_price`),
     `filters.available_only` (**default true**), `filters.brand` (contains).
   - Attribute-contains: `size`, `color`, `dietary`, `material`, and the footwear
     refinements `activity` (road/trail/gym/walking/casual), `cushioning`
     (minimal/balanced/high/max), `width` (narrow/regular/wide), `closure`
     (lace/slip-on/velcro), `support` (neutral/stability).
   - `filters.waterproof: true|false`.
   - Numeric ranges: `filters.drop_mm` / `filters.weight_g` as `{ min?, max? }`.
   - `filters.exclude: { key: value }` — drop matches.
2. **Blended rank** of the survivors (query non-empty):
   `0.55·cosine + 0.20·title-token-overlap + 0.20·profileMatch + 0.05·priceHeadroom`
   where `profileMatch` scores the product's text/attributes against
   `rank_hints.priorities` / `required_features` / `primary_use` (from the
   shopper's profile — the agent attaches these automatically), and
   `priceHeadroom` gently prefers items comfortably under budget. `rank_hints`
   **never filter**. Empty `query` -> skip embeddings, browse cheapest-first.
3. Return the **top 5**, each with its `score`.

### Embeddings

Provider is pluggable (`src/embedder.js`). Each product's stored vector is a
**weighted blend of per-field vectors** (`src/embeddings.js`):

```
vector = normalize( 0.5·title  +  0.3·description  +  0.2·facets )
         title  = name + brand
         facets = category + every attribute value ("activity: trail" …)
```

So a name/brand match counts for more than a mention buried in prose, and a
product with a thin (or empty) description still gets a clean unit vector - an
absent field just drops out of the blend. The query is embedded as-is and
compared with cosine. `DOC_VERSION` in `embeddings.js` tags every stored vector
(`hash-v2#mf1`); bump it to force a rebuild across all providers when the fields
or weights change.

| `EMBEDDING_PROVIDER` | What |
|---|---|
| `hash` (default) | zero-dependency, offline, deterministic lexical embedding (word tokens + char trigrams -> 512-d, L2-normalized). Good when the query and catalogue share vocabulary. Version tag `hash-v2`. |
| `voyage` | real semantic embeddings via api.voyageai.com; **auto-selected** when `VOYAGE_API_KEY` is set. |
| `openai` | real semantic embeddings, `text-embedding-3-small`. **Opt-in only**: set `EMBEDDING_PROVIDER=openai` (reuses `OPENAI_API_KEY`, or `EMBEDDING_API_KEY`). Setting `OPENAI_API_KEY` for the chat model alone does not switch embeddings. |

Vectors live in `product_embeddings` as JSON (no pgvector - documented future swap);
cosine runs in-process. `seed` and every `/search` lazily backfill missing/stale
embeddings (stale = the stored `model` tag no longer matches the active provider).

Example (seeded data):

```
POST /search  { "query": "boots", "filters": { "waterproof": true, "activity": "trail" } }
  ->  prod_007  Waterproof Hiking Boot   $159      (the only waterproof trail item)

POST /search  { "query": "a shoe for running",
                "rank_hints": { "priorities": ["cushioning"], "primary_use": "road running" } }
  ->  prod_004  Road Running Shoe (cushioning: high)   moves to #1
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
merchants(merchant_id PK, name, category, ai_enabled, spend_limit, step_up_threshold, tax_rate, created_at)
products(merchant_id -> merchants, product_id, name, description, brand, price NUMERIC(12,2),
         currency, category, image_url, attributes JSONB, availability, timestamps,
         PRIMARY KEY (merchant_id, product_id))
         -- attributes carries size/color arrays + footwear refinements
         -- (activity, waterproof, cushioning, width, closure, support, drop_mm, weight_g)
product_embeddings(merchant_id, product_id -> products, model, dim, vector JSONB, updated_at,
         PRIMARY KEY (merchant_id, product_id))
```

`product_id` is unique **within** a merchant. Schema applied on every boot
(`CREATE TABLE IF NOT EXISTS` + a few `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
for additive changes like `brand`); a structural change still means dropping the
tables in dev.

## Files

| File | Role |
|---|---|
| `src/app.js` | Express app + routes (`createApp({ extractor })` stubs the LLM) |
| `src/header-map.js` | source column / key -> canonical `Product` field (aliases, overrides); unknown -> attribute |
| `src/normalize.js` | mapped row/object -> canonical `Product`, with validation |
| `src/csv.js` | `parseProductsCsv()` + `previewProductsCsv()` (mapping + sample, no persist) |
| `src/feed.js` | fetch a public CSV / JSON product feed -> mapped products (SSRF-guarded) |
| `src/extract.js` | raw text -> forced tool call (Anthropic **or** OpenAI) -> normalized products |
| `src/categories.js` | the four category templates |
| `src/embedder.js` | `hash` / `voyage` / `openai` providers + `cosine` + `l2normalize` |
| `src/embeddings.js` | `embedFields()` (weighted fields) + `backfillEmbeddings()` (batched, idempotent, blended) |
| `src/search.js` | `searchProducts()` - semantic rank + hard filters, top 5 |
| `src/repo.js` | merchant / product / embedding DB ops |
| `src/db.js`, `src/migrate.js` | Postgres |
| `src/seed.js`, `src/embed.js` | fixtures loader, embedding backfill CLI |
| `test/catalog.test.mjs`, `test/search.test.mjs` | Phase 2-3 DoD as `node --test` |
