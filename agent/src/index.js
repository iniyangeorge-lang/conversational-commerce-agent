// Phase 4 agent service entrypoint.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createDefaultAgent } from "./agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(here, "../../.env"),
  path.resolve(process.cwd(), ".env"),
]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    /* no .env at this location - try the next one */
  }
}

const port = Number(process.env.AGENT_PORT ?? 4003);
const server = createApp(createDefaultAgent());
server.listen(port, () => {
  console.log(`[agent] service listening on :${port}`);
  if (!process.env.ANTHROPIC_API_KEY)
    console.warn("[agent] ANTHROPIC_API_KEY not set - using the offline planner");
});

function shutdown(signal) {
  console.log(`[agent] ${signal} received - shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
