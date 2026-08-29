// Payment simulation rules.
//
// Decline behaviour is keyed to the card number (like a real gateway's test
// PANs), decided at tokenization and carried on the token. Everything else
// approves. Kept inline so this service stays standalone.

/** Test PAN -> decline reason. Any other 12-19 digit number approves. */
export const DECLINE_TEST_CARDS = {
  "4000000000000002": "card_declined",
  "4000000000009995": "insufficient_funds",
  "4000000000000069": "expired_card",
  "4000000000000119": "suspected_fraud",
};

/** @returns {string|null} a decline reason for a known bad test card, else null. */
export function classifyCard(cardNumber) {
  const digits = String(cardNumber ?? "").replace(/\D/g, "");
  return DECLINE_TEST_CARDS[digits] ?? null;
}

/** Round a computed amount to whole cents. */
export const roundMoney = (amount) => Math.round(amount * 100) / 100;
