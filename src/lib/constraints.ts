/**
 * Constraint Engine.
 *
 * Maps each Requirement to a set of allowed/blocked product domains BEFORE
 * the resolver ranks candidates. Stops cross-domain pollution at the source —
 * "Lemon" the ingredient never sees "Lemon Detergent" enter ranking, because
 * the constraint engine already filtered cleaning-domain products out.
 *
 * Inputs the engine reasons over:
 *   - queryType (product / brand / ingredient / dish / mission / festival / category)
 *   - the requirement itself (its display name, its resolver-shape type)
 *   - the festival key extracted by the classifier (if queryType=festival)
 *
 * The planner can override the auto-inferred allow-list by setting
 * `allowedDomains` on a Requirement — but for the v3.5 planner output we
 * fall back to deterministic inference here.
 */
import type { Requirement } from "./planner.js";
import type { QueryType } from "./classifier.js";
import {
  type ProductDomain,
  type FestivalKey,
  FESTIVAL_KEYWORDS,
  matchesRivalFestival,
} from "./domains.js";

export type Constraint = {
  /** Allowed domains. If empty, all domains are allowed. */
  allowed: ProductDomain[];
  /** Always-blocked domains. Wins over `allowed`. */
  blocked: ProductDomain[];
  /** Festival key — when set, products in domain=festival must match this and not rivals. */
  festival?: FestivalKey;
  /** Free-form reason for the trace. */
  reason: string;
};

const FOOD_LIKE: ProductDomain[] = ["food", "ingredient", "beverage", "snack"];
const CLEANING_LIKE: ProductDomain[] = ["cleaning", "household"];
const NEVER_FOR_FOOD: ProductDomain[] = [
  "cleaning",
  "personal_care",
  "medicine",
  "household",
  "festival",
  "baby_care",
];

/**
 * Decide the constraint for a single requirement given the top-level query
 * intent. The orchestrator passes `queryType` and an optional `festival`
 * key (from the classifier slug for festival queries).
 */
export function constraintFor(
  req: Requirement,
  queryType: QueryType | "festival",
  festival: FestivalKey | null,
): Constraint {
  // Planner override always wins — keeps the constraint engine extensible
  // without a code change every time we add a new req shape.
  if (req.allowedDomains && req.allowedDomains.length > 0) {
    return {
      allowed: req.allowedDomains as ProductDomain[],
      blocked: [],
      reason: `planner-set: ${req.allowedDomains.join(",")}`,
    };
  }

  // 1) Festival queries — ALL requirements must hit a festival product
  // matching the right festival keywords.
  if (queryType === "festival" && festival) {
    return {
      allowed: ["festival"],
      blocked: [],
      festival,
      reason: `festival=${festival}`,
    };
  }

  // 2) Ingredient queries — strictly food-domain. Blocks cleaning/personal-care/
  // household so "Lemon" never returns "Lemon Detergent".
  if (queryType === "ingredient") {
    return {
      allowed: ["ingredient", "food"],
      blocked: NEVER_FOR_FOOD.filter((d) => d !== "baby_care"),
      reason: "ingredient query — food domains only",
    };
  }

  // 3) Brand queries — no domain restriction. A brand can span anything.
  if (queryType === "brand") {
    return { allowed: [], blocked: [], reason: "brand query — no domain limit" };
  }

  // 4) Product queries — usually a packaged item; trust the resolver's
  // nameMatch ordering. No domain restriction unless the requirement name
  // is clearly food-y (handled below).
  if (queryType === "product") {
    return { allowed: [], blocked: [], reason: "product query — no domain limit" };
  }

  // 5) Dish queries — every essential is something you put into food.
  // Block cleaning, personal-care, festival, medicine.
  if (queryType === "dish") {
    return {
      allowed: FOOD_LIKE,
      blocked: NEVER_FOR_FOOD,
      reason: "dish query — edible domains only",
    };
  }

  // 6) Mission / category — per-requirement: look at the requirement's
  // display name to figure out which domain it's asking for.
  return inferFromRequirementName(req);
}

