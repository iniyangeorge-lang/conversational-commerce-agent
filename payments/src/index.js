// Phase 1 - Mock Visa payment service entrypoint.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { migrate, pool } from "./db.js";

// Load .env from the repo root (npm runs workspace scripts with cwd = package
// dir, so cwd/.env would miss it). Missing file is fine - defaults cover local dev.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(here, "../../.env"),
  path.resolve(process.cwd(), ".env"),
]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    /* no file here - try the next */
  }
}

const PORT = Number(process.env.PAYMENTS_PORT ?? 4001);

migrate()
  .then(() => {
    const server = createApp().listen(PORT, () => {
      console.log(`[payments] mock Visa service listening on :${PORT}`);
    });

    const shutdown = (signal) => {
      console.log(`[payments] ${signal} received - shutting down`);
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error("[payments] failed to start:", err.message);
    process.exit(1);
  });
