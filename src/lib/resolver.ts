import { prisma } from "./db.js";
import { embedOne, toPgVector } from "./gemini.js";
import type { Requirement } from "./router.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RankedProduct = {
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
  resolverPath: ResolverPath;
};

export type ResolverPath =
  | "exact_subcategory"
  | "exact_category"
  | "trigram_subcategory"
  | "name_match"
  | "embedding_fallback"
  | "none";

export type ResolvedRequirement = {
  requirement: Requirement;
  candidates: RankedProduct[];
  resolverPath: ResolverPath;
};

// ─────────────────────────────────────────────────────────────────────────────
// Ranking — v2 spec: 0.40 rating + 0.35 review + 0.25 popularity
// ─────────────────────────────────────────────────────────────────────────────

type RawProduct = {
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
};

function rankProducts(products: RawProduct[], path: ResolverPath): RankedProduct[] {
  if (products.length === 0) return [];
  const maxReviews = Math.max(...products.map((p) => p.reviews), 1);
  // Popularity proxy = log-percentile of reviews (skewed distribution).
  const logMaxReviews = Math.log1p(maxReviews);

  return products
    .map((p) => {
      const ratingScore = Math.max(0, Math.min(1, p.rating / 5));
      const reviewScore = Math.log1p(p.reviews) / logMaxReviews;
      const popularityScore = reviewScore; // same signal as review pct here; keeps formula honest
      const score = 0.4 * ratingScore + 0.35 * reviewScore + 0.25 * popularityScore;
      return { ...p, score, resolverPath: path };
    })
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver chain — for ONE requirement
// ─────────────────────────────────────────────────────────────────────────────

const TOP_CANDIDATES = 8;

export async function resolveRequirement(
  req: Requirement,
): Promise<ResolvedRequirement> {
  const hasName = !!(req.nameMatch && req.nameMatch.length > 0);
  const hasHints = !!(req.hints && req.hints.length > 0);

  // Step 1: hints + nameMatch (most specific).
  if (hasHints) {
    const where: Record<string, unknown> = {
      subCategory: { in: req.hints },
      inStock: true,
    };
    if (hasName) {
      where.OR = req.nameMatch!.map((kw) => ({
        name: { contains: kw, mode: "insensitive" },
      }));
    }
    const products = await prisma.product.findMany({ where, take: 100 });
    if (products.length > 0) {
      return {
        requirement: req,
        candidates: rankProducts(products, "exact_subcategory").slice(0, TOP_CANDIDATES),
        resolverPath: "exact_subcategory",
      };
    }
    // Hints were given but found nothing — even with name relaxation. Don't drift
    // outside the named neighborhood (that's how "Lemon" became "Detergent").
    // Caller can call resolveBroader if it wants to widen.
    return { requirement: req, candidates: [], resolverPath: "none" };
  }

  // No hints. If only nameMatch is given, do whole-catalog name match.
  if (hasName) {
    const products = await prisma.product.findMany({
      where: {
        inStock: true,
        OR: req.nameMatch!.map((kw) => ({
          name: { contains: kw, mode: "insensitive" },
        })),
      },
      take: 100,
    });
    // Diaper hard filter: exclude adult/elderly diapers when looking for "Diapers"
    // (the v2 spec calls this out as a failure mode in Example 3).
    let filtered = products;
    if (req.name.toLowerCase().includes("diaper")) {
      filtered = products.filter((p) => !/adult|elderly|incontinence/i.test(p.name));
    }
    if (filtered.length > 0) {
      return {
        requirement: req,
        candidates: rankProducts(filtered, "name_match").slice(0, TOP_CANDIDATES),
        resolverPath: "name_match",
      };
    }
    // nameMatch was the only signal and missed — item isn't in the catalog.
    // Do not fall to embedding (would substitute Ghee for Diapers).
    return { requirement: req, candidates: [], resolverPath: "none" };
  }

  // Neither hints nor nameMatch. Use trigram on sub-cat name, then embedding.

  // Step 3: trigram match on sub-category name (synonym-ish).
  type Row = { name: string };
  const trigramRows = await prisma.$queryRaw<Row[]>`
    SELECT name FROM "SubCategory"
    WHERE name % ${req.name}
    ORDER BY similarity(name, ${req.name}) DESC
    LIMIT 3
  `;
  if (trigramRows.length > 0) {
    const subs = trigramRows.map((r) => r.name);
    const products = await prisma.product.findMany({
      where: { subCategory: { in: subs }, inStock: true },
      take: 100,
    });
    if (products.length > 0) {
      return {
        requirement: req,
        candidates: rankProducts(products, "trigram_subcategory").slice(0, TOP_CANDIDATES),
        resolverPath: "trigram_subcategory",
      };
    }
  }

  // Step 4: embedding fallback — vector search on Product.embedding.
  // This relies on the embedded synthetic text. If embeddings haven't been
  // generated yet, this path returns nothing and we fall through to "none".
  try {
    const queryText = [req.name, ...(req.hints ?? []), ...(req.nameMatch ?? [])]
      .filter(Boolean)
      .join(". ");
    const vec = await embedOne(queryText);
    const vecLit = toPgVector(vec);
    type VecRow = RawProduct & { distance: number };
    const rows = await prisma.$queryRawUnsafe<VecRow[]>(
      `
      SELECT id, name, image, price, rating, reviews, quantity,
             "subCategory", category, "inStock",
             (embedding <=> $1::vector) AS distance
      FROM "Product"
      WHERE embedding IS NOT NULL AND "inStock" = true
      ORDER BY embedding <=> $1::vector
      LIMIT 25
      `,
      vecLit,
    );
    if (rows.length > 0) {
      return {
        requirement: req,
        candidates: rankProducts(rows, "embedding_fallback").slice(0, TOP_CANDIDATES),
        resolverPath: "embedding_fallback",
      };
    }
  } catch {
    // Embedding unavailable / quota — fall through.
  }

  return { requirement: req, candidates: [], resolverPath: "none" };
}

export async function resolveAll(reqs: Requirement[]): Promise<ResolvedRequirement[]> {
  // Resolve sequentially to keep DB load predictable; could parallelize if needed.
  const out: ResolvedRequirement[] = [];
  for (const r of reqs) out.push(await resolveRequirement(r));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-resolve with broader fallback for missing essentials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broaden a requirement that came back empty. We drop nameMatch but KEEP hints
 * so we stay in the right neighborhood — e.g. "Lemon" with hints=Fresh Vegetables
 * will broaden to "any fresh vegetable" but never to detergent.
 *
 * Returns empty if the requirement had no hints to broaden into — in that case
 * there's nothing useful to substitute, and the validator surfaces the gap.
 */
export async function resolveBroader(req: Requirement): Promise<ResolvedRequirement> {
  if (!req.hints || req.hints.length === 0) {
    return { requirement: req, candidates: [], resolverPath: "none" };
  }
  const broadened: Requirement = { name: req.name, hints: req.hints };
  return resolveRequirement(broadened);
}
