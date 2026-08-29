// Verify merchant tokens issued by the catalog service (shared AUTH_SECRET).
// Used only to gate the transaction-history endpoint (revenue data).

import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.AUTH_SECRET || "dev-insecure-secret-change-me";
const sign = (data) => createHmac("sha256", SECRET).update(data).digest("base64url");

export function verifyToken(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = sign(`${header}.${body}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearerAuth(req) {
  const header = (req.get && req.get("authorization")) || req.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? verifyToken(match[1]) : null;
}
