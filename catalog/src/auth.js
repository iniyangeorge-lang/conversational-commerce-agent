// Merchant authentication for the dashboard.
//   - scrypt password hashing (node:crypto, no native deps)
//   - stateless HS256 JWT signed with AUTH_SECRET (shared with the payments service)
//
// The shopper-facing endpoints (search, product list, merchant lookup) stay open -
// only catalog writes and the payments transaction history require a merchant token.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET = process.env.AUTH_SECRET || "dev-insecure-secret-change-me";
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// --- passwords ---

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// --- tokens ---

const b64url = (input) => Buffer.from(input).toString("base64url");
const sign = (data) => createHmac("sha256", SECRET).update(data).digest("base64url");

export function signToken(payload, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

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

/** Read + verify the `Authorization: Bearer` token. Returns the payload or null. */
export function bearerAuth(req) {
  const header = (req.get && req.get("authorization")) || req.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? verifyToken(match[1]) : null;
}
