// Embedding providers for catalog search (Phase 3).
//
// "Any small embedding model is fine" (build plan). Two providers:
//   hash   - zero-dependency, deterministic, offline. Lexical similarity over
//            word tokens + character trigrams hashed into a fixed vector. Good
//            enough when the query and the catalogue share vocabulary.
//   voyage - real semantic embeddings via api.voyageai.com, used automatically
//            when VOYAGE_API_KEY is set (EMBEDDING_PROVIDER overrides).
//
// pgvector is a documented future swap; for a prototype we keep the vectors in
// Postgres as JSON and do cosine similarity in-process.

import { createHash } from "node:crypto";

const HASH_DIM = 512;

const STOPWORDS = new Set(
  "a an the of for and or with to in on at by from is are be this that it your you our".split(" "),
);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function charTrigrams(token) {
  const s = `#${token}#`;
  const grams = [];
  for (let i = 0; i + 3 <= s.length; i += 1) grams.push(s.slice(i, i + 3));
  return grams;
}

function bucket(feature) {
  const d = createHash("md5").update(feature).digest();
  return d.readUInt32BE(0) % HASH_DIM;
}

function hashEmbed(text) {
  const v = new Float64Array(HASH_DIM);
  for (const tok of tokenize(text)) {
    v[bucket(`w:${tok}`)] += 1;
    for (const g of charTrigrams(tok)) v[bucket(`g:${g}`)] += 0.5;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}

const hashProvider = {
  // Bump only when `hashEmbed` itself changes. Changes to *what* we embed
  // (fields, weights) are tracked by DOC_VERSION in embeddings.js instead, so a
  // doc-composition change rebuilds vectors for every provider, not just hash.
  id: "hash-v2",
  async embed(texts) {
    return texts.map(hashEmbed);
  },
};

function voyageProvider() {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY not set");
  const model = process.env.EMBEDDING_MODEL ?? "voyage-3-lite";
  return {
    id: `voyage:${model}`,
    async embed(texts) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ input: texts, model }),
      });
      if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
      const json = await res.json();
      return json.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}

function openaiProvider() {
  const key = process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("EMBEDDING_API_KEY / OPENAI_API_KEY not set");
  const model = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  return {
    id: `openai:${model}`,
    async embed(texts) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ input: texts, model }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
      const json = await res.json();
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

let cached;

/**
 * Resolve the configured embedding provider (memoized). Falls back to `hash`.
 *
 * Selection: EMBEDDING_PROVIDER (`hash` | `voyage` | `openai`) wins; otherwise
 * `voyage` iff VOYAGE_API_KEY is set, else `hash`. `openai` is opt-in only
 * (setting OPENAI_API_KEY for the chat model does NOT switch embeddings).
 */
export async function getEmbedder() {
  if (cached) return cached;
  const choice =
    process.env.EMBEDDING_PROVIDER ?? (process.env.VOYAGE_API_KEY ? "voyage" : "hash");
  const providers = { voyage: voyageProvider, openai: openaiProvider };
  if (providers[choice]) {
    try {
      cached = providers[choice]();
      return cached;
    } catch (err) {
      console.warn(`[catalog] ${choice} embedder unavailable (${err.message}) - using hash`);
    }
  }
  cached = hashProvider;
  return cached;
}

/** For tests: reset the memoized provider. */
export function resetEmbedder() {
  cached = undefined;
}

/** L2-normalise a vector to unit length (zero vector -> zeros). */
export function l2normalize(vec) {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return vec.map((x) => x / n);
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
