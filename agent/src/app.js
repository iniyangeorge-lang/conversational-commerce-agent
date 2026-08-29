// Minimal HTTP transport for the Phase 4 agent. It intentionally has no
// payment route: payment belongs to the Phase 5 trust layer.

import http from "node:http";
import { createDefaultAgent } from "./agent.js";

const MAX_BODY_BYTES = 1024 * 1024;

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(agent = createDefaultAgent()) {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { status: "ok" });
    if (req.method !== "POST" || req.url !== "/chat") return send(res, 404, { error: { code: "not_found", message: `no route for ${req.method} ${req.url}` } });

    try {
      const request = await readJson(req);
      const response = await agent.handle(request);
      return send(res, 200, response);
    } catch (err) {
      const status = /request|message|session|merchant/.test(err.message) ? 422 : 500;
      return send(res, status, { error: { code: status === 422 ? "invalid_request" : "internal_error", message: err.message } });
    }
  });
}
