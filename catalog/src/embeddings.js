// Embedding backfill: make sure every product has a current embedding of its
// name + description. Cheap and idempotent - skips products already embedded
// with the active model.

import { getEmbedder } from "./embedder.js";
import { getEmbeddingRows, listProducts, upsertEmbedding } from "./repo.js";

export const embedText = (p) => `${p.name}. ${p.description}`.trim();

/**
 * @param {string} merchant_id
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ embedded: number, total: number, model: string }>}
 */
export async function backfillEmbeddings(merchant_id, opts = {}) {
  const embedder = await getEmbedder();
  const products = await listProducts(merchant_id);
  const existing = new Map(
    (await getEmbeddingRows(merchant_id)).map((r) => [r.product_id, r]),
  );

  const todo = products.filter((p) => {
    const row = existing.get(p.product_id);
    return opts.force || !row || row.model !== embedder.id;
  });

  if (todo.length) {
    const vectors = await embedder.embed(todo.map(embedText));
    for (let i = 0; i < todo.length; i += 1) {
      await upsertEmbedding({
        merchant_id,
        product_id: todo[i].product_id,
        model: embedder.id,
        dim: vectors[i].length,
        vector: vectors[i],
      });
    }
  }

  return { embedded: todo.length, total: products.length, model: embedder.id };
}
