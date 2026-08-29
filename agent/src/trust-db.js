// Postgres persistence for the Phase 5 audit trail.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
pg.types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const connectionString = process.env.DATABASE_URL ?? "postgres://cca:cca@localhost:5432/cca";
export const pool = new pg.Pool({ connectionString });

pool.on("error", (err) => console.error("[agent] postgres pool error:", err.message));

export async function migrate() {
  const sql = await readFile(path.join(here, "trust-schema.sql"), "utf8");
  await pool.query(sql);
}

export async function insertAudit(entry) {
  await pool.query(
    `INSERT INTO checkout_audit_log
       (id, session_id, cart_id, cart_snapshot, amount_shown_to_user,
        confirmation_action, charge_response, resulting_status, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9)`,
    [
      entry.id,
      entry.session_id,
      entry.cart_id,
      JSON.stringify(entry.cart_snapshot),
      entry.amount_shown_to_user,
      entry.confirmation_action,
      entry.charge_response ? JSON.stringify(entry.charge_response) : null,
      entry.resulting_status,
      entry.created_at,
    ],
  );
}

export async function listAudit(sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM checkout_audit_log WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    cart_id: row.cart_id,
    cart_snapshot: row.cart_snapshot,
    amount_shown_to_user: Number(row.amount_shown_to_user),
    confirmation_action: row.confirmation_action,
    charge_response: row.charge_response,
    resulting_status: row.resulting_status,
    created_at: row.created_at.toISOString(),
  }));
}
