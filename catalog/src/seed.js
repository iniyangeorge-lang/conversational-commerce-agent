// Load the demo fixtures into Postgres via the CSV onboarding path.
// `npm run seed -w @cca/catalog`

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, pool } from "./db.js";
import { parseProductsCsv } from "./csv.js";
import { upsertMerchant, upsertProducts } from "./repo.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures",
);

async function main() {
  await migrate();

  const merchant = JSON.parse(
    await readFile(path.join(fixturesDir, "merchant.json"), "utf8"),
  );
  await upsertMerchant(merchant);

  const csvText = await readFile(path.join(fixturesDir, "products.csv"), "utf8");
  const { products, errors } = parseProductsCsv(csvText, {
    merchant_id: merchant.merchant_id,
    category: merchant.category,
  });

  if (errors.length) {
    console.error("[catalog] seed CSV row errors:");
    for (const e of errors) console.error(`  row ${e.row}: ${e.message}`);
  }

  const { inserted, updated } = products.length
    ? await upsertProducts(products)
    : { inserted: 0, updated: 0 };

  console.log(
    `[catalog] seeded ${merchant.name} (${merchant.merchant_id}): ${inserted} inserted, ${updated} updated, ${errors.length} skipped`,
  );

  await pool.end();
  if (errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[catalog] seed failed:", err);
  process.exit(1);
});
