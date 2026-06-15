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
import type { CartParameters } from "./types/cart.types.js";
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
  /** Soft preference: products whose name matches one of these get a rank bonus, but unmatched products are NOT dropped. */
  nameBoost: RegExp[];
  /** Hard filter: products whose name matches any of these are dropped. */
  nameExclude: RegExp[];
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
 * intent. The orchestrator passes `queryType`, an optional festival key, and
 * optional caller-supplied parameters (taste/diet/health flags). Parameters
 * compile to nameInclude / nameExclude regex patterns that survive into the
 * resolver's filtering step.
 */
export function constraintFor(
  req: Requirement,
  queryType: QueryType | "festival",
  festival: FestivalKey | null,
  parameters: CartParameters = {},
): Constraint {
  const paramFilter = compileParameterFilter(parameters);

  // Planner override always wins — keeps the constraint engine extensible
  // without a code change every time we add a new req shape.
  if (req.allowedDomains && req.allowedDomains.length > 0) {
    return finalize({
      allowed: req.allowedDomains as ProductDomain[],
      blocked: [],
      reason: `planner-set: ${req.allowedDomains.join(",")}`,
    }, paramFilter);
  }

  // 1) Festival queries — ALL requirements must hit a festival product
  // matching the right festival keywords.
  if (queryType === "festival" && festival) {
    return finalize({
      allowed: ["festival"],
      blocked: [],
      festival,
      reason: `festival=${festival}`,
    }, paramFilter);
  }

  // 2) Ingredient queries — strictly food-domain. Blocks cleaning/personal-care/
  // household so "Lemon" never returns "Lemon Detergent".
  if (queryType === "ingredient") {
    return finalize({
      allowed: ["ingredient", "food"],
      blocked: NEVER_FOR_FOOD.filter((d) => d !== "baby_care"),
      reason: "ingredient query — food domains only",
    }, paramFilter);
  }

  // 3) Brand queries — no domain restriction. A brand can span anything.
  if (queryType === "brand") {
    return finalize({ allowed: [], blocked: [], reason: "brand query — no domain limit" }, paramFilter);
  }

  // 4) Product queries — usually a packaged item; trust the resolver's
  // nameMatch ordering. No domain restriction unless the requirement name
  // is clearly food-y (handled below).
  if (queryType === "product") {
    return finalize({ allowed: [], blocked: [], reason: "product query — no domain limit" }, paramFilter);
  }

  // 5) Dish queries — every essential is something you put into food.
  // Block cleaning, personal-care, festival, medicine.
  if (queryType === "dish") {
    return finalize({
      allowed: FOOD_LIKE,
      blocked: NEVER_FOR_FOOD,
      reason: "dish query — edible domains only",
    }, paramFilter);
  }

  // 6) Mission / category — per-requirement: look at the requirement's
  // display name to figure out which domain it's asking for.
  return finalize(inferFromRequirementName(req), paramFilter);
}

type PartialConstraint = Omit<Constraint, "nameBoost" | "nameExclude"> & {
  nameBoost?: RegExp[];
  nameExclude?: RegExp[];
};

type ParamFilter = {
  boost: RegExp[];
  exclude: RegExp[];
  notes: string[];
};

function finalize(c: PartialConstraint, p: ParamFilter): Constraint {
  const nameBoost = [...(c.nameBoost ?? []), ...p.boost];
  const nameExclude = [...(c.nameExclude ?? []), ...p.exclude];
  const reason = p.notes.length ? `${c.reason}; params=${p.notes.join("+")}` : c.reason;
  return {
    allowed: c.allowed,
    blocked: c.blocked,
    festival: c.festival,
    nameBoost,
    nameExclude,
    reason,
  };
}

/**
 * Compile caller-supplied parameters into name-level include / exclude
 * regexes that the resolver can apply to candidate products.
 *
 * Recognized keys:
 *   tastePreference (string|string[]):  sweet | savory | salty | spicy | sour | umami
 *   spiceLevel ("mild"|"medium"|"hot"): nudges include/exclude
 *   healthy (bool)                       → exclude fried/junk markers, prefer healthy markers
 *   vegetarian (bool)                    → exclude meat/seafood
 *   vegan (bool)                         → exclude meat + dairy + egg
 *   glutenFree (bool)                    → exclude wheat/atta/maida/bread/noodle/pasta
 *   dairyFree (bool)                     → exclude milk/butter/cheese/curd/paneer/ghee
 *   lowSugar (bool)                      → exclude candy/chocolate/cake/sugary
 *   highProtein (bool)                   → prefer protein markers (paneer/dal/egg/nuts/yogurt)
 *
 * Unknown keys are silently ignored.
 */
