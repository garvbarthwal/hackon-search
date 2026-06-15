/**
 * Stage 2 — Stateless Planner.
 *
 * Takes (classifierOutput, query, parameters) and produces a finalized
 * requirement graph. SmartCart never asks questions — the frontend gathers any
 * follow-up context and passes it in via `parameters`. Parameters always
 * override defaults (e.g. `parameters.people=8` ⇒ requirements scaled for 8).
 *
 * For non-mission/dish queries (product, brand, ingredient, category), the
 * planner still produces a Requirement[] but with shapes that drive the
 * resolver's tier 1/2/4/3 paths respectively.
 */
import { llm } from "./llm.js";
import { prisma } from "./db.js";
import { getCached, setCached } from "./cache.js";
import type { ClassifierOutput, QueryType } from "./classifier.js";
import type { CartParameters } from "./types/cart.types.js";

export type RequirementType = "required" | "recommended" | "optional" | "substitutable";

export type Requirement = {
  /** Required: exact_product, brand, ingredient, subcategory */
  type: "exact_product" | "brand" | "ingredient" | "subcategory" | "name";
  /** Display label / canonical name. */
  name: string;
  /** Sub-category names from the catalog (resolver tier 3). */
  hints?: string[];
  /** Lowercase name keywords (resolver tier 1, used for ingredient/exact_product). */
  nameMatch?: string[];
  /** Brand name (resolver tier 2). */
  brand?: string;
  /** required|recommended|optional|substitutable — drives validator behavior. */
  priority: RequirementType;
  /** Optional planner override of the constraint engine's domain allow-list. */
  allowedDomains?: string[];
  /** Caller-readable target quantity, scaled from parameters (e.g. "2 packs", "for 5 people"). */
  quantity?: string;
};

export type PlannerOutput = {
  queryType: QueryType;
  confidence: number;
  missionSlug: string | null;
  requirements: {
    essentials: Requirement[];
    recommended: Requirement[];
    premium: Requirement[];
  };
};

const REQ_SCHEMA = () => ({
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Short display label, e.g. 'Sweet Snack', 'Pav', 'Face Wash'.",
    },
    priority: {
      type: "string",
      enum: ["required", "recommended", "optional", "substitutable"],
    },
    hints: {
      type: "string",
      description:
        "Comma-separated sub-category names from the AVAILABLE list. Empty string if none. Example: 'Face Wash & Cleansers, Body Lotion'.",
    },
    nameMatch: {
      type: "string",
      description:
        "Comma-separated 1-3 lowercase product-name keywords for whole-catalog match. Example: 'face wash, cleanser'.",
    },
    brand: {
      type: "string",
      description: "Brand name when this is a brand requirement. Empty string otherwise.",
    },
    quantity: {
      type: "string",
      description: "Target quantity scaled from parameters. Empty string if no scaling.",
    },
  },
  required: ["name", "priority", "hints", "nameMatch", "brand", "quantity"],
});

const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    confidence: { type: "number" },
    missionSlug: { type: "string" },
    essentials: { type: "array", items: REQ_SCHEMA() },
    recommended: { type: "array", items: REQ_SCHEMA() },
    premium: { type: "array", items: REQ_SCHEMA() },
  },
  required: ["confidence", "missionSlug", "essentials", "recommended", "premium"],
};

type PlannerLLMOut = {
  confidence: number;
  missionSlug: string;
  essentials: Requirement[];
  recommended: Requirement[];
  premium: Requirement[];
};

