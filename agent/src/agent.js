// Conversational commerce agent: an LLM tool-calling loop (OpenAI or Anthropic,
// selected by LLM_PROVIDER / whichever key is set) plus an offline deterministic
// fallback for local demos and tests without an API key.
//
// The model can search, ask progressive clarifying questions, maintain a
// structured shopper profile, recommend with explanations, compare, and build
// the cart. It CANNOT charge a card - see the trust layer.

import { CatalogClient } from "./catalog-client.js";
import { buildSystemPrompt } from "./prompt.js";
import { createSession, MemoryStore, sessionKey, SessionStore } from "./state.js";
import { createToolExecutor, forgetFromProfile, groupCart, PROFILE_KEYS, TOOL_DEFINITIONS } from "./tools.js";

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
    cart: session.cart,
    groups: groupCart(session),
    subtotal: session.cart?.subtotal ?? 0,
  };
}

// Tidy a turn's messages so the shopper sees one clean view:
//  - the checkout card and the quick-reply chips each stand alone (drop model text)
//  - a raw product carousel is redundant once a richer view of the same products
//    is present (a recommendation, a comparison, a cart update, or the preview).
function finalizeMessages(messages) {
  let out = messages;
  const has = (t) => out.some((m) => m.type === t);
  if (has("transaction_preview") || has("choices")) out = out.filter((m) => m.type !== "text");
  if (has("recommendation") || has("comparison") || has("cart") || has("transaction_preview"))
    out = out.filter((m) => m.type !== "product_carousel");
  return out;
}

