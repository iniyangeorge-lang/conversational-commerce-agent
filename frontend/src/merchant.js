// Merchant dashboard - a thin read-through view of the live services.
//   catalog  (:4002)  store settings, product list, CSV import
//   payments (:4001)  order / transaction history
(() => {
  const CATALOG = localStorage.getItem("cca:catalog-url") || "http://localhost:4002";
  const PAYMENTS = localStorage.getItem("cca:payments-url") || "http://localhost:4001";
  const MERCHANT = new URLSearchParams(location.search).get("merchant") || "merchant_123";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
  const money = (n, c = "USD") =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(Number(n) || 0);

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const rowMsg = (n, text) => `<tr><td colspan="${n}" class="muted">${esc(text)}</td></tr>`;

  async function loadSettings() {
    try {
      const { merchant } = await getJSON(`${CATALOG}/merchants/${MERCHANT}`);
      $("#store-name").textContent = merchant.name;
      document.title = `${merchant.name} — Merchant dashboard`;
      $("#settings").innerHTML = [
        ["Category", merchant.category],
        ["Tax rate", `${(Number(merchant.tax_rate) * 100).toFixed(2)}%`],
        ["Step-up threshold", money(merchant.step_up_threshold)],
      ]
        .map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`)
        .join("");
    } catch {
      $("#settings").innerHTML = `<span class="muted">Catalog service not reachable at ${esc(CATALOG)}.</span>`;
    }
  }

  async function loadProducts() {
    const tbody = $("#products");
    tbody.innerHTML = rowMsg(5, "Loading…");
    try {
      const { products, count } = await getJSON(`${CATALOG}/merchants/${MERCHANT}/products`);
      $("#cat-sub").textContent = `${count} product${count === 1 ? "" : "s"} the shopping agent can search.`;
      tbody.innerHTML =
        products
          .map((p) => {
            const size = (p.attributes?.size || []).join(" / ");
            const color = (p.attributes?.color || []).join(", ");
            const opts = [size && `sizes ${size}`, color].filter(Boolean).join(" · ");
            return `<tr>
              <td><b>${esc(p.name)}</b><br><small>${esc(p.product_id)}</small></td>
              <td>${money(p.price, p.currency)}</td>
              <td>${esc(p.category)}</td>
              <td class="muted">${esc(opts) || "—"}</td>
              <td><span class="badge ${p.availability ? "ok" : "no"}">${p.availability ? "Yes" : "No"}</span></td>
            </tr>`;
          })
          .join("") || rowMsg(5, "No products yet — import a CSV below.");
    } catch {
      tbody.innerHTML = rowMsg(5, "Catalog service not reachable.");
    }
  }

  async function loadOrders() {
    const tbody = $("#orders");
    tbody.innerHTML = rowMsg(5, "Loading…");
    try {
      const { transactions } = await getJSON(`${PAYMENTS}/mock-visa/transactions/${MERCHANT}`);
      tbody.innerHTML =
        transactions
          .map((t) => {
            const ok = t.status === "approved";
            const label = ok ? "approved" : `declined · ${t.decline_reason}`;
            return `<tr>
              <td><small>${esc(t.id)}</small></td>
              <td>${money(t.amount, t.currency)}</td>
              <td><span class="badge ${ok ? "ok" : "no"}">${esc(label)}</span></td>
              <td><small>${esc(t.order_ref)}</small></td>
              <td class="muted">${new Date(t.created_at).toLocaleString()}</td>
            </tr>`;
          })
          .join("") || rowMsg(5, "No orders yet.");
    } catch {
      tbody.innerHTML = rowMsg(5, `Payments service not reachable at ${esc(PAYMENTS)}.`);
    }
  }

  async function importCsv(file) {
    const note = $("#import-note");
    note.className = "note";
    note.textContent = `Importing ${file.name}…`;
    try {
      const res = await fetch(`${CATALOG}/merchants/${MERCHANT}/products/csv`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: await file.text(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
      const skipped = body.errors?.length ? `, ${body.errors.length} row(s) skipped` : "";
      note.className = "note";
      note.textContent = `Imported: ${body.inserted} new, ${body.updated} updated${skipped}.`;
      loadProducts();
    } catch (err) {
      note.className = "note err";
      note.textContent = `Import failed: ${err.message}`;
    }
  }

  const drop = $("#drop");
  $("#choose").onclick = () => $("#file").click();
  $("#file").onchange = (e) => e.target.files[0] && importCsv(e.target.files[0]);
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }),
  );
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && importCsv(e.dataTransfer.files[0]));
  $("#reload-cat").onclick = loadProducts;
  $("#reload-ord").onclick = loadOrders;

  loadSettings();
  loadProducts();
  loadOrders();
})();
