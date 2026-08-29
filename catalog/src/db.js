// Postgres access for the catalog service.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

// NUMERIC (oid 1700) -> JS number, so price/tax_rate round-trip as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const connectionString =
  process.env.DATABASE_URL ?? "postgres://cca:cca@localhost:5432/cca";

export const pool = new pg.Pool({ connectionString });

pool.on("error", (err) => {
  console.error("[catalog] postgres pool error:", err.message);
});

/** Run the schema. Idempotent - called on every boot and by the seed script. */
export async function migrate() {
  const sql = await readFile(path.join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

/** @type {(text: string, params?: unknown[]) => Promise<import("pg").QueryResult>} */
export const query = (text, params) => pool.query(text, params);
