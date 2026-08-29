// One-shot schema migration. `npm run migrate -w @cca/payments`.

import { migrate, pool } from "./db.js";

migrate()
  .then(() => {
    console.log("[payments] schema migrated");
    return pool.end();
  })
  .catch((err) => {
    console.error("[payments] migration failed:", err.message);
    process.exit(1);
  });
