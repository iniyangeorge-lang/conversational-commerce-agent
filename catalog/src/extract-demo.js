// Manual check of the extract-from-text path against the live model.
// Needs ANTHROPIC_API_KEY. Does not touch the database - it just prints what
// Claude pulled out of a raw listing.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run extract:demo -w @cca/catalog

import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractProducts } from "./extract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const c of [path.resolve(here, "../../.env"), path.resolve(process.cwd(), ".env")]) {
  try {
    process.loadEnvFile(c);
    break;
  } catch {
    /* next */
  }
}

const SAMPLE = `
SOLE & STRIDE — NEW ARRIVALS

Trailhead GTX          waterproof hiking boot, Vibram outsole      $164.00   sizes 8–13, brown / black
Cloudline Runner       daily trainer, 8mm drop, breathable mesh    $138.00   sizes 7–12, blue / white / volt
Harbor Deck Shoe       hand-sewn moc, non-marking sole             $92.50    sizes 8–12, tan
Weekend Canvas Slip-On   cotton canvas, machine washable           $49.00    one colour (natural)
Sold out: Alpine Down Bootie
`;

const result = await extractProducts({
  merchant_id: "merchant_123",
  category: "fashion",
  raw_text: SAMPLE,
});

console.log(`\nextracted ${result.products.length} product(s), ${result.errors.length} skipped\n`);
console.log(JSON.stringify(result, null, 2));
