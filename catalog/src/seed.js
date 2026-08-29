// Load the demo fixtures into Postgres via the CSV onboarding path.
// Two merchants so the marketplace / cross-merchant cart can be demoed.
// `npm run seed -w @cca/catalog`

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, pool } from "./db.js";
import { parseProductsCsv } from "./csv.js";
import { createMerchantUser, getMerchantUser, upsertMerchant, upsertProducts } from "./repo.js";
import { backfillEmbeddings } from "./embeddings.js";
import { hashPassword } from "./auth.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures",
);

const STORES = [
  { merchant: "merchant.json", csv: "products.csv", login: { email: "demo@soleandstride.example", password: "demo1234" } },
  { merchant: "merchant2.json", csv: "products2.csv", login: { email: "demo@nimbusathletics.example", password: "demo1234" } },
];

async function seedStore({ merchant: merchantFile, csv: csvFile, login }) {
  const merchant = JSON.parse(await readFile(path.join(fixturesDir, merchantFile), "utf8"));
  await upsertMerchant(merchant);

  if (!(await getMerchantUser(login.email))) {
    await createMerchantUser({
      merchant_id: merchant.merchant_id,
      email: login.email,
      password_hash: hashPassword(login.password),
    });
  }

  const csvText = await readFile(path.join(fixturesDir, csvFile), "utf8");
  const { products, errors } = parseProductsCsv(csvText, {
    merchant_id: merchant.merchant_id,
    category: merchant.category,
  });
  for (const e of errors) console.error(`  [${merchantFile}] row ${e.row}: ${e.message}`);

  const { inserted, updated } = products.length
    ? await upsertProducts(products)
    : { inserted: 0, updated: 0 };
  console.log(
    `[catalog] ${merchant.name} (${merchant.merchant_id}): ${inserted} inserted, ${updated} updated` +
      `  ·  login ${login.email} / ${login.password}`,
  );
  return errors.length;
}

async function main() {
  await migrate();
  let bad = 0;
  for (const store of STORES) bad += await seedStore(store);

  const emb = await backfillEmbeddings(null); // every merchant
  console.log(`[catalog] embeddings: ${emb.embedded} generated (${emb.model}), ${emb.total} total`);

  await pool.end();
  if (bad) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[catalog] seed failed:", err);
  process.exit(1);
});
