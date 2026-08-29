// Phase 4 - AI agent layer.
// Placeholder entrypoint created in Phase 0 scaffolding.
//
// Tools exposed to the LLM: search_products, add_to_cart, get_cart_summary, request_checkout.
// NO charge_payment tool exists - request_checkout only produces a confirmation card.
// State machine (Redis, per session):
//   browsing -> comparing -> cart_building -> awaiting_confirmation -> paid | declined | abandoned
// request_checkout is only valid from cart_building with a non-empty cart.

const PORT = process.env.AGENT_PORT ?? 4003;

console.log(`[agent] scaffold only - implement in Phase 4. Would listen on :${PORT}`);