const SYSTEM = (
  query: string,
  parameters: CartParameters,
  cls: ClassifierOutput,
  subcatList: string,
  knownEntries: string,
  topBrands: string,
) => `
You are a shopping cart planner.

USER QUERY: ${JSON.stringify(query)}
USER PARAMETERS: ${JSON.stringify(parameters ?? {})}

Build a requirement list FOR THIS EXACT QUERY. Do not fall back to the queryType alone — the query string is authoritative.

Pre-classification (advisory):
- queryType: ${cls.queryType}
- classifier confidence: ${cls.confidence.toFixed(2)}
- suggested slug: ${cls.slug ?? "(none)"}
- suggested brand: ${cls.brand ?? "(none)"}
- suggested ingredient: ${cls.ingredient ?? "(none)"}
- suggested categories: ${cls.categories.join(", ") || "(none)"}

Your job: produce a finalized requirement list for the USER QUERY above. NEVER ask questions — if context is thin, make reasonable defaults from the query. Use the PARAMETERS block when set.

REQUIREMENT SHAPES BY queryType:
- product:    one essential. Set nameMatch to 1-3 keywords identifying the product (e.g. "maggi" or "oreo, biscuit"). hints can include the right sub-category.
- brand:      one essential. Set brand to the canonical brand name. hints can include the brand's typical sub-categories.
- ingredient: one essential. Set nameMatch to the ingredient noun + 1-2 synonyms. hints to relevant sub-cats (e.g. "Fresh Vegetables").
- category:   one essential per named category. hints = exact sub-category names from AVAILABLE list. nameMatch may be empty.
- dish:       full essentials list — actual ingredients to MAKE the dish. Pav Bhaji needs Pav (not generic bread). Always set both hints and nameMatch.
- mission:    full essentials list — items needed to fulfil the goal. Cover BOTH food AND non-food missions. Examples (hints/nameMatch are comma-separated strings):
              · "Tea party"  → Tea (hints="Tea", nameMatch="tea"), Milk (hints="Milk", nameMatch="milk"), Sugar (hints="Sugar & Jaggery", nameMatch="sugar")
              · "Movie night" → Popcorn (hints="Veg Snacks", nameMatch="popcorn"), Nachos (hints="Chips & Crisps", nameMatch="nachos"), Soft Drinks (hints="Soda & Mixers, Soft Drinks", nameMatch="cola, soda, soft drink")
              · "Hostel starter pack" → Soap (hints="Soaps", nameMatch="soap"), Detergent (hints="Detergent Powder & Bars", nameMatch="detergent"), Toothpaste (hints="Toothpaste", nameMatch="toothpaste")
              · "Skin care routine" / "skin care for dry skin" → Face Wash (hints="Face Wash & Cleansers", nameMatch="face wash, cleanser"),
                                                                  Moisturizer (hints="Body Lotion, Face Cream & Moisturisers", nameMatch="moisturizer, cream, lotion"),
                                                                  Sunscreen (hints="Sunscreen", nameMatch="sunscreen, spf"),
                                                                  Lip Balm (hints="Lip Balm", nameMatch="lip balm")
              · "Hair care" → Shampoo, Conditioner, Hair Oil (each with matching hints/nameMatch)
              · "Baby care" → Baby Diapers (hints="Baby Diapers", nameMatch="diaper"), Baby Lotion, Baby Wipes, Baby Soap
              For non-food missions, USE personal_care / baby_care / household sub-categories from the AVAILABLE list. Don't force food when the query isn't food.
- festival:   full essentials list scoped to the named festival. Diwali = Diyas + Rangoli + Pooja items. Christmas = Tree + Decor. NEVER mix festivals — Diwali requirements never include Christmas keywords. Always set missionSlug to the festival's slug (diwali, christmas, holi, eid, raksha_bandhan).

OUTPUT MUST BE NON-EMPTY for dish, mission, and festival queries. Returning [] essentials is a failure — always provide at least 2 essentials for these query types, even if you have to make best-effort guesses from the AVAILABLE sub-category list.

PARAMETER USAGE (CRITICAL):
- The PARAMETERS block (below the user query) is authoritative. ALWAYS prefer it over your own assumptions.
- Common parameter keys you must respect when present:
  · people / guestCount / servings → scale the 'quantity' string for every essential and recommended item
  · tastePreference / taste (e.g. "sweet", ["sweet","savory"]) → bias the requirement list toward those tastes; for vague missions ("evening snacks"), SPLIT into one essential per taste with concrete categories ("Sweet Snack", "Savory Snack")
  · spiceLevel, vegetarian, vegan, glutenFree, dairyFree, organic, highProtein, lowSugar, healthy → narrow / filter the catalog space
   budget → keep the requirement list tight; avoid premium-tier items
  · babyAgeMonths / ageGroup → restrict to age-appropriate variants
  · includeX / excludeX (booleans) → add or omit the named requirement family
- If a parameter is unknown to you, use it in spirit (e.g. as a hint or filter) — never error on unknown keys.
- When taste/diet/health parameters are set on a vague mission query, prefer 2-4 SPECIFIC essentials over 1 generic essential.
  Example: query="evening snacks", parameters={taste:"sweet", healthy:true}
    → essentials:
         Fresh Fruit       (hints="Fresh Fruits", nameMatch="fruit"),
         Yogurt            (hints="Yogurt & Shrikhand", nameMatch="yogurt, curd"),
         Nuts & Dry Fruits (hints="Dry Fruits & Nuts", nameMatch="almond, cashew, dates"),
         Granola / Muesli  (hints="Muesli, Granola & Cereals", nameMatch="granola, muesli, oats")
    NOT a single "evening snacks" essential pointing at "Chips & Crisps".
- The 'quantity' field on each requirement is a SHORT human-readable phrase ("for 5 people", "2 packs", "500g", "1 kg"). Use empty string only when no scaling info is reasonable.
- ALWAYS populate 'nameMatch' with 1-3 lowercase keywords that uniquely identify the requirement in product names. The resolver uses these for exact-name matching (Tier 1). A bare subcategory (no nameMatch) drops you to Tier 3 and costs accuracy.

PRIORITY FIELD:
- 'required' for items that MUST be in the cart for the goal to succeed.
- 'recommended' for items that improve the experience.
- 'optional' for nice-to-haves (mostly used in premium).
- 'substitutable' when an essential has well-known alternatives (Pav → Bread Roll / Burger Bun).

Always include 'missionSlug' (use known slug if matched, snake_case otherwise; '' for product/brand/ingredient queries).
Set 'confidence' on 0..1 reflecting your certainty in the requirements.

KNOWN MISSION/DISH SLUGS (re-use exactly when matched):
${knownEntries || "(none)"}

TOP BRANDS:
${topBrands}

AVAILABLE SUB-CATEGORIES (use exact strings in 'hints'):
${subcatList}
`.trim();

