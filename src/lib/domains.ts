/**
 * Product Domain Classification.
 *
 * Every product gets exactly one domain. The constraint engine uses this to
 * stop cross-domain pollution — e.g. a "Lemon" ingredient requirement
 * filters out anything whose domain isn't `ingredient` or `food`, which is
 * what kills "Lemon Detergent" before it can pollute the cart.
 *
 * Strategy: a (subCategory → domain) override table for the cases where the
 * parent category is mixed, and a (category → domain) fallback for the rest.
 * The catalog's 22 categories × 217 sub-categories all resolve via these
 * rules. The extractor's LLM step exists for future products that land in
 * sub-categories we haven't seen.
 */

export type ProductDomain =
  | "food"
  | "ingredient"
  | "beverage"
  | "snack"
  | "baby_care"
  | "medicine"
  | "household"
  | "cleaning"
  | "festival"
  | "personal_care";

export const ALL_DOMAINS: ProductDomain[] = [
  "food",
  "ingredient",
  "beverage",
  "snack",
  "baby_care",
  "medicine",
  "household",
  "cleaning",
  "festival",
  "personal_care",
];

/**
 * Sub-category overrides. Checked first — wins over CAT_RULES.
 * Only listed when the sub-category's domain disagrees with its parent
 * category, OR when a sub-category appears under multiple parents and
 * always means the same thing (e.g. "Zepto Cafe" → food everywhere).
 */
const SUB_RULES: Record<string, ProductDomain> = {
  // Baby items that live under non-baby parents
  "Baby Bath": "baby_care",
  "Baby Hygiene": "baby_care",
  "Kids' Nutrition": "baby_care",

  // Festive items inside Home Needs
  "Festive Needs": "festival",
  "Pooja & Worship Needs": "festival",

  // Beverages inside non-beverage parents
  "Vegan Drinks": "beverage",
  "Tea & Coffee": "beverage",

  // Prepared-food shelves that recur under several parents
  "Zepto Cafe": "food",

  // Snack-y picks under Paan Corner (the rest of paan is personal-care)
  "Mints & Gums": "snack",
  "Fresheners & Sweets": "snack",

  // Health & Baby Care has one personal-care sub
  "Wipes, Masks & More": "personal_care",

  // Tea, Coffee & More has one food sub
  "Adult Nutrition": "food",

  // Breakfast & Sauces is genuinely mixed — pin every sub-cat
  "Batter & Mixes": "food",
  "Breakfast Cereals": "food",
  "Dates & Seeds": "ingredient",
  "Honey & Spreads": "ingredient",
  "Ketchup & Sauces": "ingredient",
  "Muesli & Oats": "food",
  "Peanut Butter": "ingredient",

  // Homegrown Brands is also fully mixed
  "Assorted Snacks": "snack",
  "Drinks & Juices": "beverage",
  "Home & Cleaning": "cleaning",
  "Home Electronics": "household",
  "Hygiene & Grooming": "personal_care",
  "Instant & Packaged Food": "food",
  "Makeup & Beauty": "personal_care",
  "Personal Care": "personal_care",
};

/**
 * (category, subCategory) overrides. Checked before SUB_RULES.
 * Used when the same sub-category name carries different meaning under
 * different parents — e.g. the "Baby Food" parent category in this catalog
 * actually contains general pantry food (Hakka noodles, MTR mixes, pasta)
 * rather than infant formula. Only the literal "Baby Food / Baby Food"
 * pair is genuine baby_care.
 */
const PAIR_RULES: Record<string, ProductDomain> = {
  "Baby Food|Baby Food": "baby_care",
  "Baby Food|Baking Mixes & Ingredients": "ingredient",
  "Baby Food|Dessert Mixes": "food",
  "Baby Food|Noodles & Vermicelli": "food",
  "Baby Food|Papads, Pickles & Chutney": "ingredient",
  "Baby Food|Pasta & Soups": "food",
  "Baby Food|Ready To Cook": "food",
  "Baby Food|Ready To Eat": "food",
};

/**
 * Default per parent category. Applied when no sub-category rule fires.
 */
const CAT_RULES: Record<string, ProductDomain> = {
  "Atta, Rice, Oil & Dals": "ingredient",
  "Baby Food": "baby_care",
  "Bath & Body": "personal_care",
  "Biscuits": "snack",
  "Breakfast & Sauces": "ingredient",
  "Cleaning Essentials": "cleaning",
  "Cold Drinks & Juices": "beverage",
  "Dairy, Bread & Eggs": "ingredient",
  "Electricals & Accessories": "household",
  "Frozen Food & Ice Creams": "food",
  "Fruits & Vegetables": "ingredient",
  "Health & Baby Care": "medicine",
  "Home Needs": "household",
  "Hygiene & Grooming": "personal_care",
  "Makeup & Beauty": "personal_care",
  "Masala & Dry Fruits": "ingredient",
  "Meats, Fish & Eggs": "ingredient",
  "Munchies": "snack",
  "Paan Corner": "personal_care",
  "Sweet Cravings": "snack",
  "Tea, Coffee & More": "beverage",
  // Homegrown Brands has no sensible default — always handled by SUB_RULES.
};

/**
 * Pure rule-based classification. Returns null when nothing matches —
 * the caller falls back to the LLM extractor.
 */
export function classifyDomainByRules(
  category: string,
  subCategory: string,
): ProductDomain | null {
  const pair = PAIR_RULES[`${category}|${subCategory}`];
  if (pair) return pair;
  const sub = SUB_RULES[subCategory];
  if (sub) return sub;
  const cat = CAT_RULES[category];
  if (cat) return cat;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Festival keyword filters — used by the constraint engine when a requirement
// is festival-scoped. A product in domain=festival passes only if its name
// contains the festival's terms AND none of the rival festivals' terms.
// ─────────────────────────────────────────────────────────────────────────────

export type FestivalKey = "diwali" | "christmas" | "holi" | "eid" | "raksha_bandhan";

export const FESTIVAL_KEYWORDS: Record<FestivalKey, RegExp> = {
  diwali: /\b(diwali|deepavali|diya|rangoli|toran|lakshmi|ganesh)\b/i,
  christmas: /\b(christmas|xmas|santa|reindeer|mistletoe|advent)\b/i,
  holi: /\b(holi|gulal|pichkari)\b/i,
  eid: /\b(eid|ramadan|ramzan|sehri|iftar)\b/i,
  raksha_bandhan: /\b(rakhi|raksha\s*bandhan)\b/i,
};

const RIVAL_FESTIVALS: Record<FestivalKey, FestivalKey[]> = {
  diwali: ["christmas", "holi", "eid", "raksha_bandhan"],
  christmas: ["diwali", "holi", "eid", "raksha_bandhan"],
  holi: ["diwali", "christmas", "eid", "raksha_bandhan"],
  eid: ["diwali", "christmas", "holi", "raksha_bandhan"],
  raksha_bandhan: ["diwali", "christmas", "holi", "eid"],
};

/** True if `name` matches any rival festival's keywords for `target`. */
export function matchesRivalFestival(name: string, target: FestivalKey): boolean {
  for (const rival of RIVAL_FESTIVALS[target]) {
    if (FESTIVAL_KEYWORDS[rival].test(name)) return true;
  }
  return false;
}
