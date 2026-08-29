// HTTP transport for the Phase 4 agent and Phase 5 trust layer. The payment
// route is intentionally absent; only the explicit checkout endpoint can call
// the payments service.

import http from "node:http";
import { createDefaultAgent } from "./agent.js";
import { createDefaultTrust } from "./trust.js";

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

export function createApp(agent = createDefaultAgent(), trust = createDefaultTrust({ store: agent.store, catalog: agent.catalog })) {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { status: "ok" });
    const isChat = req.method === "POST" && req.url === "/chat";
    const isConfirm = req.method === "POST" && req.url === "/checkout/confirm";
    const isCancel = req.method === "POST" && req.url === "/checkout/cancel";
    const isPaymentMethod = req.method === "POST" && req.url === "/checkout/payment-method";
    const isAudit = req.method === "GET" && req.url.startsWith("/checkout/audit/");
    if (!isChat && !isConfirm && !isCancel && !isPaymentMethod && !isAudit)
      return send(res, 404, { error: { code: "not_found", message: `no route for ${req.method} ${req.url}` } });

    try {
      if (isAudit) {
        const sessionId = decodeURIComponent(req.url.slice("/checkout/audit/".length));
        return send(res, 200, { session_id: sessionId, entries: await trust.auditForSession(sessionId) });
      }
      const request = await readJson(req);
      const response = isChat
        ? await agent.handle(request)
        : isConfirm
          ? await trust.confirm(request)
          : isCancel
            ? await trust.cancel(request)
            : await trust.tokenizePaymentMethod(request);
      return send(res, 200, response);
    } catch (err) {
      const status = err.status ?? (/request|message|session|merchant|card/.test(err.message) ? 422 : 500);
      return send(res, status, { error: { code: err.code ?? (status === 422 ? "invalid_request" : "internal_error"), message: err.message } });
    }
  });
}
