// Merchant dashboard - a thin read-through view of the live services, gated by a
// merchant login (catalog issues the token; the token scopes every write and the
// payments transaction history).
(() => {
  const CATALOG = localStorage.getItem("cca:catalog-url") || "http://localhost:4002";
  const PAYMENTS = localStorage.getItem("cca:payments-url") || "http://localhost:4001";
  const TOKEN_KEY = "cca:merchant-token";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
  const money = (n, c = "USD") =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(Number(n) || 0);
  const rowMsg = (n, text) => `<tr><td colspan="${n}" class="muted" style="text-align:center;padding:22px">${esc(text)}</td></tr>`;
  const skeletonRows = (rows, cols) =>
    Array.from({ length: rows }, () =>
      `<tr>${Array.from({ length: cols }, (_, i) =>
        `<td><div class="skeleton sk" style="width:${i === 0 ? 70 : 40 + (i * 7) % 40}%"></div></td>`).join("")}</tr>`).join("");

  function toast(msg, type = "ok") {
    const box = $("#toasts");
    const t = document.createElement("div");
    t.className = `toast ${type === "err" ? "err" : ""}`.trim();
    t.innerHTML = `<span class="ic">${type === "err" ? "!" : "✓"}</span><span></span>`;
    t.lastChild.textContent = msg;
    box.append(t);
    setTimeout(() => { t.style.transition = "opacity .18s, transform .18s"; t.style.opacity = "0"; t.style.transform = "translateY(6px)"; setTimeout(() => t.remove(), 200); }, 3200);
  }
  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let merchant = null; // { merchant_id, name, category, ... }
  let lastProducts = [];

  const authHeaders = () => (token ? { authorization: `Bearer ${token}` } : {});

  async function req(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) { signOut(); throw new Error("Session expired - sign in again."); }
    if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
    return body;
  }

  // --- auth ---------------------------------------------------------------

  let mode = "login";
  const authForm = $("#auth-form");
  const authError = $("#auth-error");

  function setMode(next) {
    mode = next;
    const signup = mode === "signup";
    $("#auth-title").textContent = signup ? "Create your store" : "Sign in";
    $("#auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("#name-field").hidden = !signup;
    $("#category-field").hidden = !signup;
    $("#store-name-in").required = signup;
    $("#password-in").autocomplete = signup ? "new-password" : "current-password";
    $("#auth-toggle-text").textContent = signup ? "Already have an account?" : "New store?";
    $("#auth-toggle").textContent = signup ? "Sign in" : "Create an account";
    authError.textContent = "";
  }
  $("#auth-toggle").onclick = () => setMode(mode === "login" ? "signup" : "login");

  authForm.onsubmit = async (e) => {
    e.preventDefault();
    authError.textContent = "";
    const email = $("#email-in").value.trim();
    const password = $("#password-in").value;
    const submit = $("#auth-submit");
    submit.disabled = true;
    try {
      const path = mode === "signup" ? "/auth/signup" : "/auth/login";
      const payload = mode === "signup"
        ? { email, password, name: $("#store-name-in").value.trim(), category: $("#category-in").value }
        : { email, password };
      const body = await req(`${CATALOG}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      token = body.token;
      merchant = body.merchant;
      localStorage.setItem(TOKEN_KEY, token);
      toast(mode === "signup" ? "Store created" : `Signed in as ${merchant.name}`);
      showDashboard();
    } catch (err) {
      authError.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };

  $("#signout").onclick = signOut;
  function signOut() {
    token = null;
    merchant = null;
    localStorage.removeItem(TOKEN_KEY);
    $("#dashboard").hidden = true;
    $("#auth").hidden = false;
  }

  // --- dashboard ---------------------------------------------------------

  function mid() {
    return merchant?.merchant_id;
  }

  function showDashboard() {
    $("#auth").hidden = true;
    $("#dashboard").hidden = false;
    $("#store-name").textContent = merchant.name;
    $("#store-avatar").textContent = initials(merchant.name);
    document.title = `${merchant.name} — Merchant dashboard`;
    loadProducts();
    loadOrders();
  }

  async function loadProducts() {
    const tbody = $("#products");
    tbody.innerHTML = skeletonRows(4, 5);
    try {
      const { products, count } = await req(`${CATALOG}/merchants/${mid()}/products`);
      lastProducts = products;
      $("#cat-sub").textContent = `${count} product${count === 1 ? "" : "s"} the shopping agent can search.`;
      renderReadiness(products);
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
    } catch (err) {
      tbody.innerHTML = rowMsg(5, err.message);
      toast(err.message, "err");
    }
  }

  // --- AI shopping readiness -------------------------------------------

  function renderReadiness(products) {
    const dimsEl = $("#ready-dims");
    if (!products.length) {
      $("#ready-pct").textContent = "—";
      $("#ready-note").textContent = "Add products to see your score.";
      $("#ready-bar").style.width = "0";
      dimsEl.innerHTML = "";
      return;
    }
    const frac = (fn) => products.filter(fn).length / products.length;
    const dims = [
      ["Product information", frac((p) => p.name && (p.description || "").trim().length >= 20)],
      ["Pricing", frac((p) => Number(p.price) > 0 && p.currency)],
      ["Inventory", frac((p) => typeof p.availability === "boolean")],
      ["Specifications", frac((p) => p.attributes && Object.keys(p.attributes).length > 0)],
      ["Images", frac((p) => !!p.image_url)],
      ["Variants", frac((p) => Array.isArray(p.attributes?.size) || Array.isArray(p.attributes?.color))],
    ];
    const overall = Math.round((dims.reduce((s, [, v]) => s + v, 0) / dims.length) * 100);
    $("#ready-pct").textContent = `${overall}%`;
    $("#ready-note").textContent =
      overall >= 90 ? "Great — the agent has everything it needs." :
      overall >= 70 ? "Good. Fill the gaps below to improve recommendations." :
      "Some structured data is missing — see below.";
    $("#ready-bar").style.width = `${overall}%`;
    dimsEl.innerHTML = dims
      .map(([label, v]) => {
        const pct = Math.round(v * 100);
        const ok = pct >= 90;
        const missing = Math.round((1 - v) * products.length);
        const detail = ok ? "✓" : `⚠ ${missing} missing`;
        return `<li><span>${esc(label)}</span><span class="s ${ok ? "ok" : "warn"}">${esc(detail)}</span></li>`;
      })
      .join("");
  }

  $("#reload-ready").onclick = () => renderReadiness(lastProducts);

  // --- Connect-an-API demo (mock) -------------------------------------

  $("#api-test").onclick = () => {
    const note = $("#api-note");
    const url = $("#api-url").value.trim();
    const keyOk = $("#api-key").value.trim().length >= 4;
    let valid = false;
    try { valid = ["http:", "https:"].includes(new URL(url).protocol); } catch { valid = false; }
    if (!valid) { note.className = "note err"; note.textContent = "Enter a valid https:// endpoint."; return; }
    if (!keyOk) { note.className = "note err"; note.textContent = "Enter your API key (demo — anything 4+ chars)."; return; }
    note.className = "note";
    note.textContent = `✓ Connection successful — ${lastProducts.length} product${lastProducts.length === 1 ? "" : "s"} detected. (Demo: your CSV catalog is used; no real request was made.)`;
    toast("Connection successful");
  };

  async function loadOrders() {
    const tbody = $("#orders");
    tbody.innerHTML = skeletonRows(3, 5);
    try {
      const { transactions } = await req(`${PAYMENTS}/mock-visa/transactions/${mid()}`);
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
          .join("") || rowMsg(5, "No orders yet — they'll appear here after a shopper checks out.");
    } catch (err) {
      tbody.innerHTML = rowMsg(5, err.message);
    }
  }

  async function importCsv(file) {
    const note = $("#import-note");
    note.className = "note";
    note.textContent = `Importing ${file.name}…`;
    try {
      const body = await req(`${CATALOG}/merchants/${mid()}/products/csv`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: await file.text(),
      });
      const skipped = body.errors?.length ? `, ${body.errors.length} row(s) skipped` : "";
      note.className = "note";
      note.textContent = `Imported: ${body.inserted} new, ${body.updated} updated${skipped}.`;
      toast(`Imported ${body.inserted + body.updated} product${body.inserted + body.updated === 1 ? "" : "s"}`);
      loadProducts();
    } catch (err) {
      note.className = "note err";
      note.textContent = `Import failed: ${err.message}`;
      toast("Import failed", "err");
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

  // --- boot ------------------------------------------------------------

  setMode("login");
  if (token) {
    req(`${CATALOG}/auth/me`)
      .then((body) => { merchant = body.merchant; showDashboard(); })
      .catch(() => signOut());
  }
})();
