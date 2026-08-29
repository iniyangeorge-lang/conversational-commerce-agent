// Feed-URL ingest: the merchant points us at a product feed (CSV or JSON) and we
// pull it. Same normalisation pipeline as the CSV upload - `header-map.js` maps
// whatever columns / keys the feed uses onto the canonical Product fields.
//
// This is the "connect a commerce API" path. Scheduled re-sync is a documented
// follow-up; today it is a manual "fetch & import".

import { parseProductsCsv } from "./csv.js";
import { mapRow } from "./header-map.js";
import { normalizeProduct } from "./normalize.js";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;

/** Reject non-public / SSRF-prone URLs before we fetch. */
export function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("feed URL is not valid");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("feed URL must be http(s)");
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (privateHost) throw new Error("feed URL must point at a public host");
  return u;
}

export async function fetchFeed(url, fetchImpl = fetch) {
  assertPublicUrl(url);
  const res = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    headers: { accept: "text/csv, application/json, */*", "user-agent": "cca-catalog-feed/1" },
  });
  if (!res.ok) throw new Error(`feed responded ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("feed is larger than 5 MB");
  return { text: buf.toString("utf8"), contentType: (res.headers.get("content-type") || "").toLowerCase() };
}

const asArray = (data) =>
  Array.isArray(data) ? data
    : Array.isArray(data?.products) ? data.products
    : Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.data) ? data.data
    : null;

/**
 * @param {{ merchant_id, category?, url, overrides?, fetchImpl? }} req
 * @returns {Promise<{ products, errors, format, fetched }>}
 */
export async function importFeed({ merchant_id, category, url, overrides = {}, fetchImpl }) {
  const { text, contentType } = await fetchFeed(url, fetchImpl);
  const looksJson = contentType.includes("json") || /^\s*[[{]/.test(text);

  if (looksJson) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("feed looked like JSON but did not parse");
    }
    const rows = asArray(data);
    if (!rows) throw new Error("JSON feed must be an array, or { products: [...] } / { items: [...] }");
    const products = [];
    const errors = [];
    rows.forEach((raw, i) => {
      try {
        products.push(normalizeProduct(mapRow(raw, overrides), { merchant_id, category }));
      } catch (err) {
        errors.push({ row: i + 1, message: err.message });
      }
    });
    return { products, errors, format: "json", fetched: rows.length };
  }

  const { products, errors } = parseProductsCsv(text, { merchant_id, category, overrides });
  return { products, errors, format: "csv", fetched: products.length + errors.length };
}
