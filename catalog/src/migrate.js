// One-shot schema migration. `npm run migrate -w @cca/catalog`.

import { migrate, pool } from "./db.js";

migrate()
  .then(() => {
    console.log("[catalog] schema migrated");
    return pool.end();
  })
  .catch((err) => {
    console.error("[catalog] migration failed:", err.message);
    process.exit(1);
  });
