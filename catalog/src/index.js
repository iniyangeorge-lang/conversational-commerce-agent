// Phase 2-3 - Catalog service entrypoint.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { migrate, pool } from "./db.js";

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

const PORT = Number(process.env.CATALOG_PORT ?? 4002);

migrate()
  .then(() => {
    const server = createApp().listen(PORT, () => {
      console.log(`[catalog] service listening on :${PORT}`);
      if (!process.env.ANTHROPIC_API_KEY)
        console.warn("[catalog] ANTHROPIC_API_KEY not set - the extract-from-text path will fail until it is");
    });

    const shutdown = (signal) => {
      console.log(`[catalog] ${signal} received - shutting down`);
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error("[catalog] failed to start:", err.message);
    process.exit(1);
  });
