// Phase 4 agent service entrypoint.

import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Load configuration before importing modules that construct database/client
// defaults, so a repo-root .env overrides the documented local defaults.
const { createApp } = await import("./app.js");
const { createDefaultAgent } = await import("./agent.js");
const { createDefaultTrust } = await import("./trust.js");

const port = Number(process.env.AGENT_PORT ?? 4003);
const agent = createDefaultAgent();
const trust = createDefaultTrust({ store: agent.store, catalog: agent.catalog });

trust.migrate()
  .then(() => {
    const server = createApp(agent, trust);
    server.listen(port, () => {
      console.log(`[agent] service listening on :${port}`);
      const provider = agent.llmProvider();
      console.log(
        provider
          ? `[agent] chat model: ${provider} (${process.env.LLM_MODEL ?? (provider === "openai" ? "gpt-4o" : "claude-sonnet-5")})`
          : "[agent] no LLM key set - using the deterministic offline planner",
      );
    });

    const shutdown = (signal) => {
      console.log(`[agent] ${signal} received - shutting down`);
      server.close(async () => {
        await trust.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error(`[agent] failed to start: ${err.message}`);
    process.exit(1);
  });
