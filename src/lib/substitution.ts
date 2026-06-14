/**
 * Substitution Engine.
 *
 * Runs only when an essential is unfulfilled. Per spec:
 *   - coverage >= 0.90: try substitution (LLM picks from same parent category)
 *   - coverage <  0.90: ask user (handled by orchestrator, not here)
 *
 * For 'substitutable' requirements (e.g. Pav → Bread Roll / Burger Bun),
 * substitution proceeds regardless of coverage. For 'required' items
 * with no clear substitute (Diapers), we don't auto-substitute — the
 * orchestrator surfaces them to the user.
 */
import { llm } from "./llm.js";
import { prisma } from "./db.js";
import type { Requirement } from "./planner.js";
import type { RankedProduct, ResolvedRequirement } from "./resolver.js";

export type Substitution = {
  requirement: string;
  picks: { product: RankedProduct; reason: string }[];
};

const SUBSTITUTION_SCHEMA = {
  type: "object",
  properties: {
    picks: {
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
  required: ["picks", "notes"],
};

type SubLLMOut = {
  picks: { productId: string; reason: string }[];
  notes: string;
};

const HARD_TO_SUBSTITUTE = /diaper|formula|baby food|incontinence/i;

function isSubstitutable(req: Requirement): boolean {
  if (HARD_TO_SUBSTITUTE.test(req.name)) return false;
  return true;
}

/**
 * Find candidate products to substitute the requirement with: products in the
 * same parent category as the requirement's hints. Up to 30 candidates.
 */
async function gatherCandidates(req: Requirement): Promise<RankedProduct[]> {
  if (!req.hints || req.hints.length === 0) return [];
  const subs = await prisma.subCategory.findMany({
    where: { name: { in: req.hints } },
    select: { category: true },
  });
  const cats = [...new Set(subs.map((s) => s.category))];
  if (cats.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { category: { in: cats }, inStock: true },
    take: 30,
    orderBy: [{ rating: "desc" }, { reviews: "desc" }],
  });

  return products.map((p) => ({
    ...p,
    score: 0,
    resolverPath: "category" as const,
    matchBonus: 0,
  }));
}

/**
 * Ask the LLM to pick 1-2 substitutes from the candidate set with reasons.
 * Falls back to top-rated candidates if the LLM call fails.
 */
export async function substitute(req: Requirement): Promise<Substitution> {
  if (!isSubstitutable(req)) {
    return { requirement: req.name, picks: [] };
  }
  const candidates = await gatherCandidates(req);
  if (candidates.length === 0) {
    return { requirement: req.name, picks: [] };
  }

  const menu = candidates.map((p) => ({
    id: p.id,
    name: p.name,
    subCategory: p.subCategory,
    rating: p.rating,
    price: p.price,
  }));

  const prompt = [
    `The user needs '${req.name}' but it's unavailable.`,
    `Pick 1-2 substitutes from the menu below that genuinely replace this item for the user's purpose.`,
    `Be strict — if NOTHING in the menu is a real substitute, return an empty picks array.`,
    `For each pick give a one-line reason.`,
    "",
    `MENU:`,
    JSON.stringify(menu, null, 2),
  ].join("\n");

  let llmOut: SubLLMOut;
  try {
    llmOut = await llm.generateJSON<SubLLMOut>({
      messages: [{ role: "user", content: prompt }],
      schema: SUBSTITUTION_SCHEMA,
      temperature: 0.2,
    });
  } catch {
    // Fallback: empty — better than substituting blindly.
    return { requirement: req.name, picks: [] };
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const picks: Substitution["picks"] = [];
  for (const sel of llmOut.picks ?? []) {
    const c = byId.get(sel.productId);
    if (c) picks.push({ product: c, reason: sel.reason });
  }

  return { requirement: req.name, picks };
}

/**
 * Convert substitutions into ResolvedRequirement entries that the cart composer
 * will treat as if they fulfilled the original requirement.
 */
export function applySubstitutions(
  unfulfilled: ResolvedRequirement[],
  subs: Substitution[],
): ResolvedRequirement[] {
  const subBySlug = new Map(subs.map((s) => [s.requirement, s]));
  return unfulfilled.map((u) => {
    const sub = subBySlug.get(u.requirement.name);
    if (!sub || sub.picks.length === 0) return u;
    return {
      ...u,
      candidates: sub.picks.map((p) => p.product),
      resolverPath: "category" as const,
    };
  });
}
