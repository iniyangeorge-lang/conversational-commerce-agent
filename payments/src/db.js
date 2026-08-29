// Postgres access for the mock Visa service.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

// Return NUMERIC (oid 1700) as a JS number rather than a string, so `amount`
// round-trips as a number. Fine for a mock; a real ledger would keep the string.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const connectionString =
  process.env.DATABASE_URL ?? "postgres://cca:cca@localhost:5432/cca";

export const pool = new pg.Pool({ connectionString });

pool.on("error", (err) => {
  console.error("[payments] postgres pool error:", err.message);
});

/** Run the schema. Idempotent - called on every boot. */
export async function migrate() {
  const sql = await readFile(path.join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

/** @type {(text: string, params?: unknown[]) => Promise<import("pg").QueryResult>} */
export const query = (text, params) => pool.query(text, params);