function compileParameterFilter(params: CartParameters): ParamFilter {
  const boost: RegExp[] = [];
  const exclude: RegExp[] = [];
  const notes: string[] = [];

  // Tokenize tastes into a single OR.
  const tastes = normalizeStringList(params.tastePreference ?? params.taste);
  if (tastes.length > 0) {
    const includeBits: string[] = [];
    for (const t of tastes) {
      switch (t) {
        case "sweet":
          includeBits.push(
            "chocolate", "biscuit", "cookie", "cake", "candy", "ladoo", "barfi",
            "halwa", "kheer", "sweet", "honey", "jam", "fruit", "yogurt", "shrikhand",
            "ice cream", "dessert", "muffin", "brownie", "pastry", "milkshake",
            "granola", "muesli", "dates",
          );
          break;
        case "savory":
        case "savoury":
          includeBits.push(
            "namkeen", "chips", "wafer", "popcorn", "khakhra", "mathri", "bhujia",
            "sev", "mixture", "chivda", "papad", "pickle", "chakli", "murukku",
            "samosa", "kachori", "bhel", "snack", "cracker", "nachos", "chickpea",
            "roasted", "veggie", "vegetable",
          );
          break;
        case "salty":
          includeBits.push("chips", "namkeen", "bhujia", "sev", "wafer", "popcorn", "salted");
          break;
        case "spicy":
          includeBits.push("masala", "spicy", "peri peri", "schezwan", "chilli", "hot");
          break;
        case "sour":
          includeBits.push("lemon", "tangy", "imli", "sour");
          break;
      }
    }
    if (includeBits.length) boost.push(makeWordRegex(includeBits));
    notes.push(`taste=${tastes.join("/")}`);
  }

  if (truthy(params.healthy) || truthy(params.isHealthy)) {
    exclude.push(makeWordRegex([
      "fried", "deep fried", "instant noodle", "maggi", "candy", "lollipop",
      "soda", "cola", "soft drink", "energy drink", "chocolate bar",
    ]));
    notes.push("healthy");
  }

  if (truthy(params.vegetarian) || truthy(params.isVegetarian)) {
    exclude.push(makeWordRegex([
      "chicken", "mutton", "beef", "pork", "fish", "prawn", "shrimp", "egg",
      "non-veg", "non veg",
    ]));
    notes.push("vegetarian");
  }

  if (truthy(params.vegan) || truthy(params.isVegan)) {
    exclude.push(makeWordRegex([
      "chicken", "mutton", "beef", "pork", "fish", "prawn", "shrimp", "egg",
      "milk", "butter", "ghee", "cheese", "curd", "paneer", "yogurt", "dairy",
      "non-veg", "non veg",
    ]));
    notes.push("vegan");
  }

  if (truthy(params.glutenFree) || truthy(params.isGlutenFree)) {
    exclude.push(makeWordRegex([
      "wheat", "atta", "maida", "bread", "bun", "pav", "noodle", "pasta",
      "biscuit", "cookie", "cake", "rusk", "samosa", "khakhra",
    ]));
    notes.push("glutenFree");
  }

  if (truthy(params.dairyFree) || truthy(params.isDairyFree)) {
    exclude.push(makeWordRegex([
      "milk", "butter", "ghee", "cheese", "curd", "paneer", "yogurt", "dairy",
      "shrikhand", "lassi", "khoa",
    ]));
    notes.push("dairyFree");
  }

  if (truthy(params.lowSugar) || truthy(params.isLowSugar) || truthy(params.sugarFree)) {
    exclude.push(makeWordRegex([
      "candy", "chocolate", "cake", "barfi", "ladoo", "halwa", "kheer", "jaggery",
      "sugar", "syrup", "honey", "soft drink", "cola", "soda",
    ]));
    notes.push("lowSugar");
  }

  if (truthy(params.highProtein) || truthy(params.isHighProtein)) {
    boost.push(makeWordRegex([
      "paneer", "tofu", "egg", "dal", "chana", "rajma", "soya", "soy", "almond",
      "peanut", "cashew", "yogurt", "curd", "milk", "cheese", "oats", "quinoa",
      "protein",
    ]));
    notes.push("highProtein");
  }

  if (truthy(params.organic) || truthy(params.isOrganic)) {
    boost.push(makeWordRegex(["organic", "natural"]));
    notes.push("organic");
  }

  return { boost, exclude, notes };
}

function normalizeStringList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  return [String(v).toLowerCase().trim()].filter(Boolean);
}

function truthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") return ["true", "yes", "1"].includes(v.toLowerCase());
  if (typeof v === "number") return v !== 0;
  return false;
}

function makeWordRegex(words: string[]): RegExp {
  const escaped = words
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Word-boundary on letters; allow hyphenated/spaced compounds.
  return new RegExp(`(?:^|[^a-z])(?:${escaped.join("|")})(?![a-z])`, "i");
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

function inferFromRequirementName(req: Requirement): Omit<Constraint, "nameBoost" | "nameExclude"> {
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
  if (constraint.nameExclude.length > 0) {
    for (const re of constraint.nameExclude) {
      if (re.test(product.name)) return false;
    }
  }
  // nameBoost is intentionally NOT enforced here — it's a soft preference
  // applied at rank time via constraintRankBoost(), not a hard filter.
  return true;
}

/**
 * Soft rank bonus from parameter-derived `nameBoost` patterns.
 * Returns 0 if the constraint has no boosts; up to ~0.4 for products that
 * match multiple boost terms.
 */
export function constraintRankBoost(
  product: { name: string },
  constraint: Constraint,
): number {
  if (constraint.nameBoost.length === 0) return 0;
  let hits = 0;
  for (const re of constraint.nameBoost) {
    if (re.test(product.name)) hits++;
  }
  if (hits === 0) return 0;
  // First match worth 0.2; diminishing returns after.
  return Math.min(0.4, 0.2 + 0.1 * (hits - 1));
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
