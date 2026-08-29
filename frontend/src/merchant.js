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
    paintToggle();
    $("#paste-hint").textContent = "The catalog service structures it with an LLM (falls back to a clear error if no key is set).";
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
              <td><b>${esc(p.name)}</b>${p.brand ? ` <small>· ${esc(p.brand)}</small>` : ""}<br><small>${esc(p.product_id)}</small></td>
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

  // --- "Go live" toggle ---------------------------------------------------

  const aiToggle = $("#ai-toggle");
  function paintToggle() {
    const on = merchant?.ai_enabled !== false;
    aiToggle.checked = on;
    $("#ai-label").textContent = on ? "Live" : "Paused";
  }
  aiToggle.onchange = async () => {
    const enabled = aiToggle.checked;
    try {
      const { merchant: updated } = await req(`${CATALOG}/merchants/${mid()}/ai-shopping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      merchant = updated;
      paintToggle();
      toast(enabled ? "Your store is live for AI shopping" : "Paused — shoppers can't find your products");
    } catch (err) {
      aiToggle.checked = !enabled;
      toast(err.message, "err");
    }
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

  // --- catalog import: CSV / paste / feed -----------------------------

  const CANONICAL = ["product_id", "name", "description", "brand", "price", "currency", "category", "image_url", "size", "color", "availability"];
  const jsonPost = (path, body) =>
    req(`${CATALOG}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const note = (msg, err) => { const n = $("#import-note"); n.className = err ? "note err" : "note"; n.textContent = msg; };
  const clearPreview = () => { const p = $("#preview"); p.hidden = true; p.innerHTML = ""; };

  // tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-on", t === tab));
      document.querySelectorAll(".tabpane").forEach((p) => (p.hidden = p.id !== `pane-${tab.dataset.tab}`));
      clearPreview();
      $("#import-note").textContent = "";
    };
  });

  // --- CSV: upload -> preview + column map -> import ---
  let pendingCsv = null; // { text, overrides }

  async function previewCsv(text) {
    pendingCsv = { text, overrides: {} };
    note("Reading your file…");
    await renderPreview();
  }

  async function renderPreview() {
    let pv;
    try {
      pv = await jsonPost(`/merchants/${mid()}/products/preview`, { csv: pendingCsv.text, overrides: pendingCsv.overrides });
    } catch (err) { note(`Couldn't read the file: ${err.message}`, true); return; }
    $("#import-note").textContent = "";

    const opts = [...CANONICAL, "attribute", "ignore"];
    const rows = pv.mapping.map((m) => {
      const sel = m.kind === "ignored" ? "ignore" : m.kind === "attribute" ? "attribute" : m.target;
      const options = opts.map((o) => `<option value="${o}"${o === sel ? " selected" : ""}>${o === "attribute" ? "→ attribute" : o === "ignore" ? "— ignore" : o}</option>`).join("");
      return `<tr><td>${esc(m.source)}</td><td><select data-src="${esc(m.source)}">${options}</select></td></tr>`;
    }).join("");

    const missingReq = ["name", "price"].filter((f) => !pv.mapping.some((m) => m.target === f));
    const warn = missingReq.length
      ? `<span class="pill warn">no column mapped to ${missingReq.join(" & ")}</span>`
      : `<span class="pill ok">${pv.ready} ready</span>` + (pv.skipped ? ` <span class="pill warn">${pv.skipped} will be skipped</span>` : "");

    const sample = pv.sample.slice(0, 3)
      .map((p) => `<li><b>${esc(p.name || "—")}</b> · ${money(p.price)} ${p.brand ? "· " + esc(p.brand) : ""} ${(p.attributes?.size || []).length ? "· sizes " + esc((p.attributes.size).join("/")) : ""}</li>`)
      .join("");

    $("#preview").hidden = false;
    $("#preview").innerHTML = `
      <h4>Column mapping — ${pv.total} rows</h4>
      <table class="map-table"><tbody>${rows}</tbody></table>
      <div>${warn}</div>
      ${sample ? `<h4 style="margin-top:12px">Preview</h4><ul class="preview-list">${sample}</ul>` : ""}
      <div class="acts">
        <button id="pv-import"${missingReq.length ? " disabled" : ""}>Import ${pv.ready} product${pv.ready === 1 ? "" : "s"}</button>
        <button class="ghost" id="pv-cancel">Cancel</button>
      </div>`;

    $("#preview").querySelectorAll("select").forEach((s) => {
      s.onchange = () => {
        const v = s.value;
        pendingCsv.overrides[s.dataset.src] = v === "attribute" ? "attribute" : v === "ignore" ? "ignore" : v;
        renderPreview();
      };
    });
    $("#pv-cancel").onclick = () => { pendingCsv = null; clearPreview(); };
    $("#pv-import").onclick = async () => {
      $("#pv-import").disabled = true;
      try {
        const b = await jsonPost(`/merchants/${mid()}/products/csv`, { csv: pendingCsv.text, overrides: pendingCsv.overrides });
        const n = b.inserted + b.updated;
        toast(`Imported ${n} product${n === 1 ? "" : "s"}${b.errors?.length ? `, ${b.errors.length} skipped` : ""}`);
        note(`Imported ${b.inserted} new, ${b.updated} updated${b.errors?.length ? `. Skipped ${b.errors.length}: ${b.errors.slice(0, 3).map((e) => `row ${e.row}`).join(", ")}` : "."}`);
        pendingCsv = null; clearPreview(); loadProducts();
      } catch (err) { note(`Import failed: ${err.message}`, true); toast("Import failed", "err"); }
    };
  }

  const drop = $("#drop");
  const takeFile = (f) => f && f.text().then(previewCsv);
  $("#choose").onclick = () => $("#file").click();
  $("#file").onchange = (e) => takeFile(e.target.files[0]);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => takeFile(e.dataTransfer.files[0]));

  // --- Paste a list -> AI extract -> review -> save ---
  $("#paste-extract").onclick = async () => {
    const text = $("#paste-text").value.trim();
    if (!text) { note("Paste your product list first.", true); return; }
    const btn = $("#paste-extract");
    btn.disabled = true; note("Extracting products…");
    try {
      const { products, errors } = await jsonPost(`/merchants/${mid()}/products/extract`, { text });
      $("#import-note").textContent = "";
      if (!products.length) { note("Nothing recognisable to extract — try adding prices.", true); return; }
      const list = products.map((p, i) =>
        `<li><b>${esc(p.name)}</b> · ${money(p.price)}${p.brand ? " · " + esc(p.brand) : ""} — ${esc((p.description || "").slice(0, 80))}</li>`).join("");
      $("#preview").hidden = false;
      $("#preview").innerHTML = `
        <h4>${products.length} product${products.length === 1 ? "" : "s"} extracted${errors?.length ? ` (${errors.length} skipped)` : ""}</h4>
        <ul class="preview-list">${list}</ul>
        <div class="acts">
          <button id="pv-save">Save ${products.length} to catalog</button>
          <button class="ghost" id="pv-cancel">Cancel</button>
        </div>`;
      $("#pv-cancel").onclick = clearPreview;
      $("#pv-save").onclick = async () => {
        $("#pv-save").disabled = true;
        try {
          const b = await jsonPost(`/merchants/${mid()}/products`, { products });
          toast(`Saved ${b.inserted + b.updated} product${b.inserted + b.updated === 1 ? "" : "s"}`);
          clearPreview(); $("#paste-text").value = ""; loadProducts();
        } catch (err) { note(`Save failed: ${err.message}`, true); }
      };
    } catch (err) {
      note(`Extraction failed: ${err.message}`, true);
    } finally { btn.disabled = false; }
  };

  // --- Connect a feed ---
  $("#feed-import").onclick = async () => {
    const url = $("#feed-url").value.trim();
    if (!url) { note("Enter a feed URL.", true); return; }
    const btn = $("#feed-import");
    btn.disabled = true; note("Fetching your feed…");
    try {
      const b = await jsonPost(`/merchants/${mid()}/products/import-feed`, { url });
      const n = b.inserted + b.updated;
      toast(`Imported ${n} product${n === 1 ? "" : "s"} from your ${b.format?.toUpperCase() || ""} feed`);
      note(`Fetched ${b.fetched} rows → ${b.inserted} new, ${b.updated} updated${b.errors?.length ? `, ${b.errors.length} skipped` : ""}.`);
      loadProducts();
    } catch (err) {
      note(`Feed import failed: ${err.message}`, true); toast("Feed import failed", "err");
    } finally { btn.disabled = false; }
  };

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
