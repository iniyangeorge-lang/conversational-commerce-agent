/* Drop-in conversational-commerce widget.
   <script src=".../widget.js" data-agent-url="http://localhost:4003"></script>

   One continuous thread: the shopping agent asks progressive questions, keeps a
   preference profile, recommends with explanations, compares, builds the cart,
   and prepares checkout. Payment happens only when the shopper clicks
   "Confirm & pay" in the preview card - the agent has no payment tool.

   Self-contained: renders in a shadow root with its own design tokens (kept in
   sync with ../theme.css). No external requests beyond the agent API. */
(() => {
  const script = document.currentScript;
  const base = (script?.dataset.agentUrl || "http://localhost:4003").replace(/\/$/, "");
  const merchant = script?.dataset.merchant || null; // optional storefront hint
  const cash = new Intl.NumberFormat(undefined, { style: "currency", currency: script?.dataset.currency || "USD" });
  const key = `cca:widget:v5:${base}`;
  const newId = () => crypto.randomUUID?.() || `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let state;
  try { state = JSON.parse(localStorage.getItem(key)); } catch { /* ignore */ }
  if (!state?.sessionId) state = { sessionId: newId(), messages: [], cart: { items: [], subtotal: 0 }, groups: [], profile: {} };
  state.cart ||= { items: [], subtotal: 0 };
  state.groups ||= [];
  state.profile ||= {};
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* ignore */ } };

  const host = document.createElement("div");
  script.insertAdjacentElement("afterend", host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      :host{
        --c-primary:#5b4be6;--c-primary-strong:#4433d1;--c-primary-soft:#eeecff;--c-primary-tint:#f7f6ff;
        --c-accent:#ff6a5d;--c-accent-soft:#ffe8e5;
        --grad-brand:linear-gradient(135deg,#6a5cf0 0%,#8b5cf6 52%,#b571ef 100%);
        --c-bg:#f5f5fb;--c-surface:#fff;--c-surface-2:#f2f2f9;--c-surface-sunk:#edecf5;
        --c-text:#191a23;--c-text-2:#585e6d;--c-text-3:#8b909f;--c-border:#e6e6ef;--c-border-strong:#d3d4e2;
        --c-success:#11815b;--c-success-soft:#e1f5ec;--c-warn:#9a6014;--c-warn-soft:#fbefdb;--c-error:#d23a4b;--c-error-soft:#fce7ea;
        --r-sm:9px;--r-md:13px;--r-lg:18px;--r-pill:999px;
        --sh-sm:0 1px 2px rgba(23,20,54,.06),0 1px 3px rgba(23,20,54,.05);
        --sh-md:0 6px 18px -6px rgba(31,25,80,.16);
        --sh-lg:0 22px 48px -18px rgba(31,25,80,.26);
        --ring:0 0 0 3px rgba(91,75,230,.34);
        --t-fast:130ms;--t:220ms;--ease:cubic-bezier(.22,1,.36,1);
        --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
        display:block;
      }
      .shell{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;font:14.5px/1.55 var(--font);color:var(--c-text)}
      :where(button,input,select,[tabindex]):focus-visible{outline:none;box-shadow:var(--ring);border-radius:var(--r-sm)}

      .chat{flex:1 1 380px;min-width:0;height:648px;display:flex;flex-direction:column;border:1px solid var(--c-border);border-radius:var(--r-lg);overflow:hidden;background:var(--c-surface);box-shadow:var(--sh-lg)}
      header{padding:14px 16px;background:#14152a;color:#fff;background-image:radial-gradient(420px 120px at 12% -40%,rgba(139,92,246,.55),transparent)}
      .htop{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .htop b{font-size:15px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
      .dot{width:8px;height:8px;border-radius:50%;background:#4ee6a8;box-shadow:0 0 0 4px rgba(78,230,168,.22)}
      .info{width:24px;height:24px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#e8e6ff;font:italic 700 13px Georgia,serif;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background var(--t) var(--ease)}
      .info:hover{background:rgba(255,255,255,.24)}
      .panel{background:#101127;color:#c9cbe6;font-size:12.5px;padding:0 16px;max-height:0;overflow:hidden;transition:max-height var(--t) var(--ease),padding var(--t) var(--ease)}
      .panel.open{max-height:340px;padding:13px 16px;overflow:auto}
      .panel h4{margin:0 0 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#8f92c6}
      .panel ul{margin:0 0 10px;padding-left:16px}
      .panel li{margin:3px 0}
      .panel .no li{color:#f3b6c1}

      .thread{flex:1;overflow:auto;overflow-x:hidden;padding:16px;background:var(--c-bg);scroll-behavior:smooth}
      .row{display:flex;margin:0 0 12px;animation:rise var(--t) var(--ease)}
      .row.me{justify-content:flex-end}
      @keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
      @keyframes pop{0%{transform:scale(.9)}60%{transform:scale(1.04)}100%{transform:scale(1)}}
      .bubble{max-width:86%;padding:10px 13px;border-radius:15px;background:var(--c-surface);box-shadow:var(--sh-sm);white-space:pre-wrap;border:1px solid var(--c-border)}
      .me .bubble{background:var(--grad-brand);color:#fff;border:0;box-shadow:var(--sh-md)}
      .think{display:flex;gap:4px;padding:13px}
      .think i{width:7px;height:7px;border-radius:50%;background:var(--c-text-3);animation:blink 1.2s var(--ease) infinite}
      .think i:nth-child(2){animation-delay:.18s}
      .think i:nth-child(3){animation-delay:.36s}
      @keyframes blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}

      .card{margin:0 0 12px;padding:14px;border-radius:var(--r-md);background:var(--c-surface);box-shadow:var(--sh-md);border:1px solid var(--c-border);animation:rise var(--t) var(--ease)}
      .lead{margin:0 0 10px;font-weight:650}

      .carousel{display:flex;gap:12px;overflow-x:auto;padding:2px 2px 8px;scroll-snap-type:x proximity;scrollbar-width:thin}
      .product{flex:0 0 214px;scroll-snap-align:start;border:1px solid var(--c-border);border-radius:var(--r-md);overflow:hidden;background:var(--c-surface);display:flex;flex-direction:column;transition:transform var(--t) var(--ease),box-shadow var(--t) var(--ease)}
      .media{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--c-surface-sunk)}
      .media img,.media .ph{width:100%;height:100%;object-fit:cover;display:block;transition:transform var(--t-lg,400ms) var(--ease)}
      .media .ph{display:flex;align-items:center;justify-content:center;font-size:30px}
      @media (hover:hover){
        .product:hover{transform:translateY(-3px);box-shadow:var(--sh-lg)}
        .product:hover .media img{transform:scale(1.06)}
      }
      .pbody{padding:11px;display:flex;flex-direction:column;gap:8px;flex:1}
      .store{color:var(--c-text-3);font-size:10.5px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}
      .pname{font-weight:700;line-height:1.3;min-height:2.6em;font-size:13.5px}
      .price{display:flex;align-items:baseline;gap:7px;font-weight:800;color:var(--c-text)}
      .price .now{font-size:15px}
      .price s{color:var(--c-text-3);font-weight:600;font-size:12.5px}
      .match{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:750;color:var(--c-primary-strong)}
      .bar{flex:1;height:6px;border-radius:4px;background:var(--c-surface-sunk);overflow:hidden}
      .bar i{display:block;height:100%;background:var(--grad-brand);width:0;transition:width 620ms var(--ease)}
      .reasons{list-style:none;margin:0;padding:0;font-size:12px;display:flex;flex-direction:column;gap:3px}
      .reasons li{padding-left:16px;position:relative}
      .reasons li::before{content:"✓";position:absolute;left:0;color:var(--c-success);font-weight:800}
      .reasons li.t::before{content:"–";color:var(--c-warn)}

      select{width:100%;padding:8px 9px;border:1px solid var(--c-border-strong);border-radius:var(--r-sm);font:inherit;background:var(--c-surface);color:inherit;transition:border-color var(--t) var(--ease)}
      select:focus{border-color:var(--c-primary);outline:none;box-shadow:var(--ring)}

      button{border:0;border-radius:var(--r-sm);padding:9px 12px;background:var(--c-primary);color:#fff;font:650 13px var(--font);cursor:pointer;transition:transform var(--t-fast) var(--ease),box-shadow var(--t) var(--ease),background-color var(--t) var(--ease)}
      button:hover{box-shadow:var(--sh-md)}
      button:active{transform:scale(.96)}
      button.sec{background:var(--c-surface-2);color:var(--c-primary-strong);border:1px solid var(--c-border)}
      button.sec:hover{background:var(--c-primary-soft)}
      button.mini{padding:7px 9px;font-size:12px}
      button.ok{background:var(--c-success)}
      button:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
      .pact{display:flex;gap:6px;margin-top:auto}
      .pact button{flex:1;padding:8px 4px;font-size:12px}

      .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
      .chip{background:var(--c-surface);color:var(--c-primary-strong);border:1px solid var(--c-border-strong);border-radius:var(--r-pill);padding:8px 14px;font-weight:650;font-size:12.5px;transition:background var(--t) var(--ease),border-color var(--t) var(--ease),transform var(--t-fast) var(--ease)}
      .chip:hover{background:var(--c-primary-soft);border-color:var(--c-primary)}
      .chip[aria-pressed=true]{background:var(--grad-brand);color:#fff;border-color:transparent}

      .cmp{overflow-x:auto;margin-top:4px;-webkit-overflow-scrolling:touch}
      table.cmp-t{border-collapse:separate;border-spacing:0;font-size:12.5px;min-width:100%}
      table.cmp-t th,table.cmp-t td{border-bottom:1px solid var(--c-border);padding:8px 10px;text-align:left;vertical-align:top}
      table.cmp-t thead th{background:var(--c-surface-2);font-size:11px;position:sticky;top:0}
      table.cmp-t td:first-child,table.cmp-t th:first-child{color:var(--c-text-3);font-weight:750;white-space:nowrap;position:sticky;left:0;background:var(--c-surface)}
      table.cmp-t tbody tr:nth-child(even) td{background:var(--c-surface-2)}
      table.cmp-t tbody tr:nth-child(even) td:first-child{background:var(--c-surface-2)}

      h3{margin:0 0 10px;font-size:14.5px;letter-spacing:-.01em}
      h4{margin:12px 0 4px;font-size:11px;color:var(--c-text-3);text-transform:uppercase;letter-spacing:.05em;font-weight:750}
      .line{display:flex;justify-content:space-between;gap:8px;margin:6px 0}
      .opt{color:var(--c-text-3);font-size:12px}
      .total{border-top:1px solid var(--c-border);margin-top:8px;padding-top:9px;font-weight:800}

      .notice{padding:9px 12px;margin:8px 0;border-radius:var(--r-sm);background:var(--c-warn-soft);color:var(--c-warn);font-size:13px;animation:rise var(--t) var(--ease);display:flex;gap:8px}
      .notice.success{background:var(--c-success-soft);color:var(--c-success)}
      .notice.error{background:var(--c-error-soft);color:var(--c-error)}
      .notice::before{content:"i";font-style:italic;font-weight:800}
      .notice.success::before{content:"✓";font-style:normal}
      .notice.error::before{content:"!";font-style:normal}

      form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--c-border);background:var(--c-surface)}
      form input{flex:1;padding:11px 12px;border:1px solid var(--c-border-strong);border-radius:var(--r-pill);font:inherit;background:var(--c-surface);color:inherit;transition:border-color var(--t) var(--ease)}
      form input:focus{border-color:var(--c-primary);outline:none;box-shadow:var(--ring)}
      form button{flex:none;padding:11px 18px;border-radius:var(--r-pill);background-image:var(--grad-brand)}

      .qty{display:flex;align-items:center;gap:7px;margin-top:4px}
      .qty button{padding:2px 9px;background:var(--c-surface-2);color:var(--c-primary-strong);border:1px solid var(--c-border);font-size:14px;min-width:26px}
      .qty span{min-width:16px;text-align:center;font-weight:700}
      .qty .rm{margin-left:3px;background:none;border:0;color:var(--c-text-3);font-weight:600;padding:2px 4px}
      .qty .rm:hover{color:var(--c-error)}

      /* bag */
      .bag{flex:1 1 270px;min-width:0;max-height:648px;overflow:auto;border:1px solid var(--c-border);border-radius:var(--r-lg);background:var(--c-surface);padding:16px;box-shadow:var(--sh-lg)}
      .bag.pulse{animation:pop 340ms var(--ease)}
      .bag h3{font-size:15px}
      .bagcount{float:right;font-size:11px;font-weight:800;color:#fff;background:var(--c-accent);border-radius:var(--r-pill);padding:2px 8px}
      .prof{display:flex;flex-wrap:wrap;gap:7px;margin:6px 0 14px}
      .pchip{display:inline-flex;align-items:center;gap:4px;background:var(--c-primary-soft);color:var(--c-primary-strong);border-radius:var(--r-pill);padding:4px 6px 4px 11px;font-size:11.5px;font-weight:700}
      .pchip-x{border:0;background:rgba(91,75,230,.16);color:var(--c-primary-strong);width:16px;height:16px;border-radius:50%;padding:0;font:700 12px/1 var(--font);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background var(--t) var(--ease)}
      .pchip-x:hover{background:rgba(91,75,230,.3)}
      .pchip-x:disabled{opacity:.4}
      .prof .empty{color:var(--c-text-3);font-size:12.5px;font-weight:400}
      .emptybag{text-align:center;color:var(--c-text-3);padding:22px 6px}
      .emptybag .big{font-size:30px;margin-bottom:6px}
      .emptybag b{display:block;color:var(--c-text-2);font-size:13px;margin-bottom:2px}
      .bag .checkout{width:100%;margin-top:14px;padding:12px;border-radius:var(--r-sm);background-image:var(--grad-brand);font-size:13.5px;font-weight:700}
      .cmptray{position:sticky;bottom:0;margin-top:14px;padding-top:12px;background:var(--c-surface);border-top:1px solid var(--c-border)}
      .cmptray button{width:100%}

      .toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:2147483000;pointer-events:none}
      .toast{pointer-events:auto;display:flex;align-items:center;gap:9px;background:#14152a;color:#fff;border-radius:var(--r-md);padding:11px 14px;font:600 13px var(--font);box-shadow:var(--sh-lg);cursor:pointer;animation:toastin var(--t) var(--ease)}
      .toast .ic{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;background:var(--c-success);flex:none}
      .toast.err .ic{background:var(--c-error)}
      .toast.out{animation:toastout 180ms var(--ease) forwards}
      @keyframes toastin{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}
      @keyframes toastout{to{opacity:0;transform:translateY(6px) scale(.97)}}

      @media (max-width:680px){
        .chat{height:80vh;flex-basis:100%}
        .bag{flex-basis:100%;max-height:none}
        .product{flex-basis:200px}
        .toasts{left:12px;right:12px;bottom:12px}
      }
      @media (prefers-reduced-motion:reduce){
        *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
        .product:hover{transform:none}
      }
    </style>
    <div class="shell">
      <section class="chat">
        <header>
          <div class="htop">
            <b><span class="dot"></span>Shopping assistant</b>
            <button class="info" id="t-trust" title="What this assistant can and can't do" aria-label="About this assistant">i</button>
          </div>
        </header>
        <div class="panel" id="p-trust" role="region" aria-label="Assistant capabilities">
          <h4>The agent can</h4>
          <ul>
            <li>Search products and ask you clarifying questions</li>
            <li>Recommend and compare options, and explain why</li>
            <li>Add, change and remove items in your cart</li>
            <li>Prepare a checkout preview for you to review</li>
          </ul>
          <h4>The agent cannot</h4>
          <ul class="no">
            <li>Charge a card — payment needs your explicit “Confirm &amp; pay”</li>
            <li>See your card number — it is tokenised, never shown to the model</li>
            <li>Change the amount after you approve without re-approval</li>
          </ul>
        </div>
        <main class="thread" aria-live="polite"></main>
        <form><input placeholder="Tell the assistant what you're looking for…" aria-label="Message"><button>Send</button></form>
      </section>
      <aside class="bag" aria-label="Cart and preferences"></aside>
    </div>
    <div class="toasts" aria-live="polite" aria-atomic="false"></div>`;

  const thread = root.querySelector(".thread");
  const form = root.querySelector("form");
  const input = root.querySelector("input");
  const bagEl = root.querySelector(".bag");
  const sendBtn = form.querySelector("button");
  const toastBox = root.querySelector(".toasts");
  const trustPanel = root.querySelector("#p-trust");
  const trustBtn = root.querySelector("#t-trust");
  trustBtn.onclick = () => { const open = trustPanel.classList.toggle("open"); trustBtn.setAttribute("aria-expanded", open); };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const scroll = () => { thread.scrollTop = thread.scrollHeight; };
  const notice = (text, type = "") => { thread.append(el("div", `notice ${type}`.trim(), text)); scroll(); };
  const optionLabel = (o) => [o.size && `Size ${o.size}`, o.color].filter(Boolean).join(" · ");

  function toast(msg, type = "ok") {
    const t = el("div", `toast ${type === "err" ? "err" : ""}`.trim());
    t.append(el("span", "ic", type === "err" ? "!" : "✓"), el("span", "", msg));
    const kill = () => { t.classList.add("out"); setTimeout(() => t.remove(), 200); };
    t.onclick = kill;
    toastBox.append(t);
    setTimeout(kill, 3200);
  }

  let thinkingRow = null;
  function think(on) {
    if (on && !thinkingRow) {
      thinkingRow = el("div", "row");
      const b = el("div", "bubble think");
      b.append(el("i"), el("i"), el("i"));
      thinkingRow.append(b);
      thread.append(thinkingRow);
      scroll();
    } else if (!on && thinkingRow) {
      thinkingRow.remove();
      thinkingRow = null;
    }
  }

  // --- compare tray -----------------------------------------------------
  const compareSel = new Map(); // key -> { name }
  const ckey = (p) => `${p.merchant_id}/${p.product_id}`;
  function toggleCompare(p, btn) {
    const k = ckey(p);
    if (compareSel.has(k)) { compareSel.delete(k); btn.classList.remove("sec"); btn.textContent = "Compare"; btn.setAttribute("aria-pressed", "false"); }
    else if (compareSel.size >= 4) { toast("Compare up to 4 at once", "err"); return; }
    else { compareSel.set(k, { name: p.name }); btn.classList.add("sec"); btn.textContent = "Comparing"; btn.setAttribute("aria-pressed", "true"); }
    renderCart();
  }

  async function api(path, body) {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Request failed (${res.status})`);
    return json;
  }

  async function chat(message) {
    sendBtn.disabled = true;
    think(true);
    const isAdd = message.kind === "action" && message.action === "add_to_cart";
    try {
      const res = await api("/chat", { session_id: state.sessionId, ...(merchant ? { merchant_id: merchant } : {}), message });
      if (res.profile) state.profile = res.profile;
      think(false);
      res.messages.forEach((item) => {
        if (item.type !== "cart") state.messages.push({ sender: "agent", item });
        draw(item);
      });
      renderCart();
      if (isAdd && res.messages.some((m) => m.type === "cart")) { toast("Added to cart"); pulseBag(); }
      save();
    } catch (e) {
      think(false);
      notice(e.message, "error");
    } finally {
      sendBtn.disabled = false;
    }
  }

  function pulseBag() {
    if (reduce) return;
    bagEl.classList.remove("pulse");
    void bagEl.offsetWidth;
    bagEl.classList.add("pulse");
  }

  async function forget(chip) {
    try {
      const r = await api("/profile/forget", {
        session_id: state.sessionId, key: chip.key, ...(chip.value ? { value: chip.value } : {}),
      });
      state.profile = r.profile || {};
      save();
      renderCart();
      toast(`Forgot “${chip.label}”`);
    } catch (e) { toast(e.message, "err"); }
  }

  // --- price + product cards -----------------------------------------
  function priceEl(p) {
    const wrap = el("div", "price");
    const was = Number(p.compare_at_price ?? p.original_price ?? 0);
    if (was > Number(p.price)) {
      wrap.append(el("span", "now", cash.format(p.price)));
      wrap.append(el("s", "", cash.format(was)));
    } else {
      wrap.append(el("span", "now", cash.format(p.price)));
    }
    return wrap;
  }

  function productCard(p, match) {
    const card = el("article", "product");

    const media = el("div", "media");
    if (p.image_url) {
      const img = el("img");
      img.loading = "lazy"; img.decoding = "async"; img.src = p.image_url; img.alt = p.name;
      img.onerror = () => img.replaceWith(el("div", "ph", "🛍️"));
      media.append(img);
    } else media.append(el("div", "ph", "🛍️"));
    if (Number(p.compare_at_price ?? p.original_price ?? 0) > Number(p.price)) {
      const b = el("span", "", "Sale");
      b.style.cssText = "position:absolute;top:8px;left:8px;background:var(--c-accent);color:#fff;font:800 10px/1 var(--font);padding:4px 7px;border-radius:var(--r-pill)";
      media.append(b);
    }
    card.append(media);

    const body = el("div", "pbody");
    if (p.merchant_name) body.append(el("div", "store", p.merchant_name));
    body.append(el("div", "pname", p.name), priceEl(p));

    if (match) {
      const m = el("div", "match");
      m.append(el("span", "", `Match ${match.score}/10`));
      const bar = el("div", "bar"); const fill = el("i"); bar.append(fill);
      m.append(bar);
      body.append(m);
      requestAnimationFrame(() => { fill.style.width = `${Math.round((match.score / 10) * 100)}%`; });
      const rl = el("ul", "reasons");
      (match.reasons || []).slice(0, 4).forEach((r) => rl.append(el("li", "", r)));
      (match.tradeoffs || []).slice(0, 2).forEach((t) => rl.append(el("li", "t", t)));
      body.append(rl);
    }

    const sizes = Array.isArray(p.attributes?.size) ? p.attributes.size : [];
    const colors = Array.isArray(p.attributes?.color) ? p.attributes.color : [];
    let sizeSel, colorSel;
    if (sizes.length) {
      sizeSel = el("select"); sizeSel.setAttribute("aria-label", `Size for ${p.name}`);
      sizeSel.append(el("option", "", "Select size"));
      sizes.forEach((s) => sizeSel.append(el("option", "", String(s))));
      sizeSel.firstChild.value = ""; body.append(sizeSel);
    }
    if (colors.length) {
      colorSel = el("select"); colorSel.setAttribute("aria-label", `Colour for ${p.name}`);
      colorSel.append(el("option", "", "Select colour"));
      colors.forEach((c) => colorSel.append(el("option", "", String(c))));
      colorSel.firstChild.value = ""; body.append(colorSel);
    }

    const act = el("div", "pact");
    const view = el("button", "sec mini", "Why");
    view.onclick = () => send(`Tell me more about the ${p.name} and why it fits`);
    const cmp = el("button", "sec mini", compareSel.has(ckey(p)) ? "Comparing" : "Compare");
    cmp.setAttribute("aria-pressed", compareSel.has(ckey(p)) ? "true" : "false");
    if (compareSel.has(ckey(p))) cmp.classList.add("sec");
    cmp.onclick = () => toggleCompare(p, cmp);
    const add = el("button", "mini", "Add");
    if (sizeSel) { add.disabled = true; sizeSel.onchange = () => { add.disabled = !sizeSel.value; }; }
    add.onclick = () => {
      add.disabled = true; add.classList.add("ok"); add.textContent = "Added ✓";
      chat({
        kind: "action", action: "add_to_cart",
        merchant_id: p.merchant_id, product_id: p.product_id, quantity: 1,
        ...(sizeSel?.value ? { size: sizeSel.value } : {}),
        ...(colorSel?.value ? { color: colorSel.value } : {}),
      });
      setTimeout(() => { add.classList.remove("ok"); add.textContent = "Add"; add.disabled = !!(sizeSel && !sizeSel.value); }, 1100);
    };
    act.append(view, cmp, add);
    body.append(act);
    card.append(body);
    return card;
  }

  function carousel(products, matchOf) {
    const row = el("div", "carousel");
    products.filter((p) => p.availability !== false).forEach((p) => row.append(productCard(p, matchOf?.(p))));
    if (!row.children.length) row.append(el("div", "bubble", "Nothing available matches that — try a different description or budget."));
    return row;
  }

  function recommendation(msg) {
    const card = el("div", "card");
    if (msg.intro) card.append(el("p", "lead", msg.intro));
    const byId = new Map(msg.products.map((p) => [p.product_id, p.match]));
    card.append(carousel(msg.products, (p) => byId.get(p.product_id)));
    return card;
  }

  function comparison(msg) {
    const card = el("div", "card");
    card.append(el("h3", "", "Side by side"));
    const wrap = el("div", "cmp");
    const t = el("table", "cmp-t");
    const cap = el("caption", "", "Product comparison"); cap.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
    t.append(cap);
    const thead = el("thead"); const htr = el("tr");
    const corner = el("th", "", ""); corner.scope = "col"; htr.append(corner);
    msg.products.forEach((p) => { const th = el("th", "", p.name); th.scope = "col"; htr.append(th); });
    thead.append(htr); t.append(thead);
    const tb = el("tbody");
    (msg.rows || []).forEach((r) => {
      const tr = el("tr");
      const rh = el("th", "", r.label); rh.scope = "row"; tr.append(rh);
      r.values.forEach((v) => tr.append(el("td", "", v)));
      tb.append(tr);
    });
    t.append(tb); wrap.append(t); card.append(wrap);
    return card;
  }

  function choices(msg) {
    const card = el("div", "card");
    card.append(el("p", "lead", msg.question));
    const box = el("div", "chips"); box.setAttribute("role", "group");
    const picked = new Set();
    msg.options.forEach((opt) => {
      const b = el("button", "chip", opt);
      b.setAttribute("aria-pressed", "false");
      b.onclick = () => {
        if (msg.allow_multiple) {
          const on = !picked.has(opt);
          on ? picked.add(opt) : picked.delete(opt);
          b.setAttribute("aria-pressed", String(on));
          if (!box.querySelector(".go")) {
            const go = el("button", "go mini", "Send");
            go.onclick = () => { box.querySelectorAll("button").forEach((x) => (x.disabled = true)); send([...picked].join(", ")); };
            box.append(go);
          }
        } else {
          box.querySelectorAll("button").forEach((x) => (x.disabled = true));
          b.setAttribute("aria-pressed", "true");
          send(opt);
        }
      };
      box.append(b);
    });
    card.append(box);
    return card;
  }

  // --- cart + profile ------------------------------------------------
  function editLine(it, quantity) {
    chat({
      kind: "action", action: "update_cart_item",
      merchant_id: it.merchant_id, product_id: it.product_id, quantity,
      ...(it.options?.size ? { size: it.options.size } : {}),
      ...(it.options?.color ? { color: it.options.color } : {}),
    });
  }

  function profileChips() {
    const p = state.profile || {};
    const out = [];
    const push = (label, key, value) => out.push({ label, key, value });
    if (p.budget_max != null) push(`≤ ${cash.format(p.budget_max)}`, "budget_max");
    if (p.primary_use) push(p.primary_use, "primary_use");
    if (Array.isArray(p.priorities)) p.priorities.slice(0, 3).forEach((x, i) => push(`${i + 1}. ${x}`, "priorities", x));
    (p.required_features || []).forEach((x) => push(x, "required_features", x));
    (p.preferred_features || []).forEach((x) => push(x, "preferred_features", x));
    (p.preferred_brands || []).forEach((x) => push(x, "preferred_brands", x));
    (p.avoided_brands || []).forEach((x) => push(`no ${x}`, "avoided_brands", x));
    if (p.size) push(`size ${p.size}`, "size");
    if (p.color) push(p.color, "color");
    if (p.experience) push(p.experience, "experience");
    return out;
  }

  function renderCart() {
    bagEl.replaceChildren();

    bagEl.append(el("h3", "", "What I know"));
    const prof = el("div", "prof");
    const chips = profileChips();
    if (chips.length) chips.forEach((c) => {
      const span = el("span", "pchip");
      span.append(document.createTextNode(c.label));
      const x = el("button", "pchip-x", "×");
      x.title = `Forget “${c.label}”`;
      x.setAttribute("aria-label", `Forget ${c.label}`);
      x.onclick = () => { x.disabled = true; forget(c); };
      span.append(x);
      prof.append(span);
    });
    else prof.append(el("span", "empty", "Tell me your budget and what matters most."));
    bagEl.append(prof);

    const count = state.cart.items.reduce((n, i) => n + i.quantity, 0);
    const bagHead = el("h3", "", "Your bag");
    if (count) bagHead.append(el("span", "bagcount", String(count)));
    bagEl.append(bagHead);

    if (!state.cart.items.length) {
      const e = el("div", "emptybag");
      e.append(el("div", "big", "🛍️"), el("b", "", "Your bag is waiting for something great."), el("div", "", "Ask the assistant to add an item, or tap Add on a card."));
      bagEl.append(e);
    }
    for (const g of state.groups) {
      bagEl.append(el("h4", "", g.merchant_name));
      for (const it of g.items) {
        const line = el("div", "line");
        const left = el("div");
        left.append(el("div", "", it.name));
        const ol = optionLabel(it.options || {});
        if (ol) left.append(el("div", "opt", ol));
        const qty = el("div", "qty");
        const minus = el("button", "", "−"); minus.setAttribute("aria-label", `Decrease ${it.name}`);
        const plus = el("button", "", "+"); plus.setAttribute("aria-label", `Increase ${it.name}`);
        const rm = el("button", "rm", "Remove");
        const lock = () => qty.querySelectorAll("button").forEach((b) => (b.disabled = true));
        minus.onclick = () => { lock(); editLine(it, it.quantity - 1); };
        plus.onclick = () => { lock(); editLine(it, it.quantity + 1); };
        rm.onclick = () => { lock(); editLine(it, 0); };
        qty.append(minus, el("span", "", String(it.quantity)), plus, rm);
        left.append(qty);
        line.append(left, el("span", "", cash.format(it.quantity * it.unit_price)));
        bagEl.append(line);
      }
    }
    if (state.cart.items.length) {
      const sub = el("div", "line total");
      sub.append(el("span", "", "Subtotal"), el("span", "", cash.format(state.cart.subtotal ?? 0)));
      bagEl.append(sub);
      const checkout = el("button", "checkout", "Review & check out");
      checkout.onclick = () => { checkout.disabled = true; send("I'd like to check out"); };
      bagEl.append(checkout);
    }

    if (compareSel.size >= 2) {
      const tray = el("div", "cmptray");
      const b = el("button", "", `Compare ${compareSel.size} selected`);
      b.onclick = () => {
        const names = [...compareSel.values()].map((v) => v.name);
        compareSel.clear();
        send(`Compare the ${names.join(" and the ")}`);
      };
      tray.append(b);
      bagEl.append(tray);
    }
  }

  function previewCard(p) {
    const card = el("section", "card");
    card.tabIndex = -1;
    card.append(el("h3", "", "Review your purchase"));
    card.append(el("p", "opt", "The assistant prepared this. Nothing is charged until you confirm."));
    for (const g of p.groups) {
      card.append(el("h4", "", g.merchant_name));
      g.items.forEach((i) => {
        const line = el("div", "line");
        const left = el("div");
        left.append(el("div", "", `${i.qty} × ${i.name}`));
        const ol = optionLabel(i);
        if (ol) left.append(el("div", "opt", ol));
        line.append(left, el("span", "", cash.format(i.qty * i.price)));
        card.append(line);
      });
      [["Subtotal", g.subtotal], ["Tax", g.tax]].forEach(([l, v]) => {
        const r = el("div", "line opt"); r.append(el("span", "", l), el("span", "", cash.format(v))); card.append(r);
      });
    }
    [["Subtotal", p.subtotal], ["Tax", p.tax], ["Total", p.total]].forEach(([l, v], idx) => {
      const r = el("div", idx === 2 ? "line total" : "line"); r.append(el("span", "", l), el("span", "", cash.format(v))); card.append(r);
    });

    const cardInput = el("input"); cardInput.placeholder = "Card number (try 4242 4242 4242 4242)"; cardInput.inputMode = "numeric";
    cardInput.setAttribute("aria-label", "Card number");
    cardInput.style.cssText = "width:100%;margin-top:10px;padding:11px 12px;border:1px solid var(--c-border-strong);border-radius:var(--r-sm);font:inherit;background:var(--c-surface);color:inherit";
    card.append(cardInput);
    card.append(el("div", "opt", "Demo — mock Visa. Your card number is tokenised and never shown to the assistant."));

    const actions = el("div", "pact");
    const pay = el("button", "", `Confirm & pay ${cash.format(p.total)}`);
    const cancel = el("button", "sec", "Cancel");
    pay.onclick = async () => {
      pay.disabled = true; cancel.disabled = true; pay.textContent = "Processing…";
      try {
        await api("/checkout/payment-method", { session_id: state.sessionId, card_number: cardInput.value });
        const r = await api("/checkout/confirm", { session_id: state.sessionId, cart_id: p.cart_id });
        if (r.result.outcome === "completed") {
          const settled = new Set(r.result.charges.filter((c) => c.outcome === "approved").map((c) => c.merchant_id));
          state.cart.items = state.cart.items.filter((i) => !settled.has(i.merchant_id));
          state.cart.subtotal = state.cart.items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
          state.groups = state.groups.filter((g) => !settled.has(g.merchant_id));
          renderCart(); save(); pulseBag();
          for (const c of r.result.charges) {
            const ok = c.outcome === "approved";
            if (ok) toast(`${c.merchant_name}: payment approved`);
            notice(
              ok ? `${c.merchant_name}: payment approved · ${c.transaction_id}`
                 : c.outcome === "declined" ? `${c.merchant_name}: declined — ${c.decline_reason}`
                 : `${c.merchant_name}: ${c.message}`,
              ok ? "success" : "error",
            );
          }
        } else {
          notice(r.result.message || `Checkout ${r.result.outcome}.`, "error");
          pay.disabled = false; cancel.disabled = false; pay.textContent = `Confirm & pay ${cash.format(p.total)}`;
        }
      } catch (e) {
        notice(e.message, "error"); pay.disabled = false; cancel.disabled = false; pay.textContent = `Confirm & pay ${cash.format(p.total)}`;
      }
    };
    cancel.onclick = async () => {
      pay.disabled = true; cancel.disabled = true;
      try { await api("/checkout/cancel", { session_id: state.sessionId, cart_id: p.cart_id }); notice("Checkout cancelled. No payment was made."); }
      catch (e) { notice(e.message, "error"); }
    };
    actions.append(pay, cancel);
    card.append(actions);
    return card;
  }

  function draw(item) {
    if (item.type === "text") { const r = el("div", "row"); r.append(el("div", "bubble", item.text)); thread.append(r); }
    else if (item.type === "product_carousel") thread.append(carousel(item.products));
    else if (item.type === "recommendation") thread.append(recommendation(item));
    else if (item.type === "comparison") thread.append(comparison(item));
    else if (item.type === "choices") thread.append(choices(item));
    else if (item.type === "cart") {
      state.cart = { items: item.cart?.items ?? [], subtotal: item.subtotal ?? item.cart?.subtotal ?? 0 };
      state.groups = item.groups ?? [];
      renderCart();
      return;
    } else if (item.type === "transaction_preview") {
      const c = previewCard(item.preview);
      thread.append(c);
      if (!reduce) setTimeout(() => c.focus({ preventScroll: true }), 60);
    }
    scroll();
  }

  function send(text) {
    state.messages.push({ sender: "user", item: { type: "text", text } });
    const r = el("div", "row me"); r.append(el("div", "bubble", text)); thread.append(r);
    scroll(); save();
    chat({ kind: "text", text });
  }

  // --- boot ----------------------------------------------------------
  renderCart();
  state.messages.forEach((m) => {
    if (m.sender === "user") { const r = el("div", "row me"); r.append(el("div", "bubble", m.item.text)); thread.append(r); }
    else draw(m.item);
  });
  if (!state.messages.length) {
    const r = el("div", "row");
    r.append(el("div", "bubble", "Hi — tell me what you're shopping for and roughly your budget, and I'll do the digging."));
    thread.append(r);
  }
  scroll();

  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send(text);
  };
})();
