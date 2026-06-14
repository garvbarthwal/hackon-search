import { prisma } from "./db.js";
import { embedOne, generateJSON, toPgVector } from "./gemini.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Intent = {
  occasion: string;
  people: number | null;
  preferences: string[];
  keywords: string[];
};

export type RetrievedCategory = {
  name: string;
  category: string;
  description: string;
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
};

export type ScoredProduct = {
  id: string;
  name: string;
  image: string;
  price: number;
  rating: number;
  reviews: number;
  quantity: string;
  subCategory: string;
  category: string;
  inStock: boolean;
  score: number;
};

export type CartItem = {
  productId: string;
  name: string;
  price: number;
  image: string;
  quantity: string;
  subCategory: string;
  reason: string;
};

export type CartResult = {
  query: string;
  intent: Intent;
  selectedCategories: string[];
  cart: CartItem[];
  removed: { productId: string; name: string; reason: string }[];
  reasoning: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — Intent Extraction
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    occasion: { type: "string" },
    people: { type: "integer" }, // 0 = unspecified (Gemini schema dislikes nullable)
    preferences: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["occasion", "people", "preferences", "keywords"],
};

export async function extractIntent(query: string): Promise<Intent> {
  const prompt = [
    "Extract structured shopping intent from the user's query.",
    "- occasion: short snake_case label (movie_night, baby_care, healthy_breakfast, party, daily_groceries, cleaning, etc.)",
    "- people: integer if specified, 0 if not mentioned.",
    "- preferences: taste/dietary/style hints (savory, sweet, healthy, organic, spicy, vegan, etc.).",
    "- keywords: 4-10 noun phrases describing what to look for in product categories",
    "  (e.g. 'chips', 'cold drinks', 'chocolate', 'diapers', 'baby food', 'milk', 'bread').",
    "  Use shopping-vocabulary terms a customer would type. Expand synonyms (e.g. 'snacks' → ['chips','namkeen','popcorn']).",
    "Do NOT pick specific product brands.",
    "",
    `QUERY: ${JSON.stringify(query)}`,
  ].join("\n");

  const intent = await generateJSON<Intent>(prompt, INTENT_SCHEMA);
  return {
    occasion: intent.occasion ?? "general",
    people: intent.people && intent.people > 0 ? intent.people : null,
    preferences: intent.preferences ?? [],
    keywords: intent.keywords ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — Hybrid Category Retrieval
// ─────────────────────────────────────────────────────────────────────────────

const TOP_CATEGORIES = 8;

export async function retrieveCategories(
  query: string,
  intent: Intent,
): Promise<RetrievedCategory[]> {
  // Build the retrieval text from query + intent — richer than query alone.
  const retrievalText = [
    query,
    intent.occasion.replace(/_/g, " "),
    ...intent.preferences,
    ...intent.keywords,
  ]
    .filter(Boolean)
    .join(". ");

  // 1) vector search over sub-category embeddings
  const queryVec = await embedOne(retrievalText);
  const vecLit = toPgVector(queryVec);

  type VecRow = {
    name: string;
    category: string;
    description: string;
    distance: number;
  };
  const vecRows = await prisma.$queryRawUnsafe<VecRow[]>(
    `
    SELECT name, category, description,
           (embedding <=> $1::vector) AS distance
    FROM "SubCategory"
    ORDER BY embedding <=> $1::vector
    LIMIT 20
    `,
    vecLit,
  );

  // 2) keyword search via pg_trgm similarity over name + description
  const kwTerms = [...intent.keywords, ...intent.preferences, intent.occasion.replace(/_/g, " ")]
    .map((s) => s.trim())
    .filter(Boolean);

  type KwRow = { name: string; sim: number };
  const kwScores = new Map<string, number>();

  if (kwTerms.length > 0) {
    for (const term of kwTerms) {
      const rows = await prisma.$queryRawUnsafe<KwRow[]>(
        `
        SELECT name,
               GREATEST(
                 similarity(name, $1),
                 similarity(description, $1)
               ) AS sim
        FROM "SubCategory"
        WHERE name % $1 OR description % $1
        ORDER BY sim DESC
        LIMIT 10
        `,
        term,
      );
      for (const r of rows) {
        kwScores.set(r.name, Math.max(kwScores.get(r.name) ?? 0, r.sim));
      }
    }
  }

  // 3) merge — convert distance to similarity, blend
  const merged = new Map<string, RetrievedCategory>();
  for (const r of vecRows) {
    const vScore = 1 - r.distance; // cosine distance → similarity
    merged.set(r.name, {
      name: r.name,
      category: r.category,
      description: r.description,
      vectorScore: vScore,
      keywordScore: kwScores.get(r.name) ?? 0,
      hybridScore: 0,
    });
  }
  for (const [name, kw] of kwScores) {
    if (!merged.has(name)) {
      merged.set(name, {
        name,
        category: "",
        description: "",
        vectorScore: 0,
        keywordScore: kw,
        hybridScore: 0,
      });
    }
  }

  // backfill missing description/category from DB
  const missing = [...merged.values()].filter((m) => !m.description);
  if (missing.length > 0) {
    const rows = await prisma.subCategory.findMany({
      where: { name: { in: missing.map((m) => m.name) } },
    });
    for (const row of rows) {
      const m = merged.get(row.name);
      if (m) {
        m.category = row.category;
        m.description = row.description;
      }
    }
  }

  // Hybrid score: 0.7 * vector + 0.3 * keyword. pg_trgm sims tend to be small,
  // so we don't normalize — just blend.
  for (const m of merged.values()) {
    m.hybridScore = 0.7 * m.vectorScore + 0.3 * m.keywordScore;
  }

  return [...merged.values()]
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, TOP_CATEGORIES);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 + 5 — Candidate retrieval + ranking, per sub-category
// ─────────────────────────────────────────────────────────────────────────────

const TOP_PER_CATEGORY = 8;

export async function rankedCandidatesPerCategory(
  subCategories: string[],
): Promise<Map<string, ScoredProduct[]>> {
  if (subCategories.length === 0) return new Map();

  const products = await prisma.product.findMany({
    where: {
      subCategory: { in: subCategories },
      inStock: true,
    },
  });

  // Compute global stats for normalization (per sub-category for value-for-money).
  const maxReviewsBySub = new Map<string, number>();
  const maxPriceBySub = new Map<string, number>();
  const minPriceBySub = new Map<string, number>();
  for (const p of products) {
    maxReviewsBySub.set(p.subCategory, Math.max(maxReviewsBySub.get(p.subCategory) ?? 0, p.reviews));
    maxPriceBySub.set(p.subCategory, Math.max(maxPriceBySub.get(p.subCategory) ?? 0, p.price));
    minPriceBySub.set(p.subCategory, Math.min(minPriceBySub.get(p.subCategory) ?? Infinity, p.price));
  }
  const globalMaxReviews = Math.max(...products.map((p) => p.reviews), 1);

  const grouped = new Map<string, ScoredProduct[]>();
  for (const p of products) {
    const ratingScore = Math.max(0, Math.min(1, p.rating / 5)); // 0..1

    // log-normalized review count (reviews dataset is heavy-tailed; log smooths)
    const reviewScore =
      Math.log1p(p.reviews) / Math.log1p(Math.max(maxReviewsBySub.get(p.subCategory) ?? 1, 1));

    // popularity = global review percentile (separate from sub-cat-relative review score)
    const popularityScore = Math.log1p(p.reviews) / Math.log1p(globalMaxReviews);

    // availability — already filtered to inStock, but keep contribution per spec
    const availabilityScore = p.inStock ? 1 : 0;

    // value-for-money: cheaper relative to its sub-category = higher
    const minP = minPriceBySub.get(p.subCategory) ?? p.price;
    const maxP = maxPriceBySub.get(p.subCategory) ?? p.price;
    const valueForMoneyScore =
      maxP === minP ? 0.5 : 1 - (p.price - minP) / (maxP - minP);

    const score =
      0.35 * ratingScore +
      0.25 * reviewScore +
      0.15 * popularityScore +
      0.15 * availabilityScore +
      0.1 * valueForMoneyScore;

    const arr = grouped.get(p.subCategory) ?? [];
    arr.push({ ...p, score });
    grouped.set(p.subCategory, arr);
  }

  for (const [k, arr] of grouped) {
    arr.sort((a, b) => b.score - a.score);
    grouped.set(k, arr.slice(0, TOP_PER_CATEGORY));
  }

  return grouped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6 — Cart composition (LLM picks the template AND the products)
// ─────────────────────────────────────────────────────────────────────────────

const COMPOSITION_SCHEMA = {
  type: "object",
  properties: {
    template: {
      type: "array",
      description: "Per-sub-category counts for this query",
      items: {
        type: "object",
        properties: {
          subCategory: { type: "string" },
          count: { type: "integer" },
        },
        required: ["subCategory", "count"],
      },
    },
    selections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["productId", "reason"],
      },
    },
    notes: { type: "string" },
  },
  required: ["template", "selections", "notes"],
};

type CompositionOut = {
  template?: { subCategory: string; count: number }[];
  selections: { productId: string; reason: string }[];
  notes?: string;
};

export async function composeCart(
  query: string,
  intent: Intent,
  candidates: Map<string, ScoredProduct[]>,
): Promise<{ items: CartItem[]; template: { subCategory: string; count: number }[]; notes: string }> {
  // Flatten candidates into a compact menu for the LLM.
  const menu: Record<string, { id: string; name: string; price: number; rating: number; quantity: string }[]> = {};
  for (const [sub, arr] of candidates) {
    menu[sub] = arr.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      rating: p.rating,
      quantity: p.quantity,
    }));
  }

  const prompt = [
    "You are a shopping cart composer. The user gave you a shopping intent.",
    "You have been given a MENU of in-stock, top-ranked products grouped by sub-category.",
    "",
    "Your job:",
    "1. Decide a CART TEMPLATE: how many items per sub-category make sense for this intent.",
    "   - Scale by people count if relevant.",
    "   - Cover all aspects of the intent (e.g. 'savory AND sweet' → both).",
    "   - Drop sub-categories that don't actually fit the intent (e.g. for movie night, drop 'Atta', 'Diapers').",
    "   - Total cart size should be reasonable (typically 4–10 items unless people count justifies more).",
    "2. For each slot in the template, PICK specific productId values from the menu.",
    "   - Prefer higher-ranked, well-rated products.",
    "   - Diversify within a sub-category (e.g. don't pick two of the same flavor).",
    "   - Each productId must come from the MENU. Do NOT invent IDs.",
    "3. Give a short reason per pick.",
    "",
    `USER QUERY: ${JSON.stringify(query)}`,
    `INTENT: ${JSON.stringify(intent)}`,
    "",
    "MENU (sub-category → in-stock candidates, ranked):",
    JSON.stringify(menu, null, 2),
  ].join("\n");

  const out = await generateJSON<CompositionOut>(prompt, COMPOSITION_SCHEMA);

  // Resolve productIds back to full records — drop hallucinated IDs defensively.
  const byId = new Map<string, ScoredProduct>();
  for (const arr of candidates.values()) for (const p of arr) byId.set(p.id, p);

  const items: CartItem[] = [];
  for (const sel of out.selections ?? []) {
    const p = byId.get(sel.productId);
    if (!p) continue;
    items.push({
      productId: p.id,
      name: p.name,
      price: p.price,
      image: p.image,
      quantity: p.quantity,
      subCategory: p.subCategory,
      reason: sel.reason,
    });
  }

  return { items, template: out.template ?? [], notes: out.notes ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7 — LLM Cart Validator
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATION_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "array", items: { type: "string" } },
    remove: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["productId", "reason"],
      },
    },
    summary: { type: "string" },
  },
  required: ["keep", "remove", "summary"],
};

