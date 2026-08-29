// Payment simulation rules.
//
// DEMO_DECLINE_CENTS mirrors `@cca/contracts` (contracts/src/payments.ts). It is
// re-declared here on purpose: this service is meant to be standalone, so it
// carries its own copy of the one rule that matters rather than importing it.

export const DEMO_DECLINE_CENTS = 13;

/** Round a computed amount to whole cents. */
export const roundMoney = (amount) => Math.round(amount * 100) / 100;

/**
 * Demo decline rule: any charge whose amount ends in `.13` is declined. Gives a
 * reliable, repeatable way to trigger the failure path during a live demo.
 */
export function isDemoDecline(amount) {
  const cents = Math.round(roundMoney(amount) * 100) % 100;
  return cents === DEMO_DECLINE_CENTS;
}
