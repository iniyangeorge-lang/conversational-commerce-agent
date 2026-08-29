// Phase 1 - Mock Visa payment service.
// Placeholder entrypoint created in Phase 0 scaffolding.
//
// Endpoints to implement:
//   POST /mock-visa/tokenize            -> { payment_token, card_last4, created_at }
//   POST /mock-visa/charge              -> approved | declined  (idempotent on order_ref)
//   GET  /mock-visa/transactions/:merchant_id
//
// Demo decline rule: amount ending in .13 -> declined (insufficient_funds).

const PORT = process.env.PAYMENTS_PORT ?? 4001;

console.log(`[payments] scaffold only - implement in Phase 1. Would listen on :${PORT}`);