const NAME_HINTS: { match: RegExp; allowed: ProductDomain[]; blocked?: ProductDomain[]; reason: string }[] = [
  {
    match: /\b(diaper|baby food|baby formula|baby cereal|infant)\b/i,
    allowed: ["baby_care"],
    reason: "baby-care item",
  },
  {
    match: /\b(detergent|dishwash|floor cleaner|surface cleaner|toilet cleaner)\b/i,
    allowed: ["cleaning"],
    reason: "cleaning item",
  },
  {
    match: /\b(soap|shampoo|toothpaste|toothbrush|deodorant|body wash|face wash|lotion|moisturizer)\b/i,
    allowed: ["personal_care", "baby_care"],
    reason: "personal-care item",
  },
  {
    match: /\b(milk|sugar|oil|butter|ghee|salt|tomato|onion|potato|paneer|cheese|egg|rice|atta|dal|flour)\b/i,
    allowed: ["ingredient", "food"],
    blocked: NEVER_FOR_FOOD,
    reason: "edible ingredient",
  },
  {
    match: /\b(tea|coffee|juice|soft drink|water|cola|beverage|drink)\b/i,
    allowed: ["beverage", "ingredient", "food"],
    reason: "beverage item",
  },
  {
    match: /\b(chips|biscuit|cookie|chocolate|candy|namkeen|snack|popcorn|nachos|wafer)\b/i,
    allowed: ["snack", "food"],
    reason: "snack item",
  },
  {
    match: /\b(noodle|maggi|pasta|breakfast|cereal|sandwich|pav|bread|bun|cake|pastry)\b/i,
    allowed: ["food", "ingredient", "snack"],
    reason: "prepared-food item",
  },
  {
    match: /\b(diya|rangoli|toran|pooja|puja|festive|christmas tree|santa|rakhi)\b/i,
    allowed: ["festival"],
    reason: "festival item",
  },
];

function inferFromRequirementName(req: Requirement): Constraint {
  const name = req.name;
  for (const hint of NAME_HINTS) {
    if (hint.match.test(name)) {
      return {
        allowed: hint.allowed,
        blocked: hint.blocked ?? [],
        reason: hint.reason,
      };
    }
  }
  // No hint fired — don't constrain. The mission KB usually puts the
  // requirement in a sub-cat that's already domain-correct.
  return { allowed: [], blocked: [], reason: "no name-based hint" };
}

/**
 * Decide whether a single product passes the constraint.
 * Used by the resolver as a post-fetch filter.
 */
export function passesConstraint(
  product: { name: string; domain: string | null },
  constraint: Constraint,
): boolean {
  const dom = (product.domain ?? null) as ProductDomain | null;

  if (constraint.blocked.length > 0 && dom && constraint.blocked.includes(dom)) {
    return false;
  }
  if (constraint.allowed.length > 0) {
    if (!dom) return false;
    if (!constraint.allowed.includes(dom)) return false;
  }
  if (constraint.festival) {
    if (dom !== "festival") {
      // Festival mode — only festival-domain products allowed.
      return false;
    }
    const target = constraint.festival;
    // Must mention the festival OR be in a generic festive sub-cat
    // (we accept generic festive items too — many "Diya Set" listings
    // don't say "Diwali" explicitly).
    const targetRe = FESTIVAL_KEYWORDS[target];
    const generic = !Object.values(FESTIVAL_KEYWORDS).some((re) => re.test(product.name));
    if (!generic && !targetRe.test(product.name)) return false;
    if (matchesRivalFestival(product.name, target)) return false;
  }
  return true;
}

/**
 * Extract the festival key from the classifier's slug.
 * Returns null if the slug doesn't match a known festival.
 */
export function festivalFromSlug(slug: string | null): FestivalKey | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s.includes("diwali") || s.includes("deepavali")) return "diwali";
  if (s.includes("christmas") || s.includes("xmas")) return "christmas";
  if (s.includes("holi")) return "holi";
  if (s.includes("eid") || s.includes("ramadan")) return "eid";
  if (s.includes("rakhi") || s.includes("raksha")) return "raksha_bandhan";
  return null;
}