/** Rich messages to surface for a completed tool call (model loops share this). */
function messagesForTool(name, result, session) {
  if (!result.ok) return [];
  switch (name) {
    case "search_products":
      return result.results.length ? [{ type: "product_carousel", products: result.results }] : [];
    case "recommend_products":
      return [{ type: "recommendation", intro: result.intro, products: result.products }];
    case "compare_products":
      return [{ type: "comparison", products: result.products, rows: result.rows }];
    case "ask_clarifying_question":
      return result.options.length >= 2
        ? [{ type: "choices", question: result.question, options: result.options, allow_multiple: result.allow_multiple }]
        : [textMessage(result.question)];
    case "add_to_cart":
    case "update_cart_item":
    case "get_cart_summary":
      return [cartMessage(session)];
    case "request_checkout":
      return [{ type: "transaction_preview", preview: result.preview }];
    default:
      return [];
  }
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
      if (!session.merchants) session.merchants = {};
      if (!session.profile) session.profile = {};
      return session;
    }
    return createSession(request.session_id);
  }

  async saveSession(session) {
    session.history = session.history.slice(-MAX_HISTORY_ITEMS);
    await this.store.set(sessionKey(session.session_id), JSON.stringify(session));
  }

  respond(session, messages, activity = []) {
    return {
      session_id: session.session_id,
      state: session.state,
      messages,
      agent_activity: activity,
      profile: session.profile ?? {},
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
    if (!request.message || typeof request.message !== "object") throw new Error("message is required");
    if (!["text", "action"].includes(request.message.kind)) throw new Error("message.kind must be text or action");
    if (request.message.kind === "text" && typeof request.message.text !== "string") throw new Error("message.text must be a string");
    if (request.message.kind === "action") {
      if (!["add_to_cart", "update_cart_item"].includes(request.message.action))
        throw new Error("message.action must be add_to_cart or update_cart_item");
      if (typeof request.message.merchant_id !== "string" || !request.message.merchant_id.trim())
        throw new Error("message.merchant_id is required");
      if (typeof request.message.product_id !== "string" || !request.message.product_id.trim())
        throw new Error("message.product_id is required");
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
      return this.respond(session, result.messages, result.activity ?? []);
    }

    try {
      const result = request.message.kind === "action"
        ? await this.handleStructuredAction(session, request.message)
        : provider === "openai"
          ? await this.runOpenAI(session)
          : await this.runModel(session);
      await this.saveSession(session);
      return this.respond(session, result.messages, result.activity ?? []);
    } catch (err) {
      // A missing/invalid remote model must not make the storefront unusable.
      // The fallback uses the same server-side tools and safety checks.
      console.warn(`[agent] model loop unavailable (${err.message}) - using offline fallback`);
      const result = await this.offlineTurn(session, request.message);
      await this.saveSession(session);
      return this.respond(session, result.messages, result.activity ?? []);
    }
  }

  /** Drop one shopper-profile preference (the widget's "×" on a "What I know" chip). */
  async forgetPreference(request) {
    if (typeof request?.session_id !== "string" || !request.session_id.trim()) throw new Error("session_id is required");
    const key = String(request?.key ?? "");
    if (!PROFILE_KEYS.includes(key)) throw Object.assign(new Error("unknown profile key"), { status: 422, code: "invalid_request" });
    const session = await this.loadSession({ session_id: request.session_id });
    session.profile = forgetFromProfile(session.profile, key, request?.value);
    await this.saveSession(session);
    return { session_id: session.session_id, profile: session.profile };
  }

  async handleStructuredAction(session, message) {
    if (message.action === "update_cart_item") {
      const result = await this.executeTool(
        "update_cart_item",
        {
          merchant_id: message.merchant_id,
          product_id: message.product_id,
          size: message.size,
          color: message.color,
          quantity: message.quantity,
        },
        session,
      );
      if (!result.ok) return { messages: [textMessage(result.error.message)], activity: [] };
      return { messages: [cartMessage(session)], activity: result.activity ? [result.activity] : [] };
    }

    const result = await this.executeTool(
      "add_to_cart",
      {
        merchant_id: message.merchant_id,
        product_id: message.product_id,
        quantity: message.quantity,
        size: message.size,
        color: message.color,
      },
      session,
    );
    if (!result.ok) return { messages: [textMessage(result.error.message)], activity: [] };
    const a = result.added;
    const opt = [a.size && `size ${a.size}`, a.color].filter(Boolean).join(", ");
    return {
      messages: [
        textMessage(`Added ${a.quantity} × ${a.name}${opt ? ` (${opt})` : ""} from ${a.merchant_name} — subtotal $${result.cart.subtotal.toFixed(2)}.`),
        cartMessage(session),
      ],
      activity: result.activity ? [result.activity] : [],
    };
  }

  async offlineTurn(session, message) {
    if (message.kind === "action") return this.handleStructuredAction(session, message);
    const text = message.text.trim();
    const lower = text.toLowerCase();
    const activity = [];
    const run = async (name, params) => {
      const r = await this.executeTool(name, params, session);
      if (r.ok && r.activity) activity.push(r.activity);
      return r;
    };

    // Capture a stated budget into the profile (progressive-profile behaviour
    // that does not need the LLM).
    const budget = maxPriceFromText(text);
    if (budget !== undefined && session.profile?.budget_max !== budget) {
      await run("save_shopper_profile", { budget_max: budget });
    }

    if (/\b(cart|basket)\b/.test(lower) && !hasCheckoutIntent(text)) {
      if (/\b(clear|empty|reset)\b/.test(lower)) {
        session.cart.items = [];
        session.cart.subtotal = 0;
        session.state = "browsing";
        session.checkout_preview = null;
        session.checkout_result = null;
        return { messages: [textMessage("Cleared your cart."), cartMessage(session)], activity };
      }
      await run("get_cart_summary", {});
      return { messages: [cartMessage(session)], activity };
    }

    // "compare the trail shoe and the road shoe"
    if (/\bcompare\b/.test(lower) && session.last_search.length >= 2) {
      const picks = pickProductsFromText(text, session.last_search).slice(0, 4);
      const chosen = picks.length >= 2 ? picks : session.last_search.slice(0, 2);
      const r = await run("compare_products", {
        items: chosen.map((p) => ({ merchant_id: p.merchant_id, product_id: p.product_id })),
      });
      if (!r.ok) return { messages: [textMessage(r.error.message)], activity };
      return {
        messages: [{ type: "comparison", products: r.products, rows: r.rows }],
        activity,
      };
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
      if (!line) return { messages: [textMessage(`I couldn't find "${removeMatch[2].trim()}" in your cart.`), cartMessage(session)], activity };
      await run("update_cart_item", { merchant_id: line.merchant_id, product_id: line.product_id, size: line.options?.size, color: line.options?.color, quantity: 0 });
      return { messages: [textMessage(`Removed ${line.name} from your cart.`), cartMessage(session)], activity };
    }

    const qtyMatch = lower.match(/\b(?:change|set|make|update)\s+(?:the\s+)?(.+?)\s+(?:quantity\s+)?(?:to|=)\s*(\d+)/);
    if (qtyMatch && session.cart.items.length) {
      const term = qtyMatch[1].trim().replace(/\bin (my |the )?(cart|bag)\b/, "").trim();
      const quantity = Number(qtyMatch[2]);
      const line = session.cart.items.find(
        (item) => item.product_id.toLowerCase() === term || (term && item.name.toLowerCase().includes(term)),
      );
      if (!line) return { messages: [textMessage(`I couldn't find "${term}" in your cart.`), cartMessage(session)], activity };
      const result = await run("update_cart_item", { merchant_id: line.merchant_id, product_id: line.product_id, size: line.options?.size, color: line.options?.color, quantity });
      if (!result.ok) return { messages: [textMessage(result.error.message), cartMessage(session)], activity };
      return {
        messages: [
          textMessage(quantity === 0 ? `Removed ${line.name} from your cart.` : `Set ${line.name} to ${quantity}.`),
          cartMessage(session),
        ],
        activity,
      };
    }

    if (hasCheckoutIntent(text)) {
      const result = await run("request_checkout", { cart_id: session.cart.cart_id });
      if (!result.ok) return { messages: [textMessage(result.error.message + ". Add an item first if you want to check out.")], activity };
      return { messages: [{ type: "transaction_preview", preview: result.preview }], activity };
    }

    const directId = text.match(/\b((?:prod|np)_[a-z0-9_-]+)\b/i)?.[1];
    const shouldAdd = /\b(add|select|choose|pick)\b/.test(lower) || Boolean(directId);
    if (shouldAdd && (directId || session.last_search.length)) {
      const pick = directId
        ? session.last_search.find((p) => p.product_id === directId) ?? { product_id: directId }
        : session.last_search[0];
      if (!pick.merchant_id)
        return { messages: [textMessage("Search for that item first so I know which store it's from, then pick a size on the card.")], activity };
      const result = await run("add_to_cart", { merchant_id: pick.merchant_id, product_id: pick.product_id, quantity: 1 });
      if (!result.ok) return { messages: [textMessage(result.error.message)], activity };
      return {
        messages: [
          textMessage(`Added 1 × ${result.added.name} from ${result.added.merchant_name}. Subtotal $${result.cart.subtotal.toFixed(2)}.`),
          cartMessage(session),
        ],
        activity,
      };
    }

    const search = await run("search_products", {
      query: text,
      ...(session.profile?.budget_max ? { max_price: session.profile.budget_max } : {}),
      filters: { available_only: true },
    });
    if (!search.ok) return { messages: [textMessage(search.error.message)], activity };
    if (!search.results.length) return { messages: [textMessage("I couldn't find an available match. Try a different description or budget.")], activity };
    return {
      messages: [
        textMessage(`Here ${search.results.length === 1 ? "is" : "are"} ${search.results.length} option${search.results.length === 1 ? "" : "s"}:`),
        { type: "product_carousel", products: search.results },
      ],
      activity,
    };
  }

  // --- Anthropic tool-calling loop ---
  async runModel(session) {
    let messages = session.history.map((item) => ({ role: item.role, content: item.content }));
    const output = [];
    const activity = [];

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
          max_tokens: 1500,
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
        return { messages: finalizeMessages(output.length ? output : [textMessage("How can I help you shop today?")]), activity };
      }

      messages.push({ role: "assistant", content });
      const results = [];
      for (const call of calls) {
        const result = await this.executeTool(call.name, call.input ?? {}, session);
        if (result.ok && result.activity) activity.push(result.activity);
        output.push(...messagesForTool(call.name, result, session));
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
    const activity = [];

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
        return { messages: finalizeMessages(output.length ? output : [textMessage("How can I help you shop today?")]), activity };
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
        if (result.ok && result.activity) activity.push(result.activity);
        output.push(...messagesForTool(call.function?.name, result, session));
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("tool loop exceeded its safety limit");
  }
}

/** Loose name/id match of catalogue products mentioned in free text (offline compare). */
function pickProductsFromText(text, pool) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const p of pool) {
    if (lower.includes(p.product_id.toLowerCase()) || (p.name && lower.includes(p.name.toLowerCase().split(" ")[0]))) {
      if (!hits.some((h) => h.product_id === p.product_id)) hits.push(p);
    }
  }
  return hits;
}

export function createDefaultAgent(options = {}) {
  return new CommerceAgent(options);
}

export { MemoryStore };
