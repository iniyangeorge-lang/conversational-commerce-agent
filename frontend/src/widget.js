/* Drop-in chat widget.
   <script src=".../widget.js" data-merchant="merchant_123" data-agent-url="http://localhost:4003"></script> */
(() => {
  const script = document.currentScript;
  const merchant = script?.dataset.merchant;
  if (!merchant) return console.error("[cca] widget requires data-merchant");
  const base = (script.dataset.agentUrl || "http://localhost:4003").replace(/\/$/, "");
  const cash = new Intl.NumberFormat(undefined, { style: "currency", currency: script.dataset.currency || "USD" });
  const key = `cca:widget:v2:${base}:${merchant}`;
  const accountsKey = `cca:accounts:v1:${merchant}`;
  const newId = () => crypto.randomUUID?.() || `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const accountId = (username, role) => `${username.trim().toLowerCase()}:${role}`;

  let accounts = {};
  try {
    const savedAccounts = JSON.parse(localStorage.getItem(accountsKey));
    if (savedAccounts && typeof savedAccounts === "object" && !Array.isArray(savedAccounts)) accounts = savedAccounts;
  } catch { /* ignore */ }
  const saveAccounts = () => { try { localStorage.setItem(accountsKey, JSON.stringify(accounts)); } catch { /* ignore */ } };
  const hashPassword = async (password, salt) => {
    if (!crypto.subtle) return `${salt}:${password}`;
    const bytes = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  let state;
  try { state = JSON.parse(localStorage.getItem(key)); } catch { /* ignore */ }
  if (!state?.sessionId) state = { sessionId: newId(), merchantName: "", messages: [], cart: { items: [], subtotal: 0 } };
  if (!state.cart) state.cart = { items: [], subtotal: 0 };
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* ignore */ } };

  let account = null;

  const host = document.createElement("div");
  script.insertAdjacentElement("afterend", host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .shell{width:min(100%,420px);height:600px;border:1px solid #d9dce5;border-radius:16px;overflow:hidden;background:#fff;color:#172033;font:14px/1.45 system-ui,sans-serif}
      .chat{height:100%;display:flex;flex-direction:column}
      [hidden]{display:none!important}
      header{padding:13px 16px;background:#172a4d;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px}
      .brand{font-weight:700;font-size:15px}
      .account-bar{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:500}
      .account-role{opacity:.82}
      .logout{padding:5px 8px;background:#ffffff1f;border:1px solid #ffffff55;font-size:11px}
      .auth{height:100%;display:flex;align-items:center;justify-content:center;padding:30px 24px;background:radial-gradient(circle at 50% 38%,#438d99 0,#2f7783 38%,#1d5965 100%)}
      .auth-wrap{width:min(100%,336px)}
      .auth-title{margin:0 0 13px;text-align:center;color:#eef6f7;font-size:23px;font-weight:300;letter-spacing:.2em;text-transform:uppercase}
      .auth-card{display:block;width:100%;padding:28px 24px 26px;background:#06242a;box-shadow:0 12px 25px #06242a55}
      .auth-card .sub{margin:0 0 18px;color:#b5c8ca;font-size:11px;text-align:center}
      .auth-error{min-height:17px;margin:-7px 0 12px;color:#ffd3d3;font-size:11px;text-align:center}
      .auth-error:empty{display:none}
      .role-toggle{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:0 0 18px;border:1px solid #4e777d}
      .role-toggle button{padding:8px 6px;border-radius:0;background:transparent;color:#b8ccce;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
      .role-toggle button + button{border-left:1px solid #4e777d}
      .role-toggle button.active{background:#4f8e9a;color:#fff}
      .field{display:flex;align-items:stretch;height:48px;margin:0 0 12px;background:#d5d5d7;color:#384144}
      .field-icon{display:flex;align-items:center;justify-content:center;flex:0 0 48px;background:#eeeef0;color:#545b5d}
      .field-icon svg{width:18px;height:18px;fill:currentColor}
      .field input{width:100%;min-width:0;border:0;border-radius:0;padding:0 13px;background:#d5d5d7;color:#273134;font:14px system-ui,sans-serif;outline:none}
      .password-toggle{display:flex;align-items:center;justify-content:center;flex:0 0 44px;border:0;border-radius:0;border-left:1px solid #b9b9bc;padding:0;background:#d5d5d7;color:#4f5759}
      .password-toggle:hover{background:#c5c5c8;color:#172033}
      .password-toggle svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2}
      .field input::placeholder{color:#697073}
      .field:focus-within{outline:2px solid #78aab2;outline-offset:2px}
      .login{width:100%;border-radius:0;padding:14px;background:#518f9c;color:#fff;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
      .login:hover{background:#64a4b0}
      .register-link{display:block;width:max-content;margin:13px auto 0;padding:0;background:none;color:#c1dadd;font-size:11px;font-weight:500;text-decoration:underline;text-underline-offset:3px}
      .register-link:hover{color:#fff}
      .demo-note{margin:16px 0 0;color:#8fb0b5;font-size:10px;text-align:center}
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
      .chat form{display:flex;gap:8px;padding:12px;border-top:1px solid #e4e7ee}
      .chat form button{flex:none}
      .notice{padding:8px 10px;margin:8px 0;border-radius:8px;background:#fff4d8}
      .notice.success{background:#e1f5e7}
      .notice.error{background:#fde8e8}
      .bag{flex:1 1 240px;max-height:600px;overflow:auto;border:1px solid #d9dce5;border-radius:16px;background:#fff;padding:14px}
      .bag h3{font-size:15px}
      .bag .checkout{width:100%;margin-top:12px}
    </style>
    <section class="shell">
      <section class="auth" aria-label="Login">
        <div class="auth-wrap">
          <h1 class="auth-title">User login</h1>
          <form class="auth-card">
            <p class="sub">Choose an account type, then sign in to your shopping assistant.</p>
            <p class="auth-error" role="alert"></p>
            <div class="role-toggle" role="group" aria-label="Account type">
              <button type="button" class="active" data-role="consumer" aria-pressed="true">Consumer</button>
              <button type="button" data-role="merchant" aria-pressed="false">Merchant</button>
            </div>
            <label class="field"><span class="field-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.05 0-7 2.1-7 5v1h14v-1c0-2.9-2.95-5-7-5Z"/></svg></span><input name="username" autocomplete="username" required placeholder="Username"></label>
            <label class="field"><span class="field-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9h14v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V7Zm2 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg></span><input name="password" type="password" autocomplete="current-password" required placeholder="Password"><button class="password-toggle" type="button" data-target="password" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17.7 17.7 0 0 1-3.2 3.8M6.2 6.2A17.6 17.6 0 0 0 2 12s3.5 6 10 6a10.7 10.7 0 0 0 3.2-.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg></button></label>
            <label class="field confirm-field" hidden><span class="field-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9h14v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V7Zm2 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg></span><input name="confirmPassword" type="password" autocomplete="new-password" placeholder="Confirm password"><button class="password-toggle" type="button" data-target="confirmPassword" aria-label="Show confirmation password" title="Show password"><svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17.7 17.7 0 0 1-3.2 3.8M6.2 6.2A17.6 17.6 0 0 0 2 12s3.5 6 10 6a10.7 10.7 0 0 0 3.2-.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg></button></label>
            <button class="login" type="submit">Log in as Consumer</button>
            <button class="register-link" type="button">Register as Consumer</button>
            <p class="demo-note">Accounts are saved only in this browser for the demo.</p>
          </form>
        </div>
      </section>
      <section class="chat" hidden>
        <header><span class="brand"></span><span class="account-bar"><span class="account-role"></span><button class="logout" type="button">Sign out</button></span></header>
        <main class="thread" aria-live="polite"></main>
        <form><input placeholder="Ask about products…" aria-label="Message"><button>Send</button></form>
      </section>
    </section>`;

  const authView = root.querySelector(".auth");
  const authForm = root.querySelector(".auth-card");
  const roleButtons = [...root.querySelectorAll("[data-role]")];
  const authTitle = root.querySelector(".auth-title");
  const authSub = root.querySelector(".auth-card .sub");
  const authError = root.querySelector(".auth-error");
  const loginBtn = root.querySelector(".login");
  const registerLink = root.querySelector(".register-link");
  const confirmField = root.querySelector(".confirm-field");
  const passwordToggles = [...root.querySelectorAll(".password-toggle")];
  const chatView = root.querySelector(".chat");
  const thread = root.querySelector(".thread");
  const form = root.querySelector(".chat form");
  const input = root.querySelector(".chat input");
  const headerEl = root.querySelector(".brand");
  const accountRoleEl = root.querySelector(".account-role");
  const logoutBtn = root.querySelector(".logout");
  const sendBtn = form.querySelector("button");

  let selectedRole = "consumer";
  let authMode = "login";

  const roleName = (role) => role === "merchant" ? "Merchant" : "Consumer";
  const eyeIcon = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  const eyeOffIcon = '<svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17.7 17.7 0 0 1-3.2 3.8M6.2 6.2A17.6 17.6 0 0 0 2 12s3.5 6 10 6a10.7 10.7 0 0 0 3.2-.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const setAuthError = (message = "") => { authError.textContent = message; };
  const updateRoleLabels = () => {
    const role = roleName(selectedRole);
    loginBtn.textContent = authMode === "register" ? `Register as ${role}` : `Log in as ${role}`;
    registerLink.textContent = authMode === "register" ? "Back to login" : `Register as ${role}`;
  };
  const resetPasswords = () => {
    authForm.elements.password.value = "";
    authForm.elements.confirmPassword.value = "";
    passwordToggles.forEach((button) => {
      const target = authForm.elements[button.dataset.target];
      target.type = "password";
      button.innerHTML = eyeOffIcon;
      button.setAttribute("aria-label", button.dataset.target === "password" ? "Show password" : "Show confirmation password");
      button.title = "Show password";
    });
  };
  const setMode = (mode) => {
    authMode = mode;
    const registering = mode === "register";
    authTitle.textContent = registering ? "Register" : "User login";
    authSub.textContent = registering
      ? "Create an account to continue to your shopping assistant."
      : "Choose an account type, then sign in to your shopping assistant.";
    confirmField.hidden = !registering;
    authForm.elements.confirmPassword.required = registering;
    authForm.elements.password.autocomplete = registering ? "new-password" : "current-password";
    resetPasswords();
    setAuthError();
    updateRoleLabels();
  };
  const showChat = () => {
    authView.hidden = true;
    chatView.hidden = false;
    setHeader();
  };
  const showLogin = () => {
    authView.hidden = false;
    chatView.hidden = true;
    authForm.elements.password.value = "";
  };

  roleButtons.forEach((button) => {
    button.onclick = () => {
      selectedRole = button.dataset.role;
      roleButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      resetPasswords();
      updateRoleLabels();
    };
  });

  registerLink.onclick = () => {
    setMode(authMode === "login" ? "register" : "login");
  };

  passwordToggles.forEach((button) => {
    button.onclick = () => {
      const target = authForm.elements[button.dataset.target];
      const reveal = target.type === "password";
      target.type = reveal ? "text" : "password";
      button.innerHTML = reveal ? eyeIcon : eyeOffIcon;
      button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
      button.title = reveal ? "Hide password" : "Show password";
    };
  });

  const completeLogin = (registered) => {
    account = { username: registered.username, role: registered.role };
    showChat();
  };

  authForm.onsubmit = async (event) => {
    event.preventDefault();
    const username = authForm.elements.username.value.trim();
    const password = authForm.elements.password.value;
    if (!username || !password) return;
    const id = accountId(username, selectedRole);
    const registered = accounts[id];
    setAuthError();

    if (authMode === "register") {
      const confirmation = authForm.elements.confirmPassword.value;
      if (registered) return setAuthError("That username is already registered. Please log in instead.");
      if (password !== confirmation) return setAuthError("Passwords do not match. Please enter them again.");
      const salt = newId();
      const passwordHash = await hashPassword(password, salt);
      accounts[id] = { username, role: selectedRole, salt, passwordHash };
      saveAccounts();
      completeLogin(accounts[id]);
      return;
    }

    if (!registered) return setAuthError(`No ${roleName(selectedRole).toLowerCase()} account found. Please register as ${roleName(selectedRole)} first.`);
    const passwordHash = await hashPassword(password, registered.salt);
    if (passwordHash !== registered.passwordHash) return setAuthError("Incorrect password. Please try again.");
    completeLogin(registered);
  };

  logoutBtn.onclick = () => {
    account = null;
    setMode("login");
    showLogin();
  };

  const setHeader = () => {
    headerEl.textContent = state.merchantName || "Shopping assistant";
    accountRoleEl.textContent = account ? `${account.username} · ${roleName(account.role)}` : "";
  };
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
