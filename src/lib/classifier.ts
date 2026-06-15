/**
 * Stage 1 — Query Classifier.
 *
 * Classifies the user query into one of:
 *   product | brand | ingredient | dish | mission | category | unknown
 *
 * Single-word queries like "Maggi", "Lemon", "Amul Milk" must NOT silently
 * become missions. Spec failure mode: "Lemon" returning "Unknown".
 *
 * The classifier uses a fast LLM call (one round-trip) and a confidence score.
 * Low confidence is the planner's signal to ask clarifying questions.
 */
import { llm } from "./llm.js";
import { prisma } from "./db.js";
import { getCached, setCached } from "./cache.js";

export type QueryType =
  | "product"
  | "brand"
  | "ingredient"
  | "dish"
  | "mission"
  | "festival"
  | "category"
  | "unknown";

export type ClassifierOutput = {
  queryType: QueryType;
  confidence: number;
  /** Suggested mission/dish slug if queryType is mission|dish (snake_case). */
  slug: string | null;
  /** If queryType=brand, the canonical brand name to look up. */
  brand: string | null;
  /** If queryType=ingredient, the ingredient noun (lowercase). */
  ingredient: string | null;
  /** If queryType=category, candidate sub-category names from the catalog. */
  categories: string[];
  /** Free-form chain-of-thought for debugging. */
  reasoning: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    queryType: {
      type: "string",
      enum: ["product", "brand", "ingredient", "dish", "mission", "festival", "category", "unknown"],
    },
    confidence: { type: "number", description: "0..1 confidence" },
    slug: { type: "string", description: "snake_case slug for dish/mission, '' otherwise" },
    brand: { type: "string", description: "canonical brand name if queryType=brand, '' otherwise" },
    ingredient: {
      type: "string",
      description: "ingredient noun if queryType=ingredient, '' otherwise",
    },
    categories: {
      type: "array",
      items: { type: "string" },
      description: "sub-category names from catalog if queryType=category, [] otherwise",
    },
    reasoning: { type: "string" },
  },
  required: [
    "queryType",
    "confidence",
    "slug",
    "brand",
    "ingredient",
    "categories",
    "reasoning",
  ],
};

const SYSTEM = (subcatList: string, knownSlugs: string, knownBrands: string) =>
  `You classify shopping queries. Map the user's input to ONE queryType:

- product:    a specific named product or brand+product ("Maggi 2-Minute Noodles", "Amul Butter", "Oreo biscuits", "Lay's Magic Masala")
- brand:      just a brand name ("Amul", "Britannia", "Lay's", "Cadbury")
- ingredient: a single edible item, fresh or staple ("Lemon", "Tomato", "Milk", "Paneer", "Onion")
- dish:       a prepared meal/recipe ("Pav Bhaji", "Biryani", "Maggi" — wait, Maggi is a product not a dish; "Dosa", "Paneer Butter Masala")
- mission:    an event/occasion/use-case ("Movie night", "Tea party", "Birthday party", "Hostel starter pack")
- festival:   a specific named festival/religious occasion that has its own decor and food ("Diwali decorations", "Christmas tree", "Holi colors", "Eid sweets", "Rakhi for brother"). Set 'slug' to the festival's slug (diwali, christmas, holi, eid, raksha_bandhan).
- category:   user named one or more product categories ("Baby food and diapers", "Chips and chocolates", "Snacks for the week")
- unknown:    nothing else fits

CRITICAL DISAMBIGUATION RULES:
1. Single short words referring to packaged brands → product (Maggi, Oreo, Bingo, Yippee).
   "Maggi" alone is a PRODUCT query, not a dish.
2. Single fresh-produce / pantry words → ingredient (Lemon, Tomato, Onion, Sugar, Salt, Milk).
   These must NEVER be classified as 'unknown'.
3. Brand alone (no product name after) → brand (Amul, Britannia, Lay's).
4. Festival names with "decoration", "essentials", "supplies", or any festival on its own → festival.
   "Diwali decorations", "Christmas", "Holi", "Eid", "Rakhi" → festival.
5. Multi-word event language without festival name → mission (Movie night, Tea party).
6. Multi-word recipe language → dish (Pav Bhaji, Chicken Biryani).

Confidence scale:
- 1.0 = obvious (single dictionary word, exact known brand)
- 0.85 = clear from context (multi-word but unambiguous)
- 0.7  = inferable but could ask
- <0.7 = genuinely ambiguous, planner should clarify

Always set 'slug' to a snake_case label for dish/mission. Use a known slug from the list below if it matches, otherwise pick a sensible slug.

KNOWN MISSION/DISH SLUGS:
${knownSlugs}

KNOWN BRANDS (top 30 by product count):
${knownBrands}

AVAILABLE SUB-CATEGORIES:
${subcatList}`;

export async function classify(query: string): Promise<ClassifierOutput> {
  // Fast cache hit for repeat queries.
  const cached = await getCached<ClassifierOutput>(query, "_classifier");
  if (cached) return cached;

  const subcats = await prisma.subCategory.findMany({ select: { name: true } });
  const known = await prisma.missionKB.findMany({ select: { slug: true, type: true, aliases: true } });
  const topBrands = await prisma.brand.findMany({
    orderBy: { productCount: "desc" },
    take: 30,
    select: { name: true },
  });

  const knownSlugList = known
    .map((k) => `${k.slug} (${k.type}): ${k.aliases.join(", ")}`)
    .join("\n");
  const brandList = topBrands.map((b) => b.name).join(", ") || "(none extracted yet)";

  const out = await llm.generateJSON<ClassifierOutput>({
    system: SYSTEM(subcats.map((s) => s.name).join(", "), knownSlugList, brandList),
    messages: [{ role: "user", content: `QUERY: ${JSON.stringify(query)}` }],
    schema: SCHEMA,
    temperature: 0,
  });

  // Defense: ingredients should never come back as 'unknown'.
  const result: ClassifierOutput = {
    queryType: out.queryType,
    confidence: Math.max(0, Math.min(1, out.confidence ?? 0.5)),
    slug: out.slug || null,
    brand: out.brand || null,
    ingredient: out.ingredient || null,
    categories: out.categories ?? [],
    reasoning: out.reasoning ?? "",
  };

  await setCached(query, "_classifier", result);
  return result;
}
