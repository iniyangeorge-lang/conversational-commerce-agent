// Phase 4 conversational agent: an LLM tool-calling loop (OpenAI or Anthropic,
// selected by LLM_PROVIDER / whichever key is set) plus an offline deterministic
// fallback for local demos and tests without an API key.

import { CatalogClient } from "./catalog-client.js";
import { buildSystemPrompt } from "./prompt.js";
import { createSession, MemoryStore, sessionKey, SessionStore } from "./state.js";
import { createToolExecutor, TOOL_DEFINITIONS } from "./tools.js";

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY_ITEMS = 30;

function hasCheckoutIntent(text) {
  const normalized = String(text).toLowerCase();
  if (/\b(don't|do not|never)\b.{0,20}\b(checkout|buy|purchase|pay|order)\b/.test(normalized)) return false;
  return /\b(checkout|check out|buy|purchase|pay|place (the |my )?order|ready to order)\b/.test(normalized);
}

function maxPriceFromText(text) {
  const match = String(text).match(/(?:under|below|less than|max(?:imum)?(?: price)?(?: of)?)\s*\$?([0-9]+(?:\.[0-9]{1,2})?)/i);
  return match ? Number(match[1]) : undefined;
}

function textMessage(text) {
  return { type: "text", text: String(text) };
}

function cartMessage(session) {
  return {
    type: "cart",
    merchant_name: session.merchant?.name ?? "",
    cart: session.cart,
    subtotal: session.cart?.subtotal ?? 0,
  };
}

export class CommerceAgent {
  constructor({ catalog = new CatalogClient(), store = new SessionStore(), offline = false, fetchImpl = fetch } = {}) {
    this.catalog = catalog;
    this.store = store;
    this.offline = offline;
    this.fetch = fetchImpl;
    this.executeTool = createToolExecutor({ catalog });
  }

  async loadSession(request) {
    const raw = await this.store.get(sessionKey(request.session_id));
    if (raw) {
      const session = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (session.merchant_id !== request.merchant_id) throw new Error("session belongs to a different merchant");
      return session;
    }
    const merchant = await this.catalog.getMerchant(request.merchant_id);
    if (!merchant) throw new Error("merchant not found");
    return createSession(request.session_id, request.merchant_id, merchant);
  }

  async saveSession(session) {
    session.history = session.history.slice(-MAX_HISTORY_ITEMS);
    await this.store.set(sessionKey(session.session_id), JSON.stringify(session));
  }

  respond(session, messages) {
    return {
      session_id: session.session_id,
      merchant_name: session.merchant?.name ?? "",
      state: session.state,
      messages,
    };
  }

  /** Which hosted model to drive, or null to use the offline planner. */
  llmProvider() {
    const forced = process.env.LLM_PROVIDER?.toLowerCase();
    if (forced === "openai" || forced === "anthropic") return forced;
    if (process.env.OPENAI_API_KEY) return "openai";
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
    return null;
  }

  async handle(request) {
    if (!request || typeof request !== "object") throw new Error("request must be an object");
    if (typeof request.session_id !== "string" || !request.session_id.trim()) throw new Error("session_id is required");
    if (typeof request.merchant_id !== "string" || !request.merchant_id.trim()) throw new Error("merchant_id is required");
    if (!request.message || typeof request.message !== "object") throw new Error("message is required");
    if (!["text", "action"].includes(request.message.kind)) throw new Error("message.kind must be text or action");
    if (request.message.kind === "text" && typeof request.message.text !== "string") throw new Error("message.text must be a string");
    if (request.message.kind === "action") {
      if (request.message.action !== "add_to_cart") throw new Error("message.action must be add_to_cart");
      for (const k of ["size", "color"])
        if (request.message[k] !== undefined && typeof request.message[k] !== "string")
          throw new Error(`message.${k} must be a string`);
    }

    const session = await this.loadSession(request);
    if (request.message.kind === "text") {
      session.checkout_intent = hasCheckoutIntent(request.message.text);
      session.history.push({ role: "user", content: request.message.text });
    } else session.checkout_intent = false;

    const provider = this.offline ? null : this.llmProvider();
    if (!provider) {
      const result = await this.offlineTurn(session, request.message);
      await this.saveSession(session);
      return this.respond(session, result.messages);
    }

    try {
      const result = request.message.kind === "action"
        ? await this.handleStructuredAction(session, request.message)
        : provider === "openai"
          ? await this.runOpenAI(session)
          : await this.runModel(session);
      await this.saveSession(session);
      return this.respond(session, result.messages);
    } catch (err) {
      // A missing/invalid remote model must not make the storefront unusable.
      // The fallback uses the same server-side tools and safety checks.
      console.warn(`[agent] model loop unavailable (${err.message}) - using offline fallback`);
      const result = await this.offlineTurn(session, request.message);
      await this.saveSession(session);
      return this.respond(session, result.messages);
    }
  }

  async handleStructuredAction(session, message) {
    const result = await this.executeTool(
      "add_to_cart",
      { product_id: message.product_id, quantity: message.quantity, size: message.size, color: message.color },
      session,
    );
    if (!result.ok) return { messages: [textMessage(result.error.message)] };
    const a = result.added;
    const opt = [a.size && `size ${a.size}`, a.color].filter(Boolean).join(", ");
    return {
      messages: [
        textMessage(`Added ${a.quantity} × ${a.name}${opt ? ` (${opt})` : ""} — subtotal $${result.cart.subtotal.toFixed(2)}.`),
        cartMessage(session),
      ],
    };
  }

  async offlineTurn(session, message) {
    if (message.kind === "action") return this.handleStructuredAction(session, message);
    const text = message.text.trim();
    const lower = text.toLowerCase();

    if (/\b(cart|basket)\b/.test(lower) && !hasCheckoutIntent(text)) {
      if (/\b(clear|empty|reset)\b/.test(lower)) {
        session.cart.items = [];
        session.cart.subtotal = 0;
        session.state = "browsing";
        session.checkout_preview = null;
        session.checkout_result = null;
        return { messages: [textMessage("Cleared your cart."), cartMessage(session)] };
      }
      return { messages: [cartMessage(session)] };
    }

    const removeMatch = lower.match(/\b(remove|delete|drop|take out)\b\s+(?:the\s+)?(.+)/);
    if (removeMatch && session.cart.items.length) {
      let term = removeMatch[2].trim().replace(/\bfrom (my |the )?(cart|bag)\b/, "").trim();
      const wantedSize = term.match(/\bsize\s+(\S+)/)?.[1] ?? null;
      const wantedColor = term.match(/\bin\s+(?!size\b)([a-z]+)\b/)?.[1] ?? null;
      term = term.replace(/\b(in\s+)?size\s+\S+/g, "").replace(/\bin\s+(?!size\b)[a-z]+\b/g, "").trim();
      const line = session.cart.items.find(
        (item) =>
          (item.product_id.toLowerCase() === term || (term && item.name.toLowerCase().includes(term))) &&
          (!wantedSize || String(item.options?.size ?? "").toLowerCase() === wantedSize.toLowerCase()) &&
          (!wantedColor || String(item.options?.color ?? "").toLowerCase() === wantedColor.toLowerCase()),
      );
      if (!line) return { messages: [textMessage(`I couldn't find "${removeMatch[2].trim()}" in your cart.`), cartMessage(session)] };
      await this.executeTool(
        "update_cart_item",
        { product_id: line.product_id, size: line.options?.size, color: line.options?.color, quantity: 0 },
        session,
      );
      return { messages: [textMessage(`Removed ${line.name} from your cart.`), cartMessage(session)] };
    }

    if (hasCheckoutIntent(text)) {
      const result = await this.executeTool("request_checkout", { cart_id: session.cart.cart_id }, session);
      if (!result.ok) return { messages: [textMessage(result.error.message + ". Add an item first if you want to check out.")] };
      const preview = result.preview;
      return {
        messages: [
          textMessage("Here is your checkout preview. Please review it and confirm payment in the checkout card."),
          { type: "transaction_preview", preview },
        ],
      };
    }

    const directProduct = text.match(/\b(prod_[a-z0-9_-]+)\b/i)?.[1];
    const shouldAdd = /\b(add|select|choose|pick)\b/.test(lower) || Boolean(directProduct);
    if (shouldAdd && (directProduct || session.last_search.length)) {
      const productId = directProduct ?? session.last_search[0].product_id;
      const result = await this.executeTool("add_to_cart", { product_id: productId, quantity: 1 }, session);
      if (!result.ok) return { messages: [textMessage(result.error.message)] };
      return { messages: [textMessage(`Added 1 × ${result.added.name} to your cart. Your subtotal is $${result.cart.subtotal.toFixed(2)}.`)] };
    }

    const search = await this.executeTool("search_products", {
      query: text,
      ...(maxPriceFromText(text) !== undefined ? { max_price: maxPriceFromText(text) } : {}),
      filters: { available_only: true },
    }, session);
    if (!search.ok) return { messages: [textMessage(search.error.message)] };
    if (!search.results.length) return { messages: [textMessage("I couldn't find an available match. Try a different description or budget.")] };
    return {
      messages: [
        textMessage(`I found ${search.results.length} option${search.results.length === 1 ? "" : "s"}. Choose one to add to your cart.`),
        { type: "product_carousel", products: search.results },
      ],
    };
  }

  // --- Anthropic tool-calling loop ---
  async runModel(session) {
    let messages = session.history.map((item) => ({ role: item.role, content: item.content }));
    const output = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await this.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL ?? "claude-sonnet-5",
          max_tokens: 1200,
          system: buildSystemPrompt(session),
          tools: TOOL_DEFINITIONS,
          messages,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `Anthropic request failed (${response.status})`);

      const content = Array.isArray(body.content) ? body.content : [];
      const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      if (text) output.push(textMessage(text));
      const calls = content.filter((block) => block.type === "tool_use");
      if (!calls.length) {
        session.history = messages.concat([{ role: "assistant", content }]);
        return { messages: output.length ? output : [textMessage("How can I help you shop today?")] };
      }

      messages.push({ role: "assistant", content });
      const results = [];
      for (const call of calls) {
        const result = await this.executeTool(call.name, call.input ?? {}, session);
        if (call.name === "search_products" && result.ok) output.push({ type: "product_carousel", products: result.results });
        if (["add_to_cart", "update_cart_item", "get_cart_summary"].includes(call.name) && result.ok) output.push(cartMessage(session));
        if (call.name === "request_checkout" && result.ok) output.push({ type: "transaction_preview", preview: result.preview });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("tool loop exceeded its safety limit");
  }

  // --- OpenAI (Chat Completions) tool-calling loop ---
  async runOpenAI(session) {
    const asText = (content) => (typeof content === "string" ? content : JSON.stringify(content));
    const messages = [
      { role: "system", content: buildSystemPrompt(session) },
      ...session.history.map((item) => ({ role: item.role, content: asText(item.content) })),
    ];
    const tools = TOOL_DEFINITIONS.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
    const output = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await this.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL ?? "gpt-4o",
          max_completion_tokens: 2000,
          messages,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `OpenAI request failed (${response.status})`);

      const choice = body.choices?.[0]?.message;
      if (!choice) throw new Error("OpenAI response contained no message");

      const text = String(choice.content ?? "").trim();
      if (text) output.push(textMessage(text));

      const calls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
      if (!calls.length) {
        session.history = [...session.history, { role: "assistant", content: text }];
        return { messages: output.length ? output : [textMessage("How can I help you shop today?")] };
      }

      messages.push({ role: "assistant", content: choice.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await this.executeTool(call.function?.name, args, session);
        const fn = call.function?.name;
        if (fn === "search_products" && result.ok)
          output.push({ type: "product_carousel", products: result.results });
        if (["add_to_cart", "update_cart_item", "get_cart_summary"].includes(fn) && result.ok)
          output.push(cartMessage(session));
        if (fn === "request_checkout" && result.ok)
          output.push({ type: "transaction_preview", preview: result.preview });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("tool loop exceeded its safety limit");
  }
}

export function createDefaultAgent(options = {}) {
  return new CommerceAgent(options);
}

export { MemoryStore };
