// HTTP client for the catalog service's Phase 3 API.

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
      const message = body?.error?.message ?? `catalog request failed (${response.status})`;
      throw new Error(message);
    }
    return body;
  }

  async getMerchant(merchantId) {
    const body = await this.request(`/merchants/${encodeURIComponent(merchantId)}`);
    return body.merchant;
  }

  async searchProducts(merchantId, params) {
    return this.request(`/merchants/${encodeURIComponent(merchantId)}/search`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async listProducts(merchantId) {
    const body = await this.request(`/merchants/${encodeURIComponent(merchantId)}/products`);
    return body.products ?? [];
  }
}
