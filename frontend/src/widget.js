/* Drop-in chat widget.
   <script src=".../widget.js" data-merchant="merchant_123" data-agent-url="http://localhost:4003"></script> */
(() => {
  const script = document.currentScript;
  const merchant = script?.dataset.merchant;
  if (!merchant) return console.error("[cca] widget requires data-merchant");
  const base = (script.dataset.agentUrl || "http://localhost:4003").replace(/\/$/, "");
  const cash = new Intl.NumberFormat(undefined, { style: "currency", currency: script.dataset.currency || "USD" });
  const key = `cca:widget:v3:${base}:${merchant}`;
  const newId = () => crypto.randomUUID?.() || `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let state;
  try { state = JSON.parse(localStorage.getItem(key)); } catch { /* ignore */ }
  if (!state?.sessionId) state = { sessionId: newId(), merchantName: "", messages: [], cart: { items: [], subtotal: 0 } };
  if (!state.cart) state.cart = { items: [], subtotal: 0 };
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* ignore */ } };

  const host = document.createElement("div");
  script.insertAdjacentElement("afterend", host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .shell{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;font:14px/1.45 system-ui,sans-serif;color:#172033}
      .chat{flex:1 1 360px;height:600px;display:flex;flex-direction:column;border:1px solid #d9dce5;border-radius:16px;overflow:hidden;background:#fff}
      header{padding:14px 18px;background:#172a4d;color:#fff;font-weight:700;font-size:15px}
      .thread{flex:1;overflow:auto;padding:15px;background:#f7f8fb}
      .message,.card{margin:0 0 10px;padding:10px 12px;border-radius:12px;background:#fff;box-shadow:0 1px 2px #0000001a}
      .message{max-width:85%}
      .user{margin-left:auto;background:#dceaff}
      .carousel{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}
      .product{flex:0 0 190px;padding:0;overflow:hidden}
      .product img,.fallback{width:100%;height:110px;object-fit:cover;background:#e9edf5;display:block}
      .fallback{display:flex;align-items:center;justify-content:center;font-size:30px}
      .body{padding:10px;display:flex;flex-direction:column;gap:6px}
      .name{font-weight:700;min-height:36px}
      .price{color:#385a97;font-weight:700}
      select,input{width:100%;padding:7px;border:1px solid #b9c3d4;border-radius:7px;font:inherit;background:#fff}
      button{border:0;border-radius:8px;padding:9px 10px;background:#2359b8;color:#fff;font:inherit;font-weight:700;cursor:pointer}
      button.secondary{background:#e8edf7;color:#27364f}
      button:disabled{opacity:.5;cursor:not-allowed}
      h3{margin:0 0 8px;font-size:14px}
      .line{display:flex;justify-content:space-between;gap:8px;margin:5px 0}
      .opt{color:#6b7590;font-size:12px}
      .total{border-top:1px solid #dde2eb;margin-top:6px;padding-top:8px;font-weight:800}
      .actions{display:flex;gap:8px;margin-top:12px}
      form{display:flex;gap:8px;padding:12px;border-top:1px solid #e4e7ee}
      form button{flex:none}
      .notice{padding:8px 10px;margin:8px 0;border-radius:8px;background:#fff4d8}
      .notice.success{background:#e1f5e7}
      .notice.error{background:#fde8e8}
      .bag{flex:1 1 240px;max-height:600px;overflow:auto;border:1px solid #d9dce5;border-radius:16px;background:#fff;padding:14px}
      .bag h3{font-size:15px}
      .bag .checkout{width:100%;margin-top:12px}
    </style>
    <div class="shell">
      <section class="chat">
        <header></header>
        <main class="thread" aria-live="polite"></main>
        <form><input placeholder="Ask about products…" aria-label="Message"><button>Send</button></form>
      </section>
      <aside class="bag" aria-label="Cart"></aside>
    </div>`;

  const thread = root.querySelector(".thread");
  const form = root.querySelector("form");
  const input = root.querySelector("input");
  const headerEl = root.querySelector("header");
  const bagEl = root.querySelector(".bag");
  const sendBtn = form.querySelector("button");

  const setHeader = () => { headerEl.textContent = state.merchantName || "Shopping assistant"; };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const scroll = () => { thread.scrollTop = thread.scrollHeight; };
  const notice = (text, type = "") => { thread.append(el("div", `notice ${type}`.trim(), text)); scroll(); };

  async function api(path, body) {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Request failed (${res.status})`);
    return json;
  }

  async function chat(message) {
    sendBtn.disabled = true;
    try {
      const res = await api("/chat", { session_id: state.sessionId, merchant_id: merchant, message });
      if (res.merchant_name) { state.merchantName = res.merchant_name; setHeader(); }
      res.messages.forEach((item) => {
        // Cart lives in the side panel, not the thread.
        if (item.type !== "cart") state.messages.push({ sender: "agent", item });
        draw(item);
      });
      save();
    } catch (e) {
      notice(e.message, "error");
    } finally {
      sendBtn.disabled = false;
    }
  }

  function optionLabel(o) {
    return [o.size && `Size ${o.size}`, o.color].filter(Boolean).join(" · ");
  }

  function productCard(p) {
    const card = el("article", "card product");
    let media;
    if (p.image_url) {
      media = el("img");
      media.src = p.image_url;
      media.alt = p.name;
      media.onerror = () => media.replaceWith(el("div", "fallback", "👟"));
    } else {
      media = el("div", "fallback", "👟");
    }
    const body = el("div", "body");
    body.append(el("div", "name", p.name), el("div", "price", cash.format(p.price)));

    const sizes = Array.isArray(p.attributes?.size) ? p.attributes.size : [];
    const colors = Array.isArray(p.attributes?.color) ? p.attributes.color : [];
    let sizeSel, colorSel;
    if (sizes.length) {
      sizeSel = el("select");
      sizeSel.append(el("option", "", "Select size"));
      sizes.forEach((s) => sizeSel.append(el("option", "", String(s))));
      sizeSel.firstChild.value = "";
      body.append(sizeSel);
    }
    if (colors.length) {
      colorSel = el("select");
      colorSel.append(el("option", "", "Select colour"));
      colors.forEach((c) => colorSel.append(el("option", "", String(c))));
      colorSel.firstChild.value = "";
      body.append(colorSel);
    }

    const add = el("button", "", "Add to cart");
    if (sizeSel) {
      add.disabled = true;
      sizeSel.onchange = () => { add.disabled = !sizeSel.value; };
    }
    add.onclick = () => {
      add.disabled = true;
      chat({
        kind: "action",
        action: "add_to_cart",
        product_id: p.product_id,
        quantity: 1,
        ...(sizeSel?.value ? { size: sizeSel.value } : {}),
        ...(colorSel?.value ? { color: colorSel.value } : {}),
      });
    };
    body.append(add);
    card.append(media, body);
    return card;
  }

  function carousel(products) {
    const row = el("div", "carousel");
    products.filter((p) => p.availability !== false).forEach((p) => row.append(productCard(p)));
    if (!row.children.length) row.append(el("div", "message", "Nothing available matches that."));
    return row;
  }

  // Render the persistent cart panel (right of the chat) from state.cart.
  function renderCart() {
    bagEl.replaceChildren();
    bagEl.append(el("h3", "", state.merchantName ? `Your bag · ${state.merchantName}` : "Your bag"));
    const items = state.cart.items ?? [];
    if (!items.length) {
      bagEl.append(el("div", "opt", "Your bag is empty."));
      return;
    }
    items.forEach((it) => {
      const line = el("div", "line");
      const left = el("div");
      left.append(el("div", "", `${it.quantity} × ${it.name}`));
      const ol = optionLabel(it.options || {});
      if (ol) left.append(el("div", "opt", ol));
      line.append(left, el("span", "", cash.format(it.quantity * it.unit_price)));
      bagEl.append(line);
    });
    const sub = el("div", "line total");
    sub.append(el("span", "", "Subtotal"), el("span", "", cash.format(state.cart.subtotal ?? 0)));
    bagEl.append(sub);

    const checkout = el("button", "checkout", "Checkout");
    checkout.onclick = () => { checkout.disabled = true; chat({ kind: "text", text: "I'd like to check out" }); };
    bagEl.append(checkout);
  }

  function previewCard(p) {
    const card = el("section", "card");
    card.append(el("h3", "", `Checkout · ${p.merchant_name}`));
    p.items.forEach((i) => {
      const line = el("div", "line");
      const left = el("div");
      left.append(el("div", "", `${i.qty} × ${i.name}`));
      const ol = optionLabel(i);
      if (ol) left.append(el("div", "opt", ol));
      line.append(left, el("span", "", cash.format(i.qty * i.price)));
      card.append(line);
    });
    [["Subtotal", p.subtotal], ["Tax", p.tax], ["Total", p.total]].forEach(([label, value], idx) => {
      const line = el("div", idx === 2 ? "line total" : "line");
      line.append(el("span", "", label), el("span", "", cash.format(value)));
      card.append(line);
    });

    const cardInput = el("input");
    cardInput.placeholder = "Card number";
    cardInput.inputMode = "numeric";
    card.append(cardInput);
    let codeInput;
    if (p.requires_step_up) {
      codeInput = el("input");
      codeInput.placeholder = "Verification code (demo: 1234)";
      card.append(codeInput);
    }

    const actions = el("div", "actions");
    const pay = el("button", "", "Confirm & pay");
    const cancel = el("button", "secondary", "Cancel");
    pay.onclick = async () => {
      pay.disabled = true;
      cancel.disabled = true;
      try {
        await api("/checkout/payment-method", { session_id: state.sessionId, card_number: cardInput.value });
        const r = await api("/checkout/confirm", {
          session_id: state.sessionId,
          cart_id: p.cart_id,
          ...(codeInput ? { step_up_code: codeInput.value } : {}),
        });
        const ok = r.result.outcome === "approved";
        if (ok) {
          state.cart = { items: [], subtotal: 0 };
          renderCart();
          save();
        }
        notice(ok ? `Payment approved. Transaction ${r.result.transaction_id}.` : r.result.message || `Payment ${r.result.outcome}.`, ok ? "success" : "error");
      } catch (e) {
        notice(e.message, "error");
        pay.disabled = false;
        cancel.disabled = false;
      }
    };
    cancel.onclick = async () => {
      pay.disabled = true;
      cancel.disabled = true;
      try {
        await api("/checkout/cancel", { session_id: state.sessionId, cart_id: p.cart_id });
        notice("Checkout cancelled. No payment was made.");
      } catch (e) {
        notice(e.message, "error");
      }
    };
    actions.append(pay, cancel);
    card.append(actions);
    return card;
  }

  function draw(item) {
    if (item.type === "text") thread.append(el("div", "message", item.text));
    else if (item.type === "product_carousel") thread.append(carousel(item.products));
    else if (item.type === "cart") {
      state.cart = { items: item.cart?.items ?? [], subtotal: item.subtotal ?? item.cart?.subtotal ?? 0 };
      renderCart();
      return;
    } else if (item.type === "transaction_preview") thread.append(previewCard(item.preview));
    scroll();
  }

  // rehydrate
  setHeader();
  renderCart();
  state.messages.forEach((m) => {
    if (m.sender === "user") thread.append(el("div", "message user", m.item.text));
    else draw(m.item);
  });
  scroll();

  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    state.messages.push({ sender: "user", item: { type: "text", text } });
    thread.append(el("div", "message user", text));
    scroll();
    save();
    chat({ kind: "text", text });
  };
})();
