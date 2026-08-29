# @cca/catalog - Onboarding + normalized catalog (Phase 2)

Turn whatever a merchant provides into one normalized `Product` schema, store it
in Postgres. Phase 3 adds `search_products` on top.

## Run

```bash
docker compose up -d
npm run migrate -w @cca/catalog      # create tables
npm run seed    -w @cca/catalog      # load fixtures/ via the CSV path (18 products)
npm run dev     -w @cca/catalog      # http://localhost:4002 (auto-migrates on boot)
npm test        -w @cca/catalog      # needs Postgres; the LLM call is stubbed
```

Config: `CATALOG_PORT` (default `4002`), `DATABASE_URL`, `ANTHROPIC_API_KEY` +
`LLM_MODEL` (default `claude-sonnet-5`, from `.env.example`) for the extract path.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ status: "ok" }` when the DB is reachable |
| GET | `/categories` / `/categories/:category` | category templates (which attributes the agent asks about) |
| POST | `/merchants` | `{ merchant_id, name, category, spend_limit?, step_up_threshold?, tax_rate? }` -> upsert |
| GET | `/merchants/:merchant_id` | merchant + trust-layer config |
| POST | `/merchants/:merchant_id/products/csv` | body `text/csv` (or `{ csv }`). Fixed column order. -> `{ inserted, updated, errors }` |
| POST | `/merchants/:merchant_id/products/extract` | `{ raw_text, category? }` -> `{ products, errors }`. LLM extraction. **Does not persist** - products come back without `product_id` for review. |
| POST | `/merchants/:merchant_id/products` | `{ products: [...] }` -> normalize + upsert reviewed products |
| GET | `/merchants/:merchant_id/products` | `{ count, products[] }` |

Contract shapes: `@cca/contracts` -> `src/catalog.ts`.

## Onboarding paths

1. **CSV upload** - `product_id,merchant_id,name,description,price,currency,category,image_url,<attrs...>,availability`.
   Core columns map to the schema; any extra column (`size`, `color`, ...) becomes an
   attribute. Multi-valued attribute columns are `|`-separated. `merchant_id` in the
   row is ignored - the path parameter wins.
2. **Extract-from-text** - paste a menu / catalogue page as `raw_text`; Claude returns
   a structured product list via a forced tool call. Every candidate is run through the
   same normalizer as the CSV path; unpriced / malformed ones are reported in `errors`,
   not persisted. No-code merchant setup.
3. **Category template** - `POST /merchants` stores `category`; it drives which system
   prompt and refine-attributes the agent uses later (`src/categories.js`).

### Trying the extract path

Unit/integration tests stub the model. To exercise it for real:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run extract:demo -w @cca/catalog     # prints, no DB write
```

or against a running server:

```bash
curl -s -X POST localhost:4002/merchants/merchant_123/products/extract \
  -H 'content-type: application/json' \
  -d '{"raw_text":"Trailhead GTX waterproof boot $164, sizes 8-13. Cloudline Runner trainer $138."}'
```

## Data model

```
merchants(merchant_id PK, name, category, spend_limit, step_up_threshold, tax_rate, created_at)
products(merchant_id -> merchants, product_id, name, description, price NUMERIC(12,2),
         currency, category, image_url, attributes JSONB, availability, created_at, updated_at,
         PRIMARY KEY (merchant_id, product_id))
```

`product_id` is unique **within** a merchant, not globally. Schema is applied on every
boot (`CREATE TABLE IF NOT EXISTS`). Changing it means dropping the tables in dev.

## Files

| File | Role |
|---|---|
| `src/app.js` | Express app + routes (exported for tests; `createApp({ extractor })` stubs the LLM) |
| `src/normalize.js` | raw row/object -> canonical `Product`, with validation |
| `src/csv.js` | CSV text -> normalized products + per-row errors |
| `src/extract.js` | raw text -> Claude forced tool call -> normalized products |
| `src/categories.js` | the four category templates |
| `src/repo.js` | merchant + product upsert / read |
| `src/db.js` | pg pool, `migrate()` | 
| `src/seed.js` | fixtures/ -> Postgres via the CSV path |
| `test/catalog.test.mjs` | Phase 2 DoD as `node --test` cases |