type ValidationOut = {
  keep: string[];
  remove: { productId: string; reason: string }[];
  summary?: string;
};

export async function validateCart(
  query: string,
  intent: Intent,
  items: CartItem[],
): Promise<{ items: CartItem[]; removed: { productId: string; name: string; reason: string }[]; summary: string }> {
  if (items.length === 0) return { items, removed: [], summary: "Empty cart, nothing to validate." };

  const prompt = [
    "You are a shopping cart validator. Review whether each item fits the user's intent.",
    "REMOVE items that are:",
    "- unrelated to the intent",
    "- accidental retrievals (e.g. groceries-staples in a movie-night cart)",
    "- semantically similar but contextually wrong (e.g. baby shampoo when user asked for adult products)",
    "KEEP items that:",
    "- match the intent and preferences",
    "- contribute to category diversity",
    "Be strict but not aggressive — if an item plausibly belongs, keep it.",
    "",
    `USER QUERY: ${JSON.stringify(query)}`,
    `INTENT: ${JSON.stringify(intent)}`,
    "",
    "CART:",
    JSON.stringify(
      items.map((i) => ({
        productId: i.productId,
        name: i.name,
        subCategory: i.subCategory,
        reason: i.reason,
      })),
      null,
      2,
    ),
    "",
    "Return JSON with productIds to keep and to remove (with reasons).",
  ].join("\n");

  const out = await generateJSON<ValidationOut>(prompt, VALIDATION_SCHEMA);

  const removeIds = new Set(out.remove?.map((r) => r.productId) ?? []);
  const keptItems = items.filter((i) => !removeIds.has(i.productId));
  const removed = (out.remove ?? []).map((r) => {
    const orig = items.find((i) => i.productId === r.productId);
    return {
      productId: r.productId,
      name: orig?.name ?? "(unknown)",
      reason: r.reason,
    };
  });

  return { items: keptItems, removed, summary: out.summary ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function generateCart(query: string): Promise<CartResult> {
  const reasoning: string[] = [];

  const intent = await extractIntent(query);
  reasoning.push(
    `Intent: occasion=${intent.occasion}, people=${intent.people ?? "?"}, prefs=[${intent.preferences.join(", ")}], keywords=[${intent.keywords.join(", ")}]`,
  );

  const cats = await retrieveCategories(query, intent);
  reasoning.push(
    `Selected sub-categories: ${cats.map((c) => `${c.name}(${c.hybridScore.toFixed(2)})`).join(", ")}`,
  );

  const subNames = cats.map((c) => c.name);
  const candidates = await rankedCandidatesPerCategory(subNames);
  const candidateCount = [...candidates.values()].reduce((a, b) => a + b.length, 0);
  reasoning.push(`Ranked ${candidateCount} in-stock candidates across ${candidates.size} sub-categories.`);

  const composition = await composeCart(query, intent, candidates);
  reasoning.push(
    `Composed template: ${JSON.stringify(composition.template)}. Picked ${composition.items.length} items.`,
  );
  if (composition.notes) reasoning.push(`Composer notes: ${composition.notes}`);

  const validated = await validateCart(query, intent, composition.items);
  if (validated.removed.length > 0) {
    reasoning.push(
      `Validator removed ${validated.removed.length}: ${validated.removed.map((r) => r.name).join("; ")}`,
    );
  }
  if (validated.summary) reasoning.push(`Validator: ${validated.summary}`);

  return {
    query,
    intent,
    selectedCategories: subNames,
    cart: validated.items,
    removed: validated.removed,
    reasoning,
  };
}
