// Category templates (Phase 2, step 3).
//
// The merchant picks a category at onboarding. It is stored on the merchant and
// on every product, and later selects which system prompt the agent uses and
// which extra attributes it asks about before checkout.

/** @typedef {import("@cca/contracts").ProductCategory} ProductCategory */

export const CATEGORIES = ["food", "fashion", "electronics", "travel"];

export const CATEGORY_TEMPLATES = {
  food: {
    refine_attributes: ["dietary", "spice_level"],
    array_attributes: ["dietary"],
    agent_prompt_hint: "Ask about delivery time and any dietary restrictions.",
  },
  fashion: {
    refine_attributes: ["size", "color"],
    array_attributes: ["size", "color"],
    agent_prompt_hint: "Ask for size and colour before calling request_checkout.",
  },
  electronics: {
    refine_attributes: ["spec_priority"],
    array_attributes: [],
    agent_prompt_hint: "Ask which specs matter most (performance, battery, price).",
  },
  travel: {
    refine_attributes: ["dates", "passengers"],
    array_attributes: [],
    agent_prompt_hint: "Ask for travel dates and passenger count.",
  },
};

export const isCategory = (c) => CATEGORIES.includes(c);

/** Attribute keys that carry a `|`-separated list in CSV / an array from extract. */
export function arrayAttributes(category) {
  return new Set(CATEGORY_TEMPLATES[category]?.array_attributes ?? []);
}
