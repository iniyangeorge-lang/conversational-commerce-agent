// HTTP client for the catalog service (marketplace).

const jsonHeaders = { "content-type": "application/json" };

export class CatalogClient {
  constructor(baseUrl = process.env.CATALOG_URL ?? "http://localhost:4002") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...jsonHeaders, ...(options.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `catalog request failed (${response.status})`);
    }
    return body;
  }

  /** The merchant, or null if it does not exist. Genuine errors still throw. */
  async getMerchant(merchantId) {
    try {
      const body = await this.request(`/merchants/${encodeURIComponent(merchantId)}`);
      return body.merchant ?? null;
    } catch (err) {
      if (/not found|no such merchant|\(404\)/i.test(err.message)) return null;
      throw err;
    }
  }

  /** Marketplace search - spans every merchant; results carry merchant_id + merchant_name. */
  async searchProducts(params) {
    return this.request("/search", { method: "POST", body: JSON.stringify(params) });
  }

  async listProducts(merchantId) {
    const body = await this.request(`/merchants/${encodeURIComponent(merchantId)}/products`);
    return body.products ?? [];
  }

  /** One product, looked up within its merchant. Null if not found. */
  async getProduct(merchantId, productId) {
    const products = await this.listProducts(merchantId);
    return products.find((p) => p.product_id === productId) ?? null;
  }
}