export async function plan(
  cls: ClassifierOutput,
  query: string,
  parameters: CartParameters = {},
): Promise<PlannerOutput> {
  const paramsKey = stableStringify(parameters);
  const cacheKey = paramsKey === "{}" ? cls.queryType : `${cls.queryType}|${paramsKey}`;
  if (cls.confidence >= 0.75) {
    const cached = await getCached<PlannerOutput>(query, cacheKey);
    if (cached) return cached;
  }

  const subcats = await prisma.subCategory.findMany({ select: { name: true } });
  const known = await prisma.missionKB.findMany({
    select: { slug: true, type: true, aliases: true },
  });
  const topBrands = await prisma.brand.findMany({
    orderBy: { brandScore: "desc" },
    take: 25,
    select: { name: true, brandScore: true },
  });

  const out = await llm.generateJSON<PlannerLLMOut>({
    system: SYSTEM(
      query,
      parameters,
      cls,
      subcats.map((s) => s.name).join(", "),
      known.map((k) => `${k.slug} (${k.type}): ${k.aliases.join(", ")}`).join("\n"),
      topBrands.map((b) => `${b.name} (${b.brandScore.toFixed(2)})`).join(", ") ||
        "(none extracted yet)",
    ),
    messages: [
      {
        role: "user",
        content: `Plan the cart for QUERY=${JSON.stringify(query)} with PARAMETERS=${JSON.stringify(parameters ?? {})}. Output the JSON now.`,
      },
    ],
    schema: PLANNER_SCHEMA,
    temperature: 0.3,
  });

  console.log(
    `[planner] raw output: confidence=${out.confidence} slug=${out.missionSlug} ` +
      `essentials=${out.essentials?.length ?? 0} recommended=${out.recommended?.length ?? 0} premium=${out.premium?.length ?? 0}`,
  );
  if ((out.essentials?.length ?? 0) > 0) {
    console.log(`[planner] essentials raw:`, JSON.stringify(out.essentials));
  }
  if ((out.essentials?.length ?? 0) === 0) {
    console.log(`[planner] empty output for query=${JSON.stringify(query)} — full payload:`, JSON.stringify(out));
  }

  const result: PlannerOutput = {
    queryType: cls.queryType,
    confidence: Math.max(0, Math.min(1, out.confidence ?? cls.confidence)),
    missionSlug: out.missionSlug || null,
    requirements: {
      essentials: (out.essentials ?? []).map(normalizeRequirement).filter(isUsableRequirement),
      recommended: (out.recommended ?? []).map(normalizeRequirement).filter(isUsableRequirement),
      premium: (out.premium ?? []).map(normalizeRequirement).filter(isUsableRequirement),
    },
  };

  await setCached(query, cacheKey, result);
  return result;
}

/** Fill in defaults for fields the LLM may have omitted. */
function normalizeRequirement(r: unknown): Requirement {
  const o = (r ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const priority: Requirement["priority"] =
    o.priority === "recommended" || o.priority === "optional" || o.priority === "substitutable"
      ? o.priority
      : "required";
  const hints = parseStringList(o.hints);
  const nameMatch = parseStringList(o.nameMatch).map((s) => s.toLowerCase());
  const brand = typeof o.brand === "string" && o.brand.trim() ? o.brand.trim() : undefined;
  const quantity = typeof o.quantity === "string" && o.quantity.trim() ? o.quantity.trim() : undefined;

  // Pick a resolver shape from the populated fields:
  //   nameMatch + brand → exact_product (rare in mission/dish output)
  //   brand only        → brand
  //   nameMatch + hints → name (the v3.5 "tier-1 with sub-cat fence")
  //   hints only        → subcategory
  const type: Requirement["type"] = brand
    ? (nameMatch.length > 0 ? "exact_product" : "brand")
    : nameMatch.length > 0
      ? "name"
      : "subcategory";

  return { type, name, hints, nameMatch, brand, priority, quantity };
}

/** Accept either a real string[] or a comma-separated string. */
function parseStringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Drop requirement stubs the model returned without a usable name. */
function isUsableRequirement(r: Requirement): boolean {
  return r.name.length > 0;
}

/** Stable JSON for cache keys — sorted keys so {a,b} and {b,a} collide. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
