// Backfill embeddings for every merchant. `npm run embed -w @cca/catalog`
// Pass --force to re-embed everything (e.g. after switching provider).

import { migrate, pool, query } from "./db.js";
import { backfillEmbeddings } from "./embeddings.js";

const force = process.argv.includes("--force");

async function main() {
  await migrate();
  const { rows } = await query(`SELECT merchant_id FROM merchants ORDER BY merchant_id`);
  if (!rows.length) console.log("[catalog] no merchants - nothing to embed");
  for (const { merchant_id } of rows) {
    const r = await backfillEmbeddings(merchant_id, { force });
    console.log(`[catalog] ${merchant_id}: embedded ${r.embedded}/${r.total} (${r.model})`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error("[catalog] embed failed:", err);
  process.exit(1);
});
