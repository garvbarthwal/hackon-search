/**
 * v3.5 Resolver Chain.
 *
 * Strict retrieval priority — embeddings NEVER override exact matches:
 *   1. Exact Product Match     (req.type=exact_product or strong nameMatch hit)
 *   2. Brand Match             (req.type=brand, or product whose brand matches)
 *   3. Exact SubCategory Match (req.hints intersect Product.subCategory)
 *   4. Exact Category Match    (synthesized from sub-cats — broader fallback)
 *   5. Synonym Match           (pg_trgm on sub-category name)
 *   6. Embedding Search        (last resort)
 *
 * Ranking formula (v3.5 spec):
 *   score = 0.30 * rating + 0.25 * reviews + 0.20 * popularity + 0.25 * brandScore
 *   PLUS a bonus for exact product/brand matches.
 */
import { prisma } from "./db.js";
import { embedOne, toPgVector } from "./gemini.js";
import type { Requirement } from "./planner.js";
import { type Constraint, passesConstraint } from "./constraints.js";

export type ResolverPath =
  | "exact_product"
  | "brand"
  | "subcategory"
  | "category"
  | "synonym"
  | "embedding"
  | "none";

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
  brand: string | null;
  domain: string | null;
  inStock: boolean;
  score: number;
  resolverPath: ResolverPath;
  matchBonus: number;
};

export type ResolvedRequirement = {
  requirement: Requirement;
  candidates: RankedProduct[];
  resolverPath: ResolverPath;
  /** Number of candidates the constraint engine filtered out before ranking. */
  constraintFiltered?: number;
};

const TOP_CANDIDATES = 8;

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
  brand: string | null;
  domain: string | null;
  inStock: boolean;
};

const NO_CONSTRAINT: Constraint = {
  allowed: [],
  blocked: [],
  nameInclude: [],
  nameExclude: [],
  reason: "(none)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────

let brandScoreCache: Map<string, number> | null = null;
let brandScoreCachedAt = 0;
const BRAND_CACHE_TTL_MS = 60_000;

async function getBrandScores(): Promise<Map<string, number>> {
  if (brandScoreCache && Date.now() - brandScoreCachedAt < BRAND_CACHE_TTL_MS) {
    return brandScoreCache;
  }
  const rows = await prisma.brand.findMany({ select: { name: true, brandScore: true } });
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.name, r.brandScore);
  brandScoreCache = m;
  brandScoreCachedAt = Date.now();
  return m;
}

async function rankProducts(
  products: RawProduct[],
  path: ResolverPath,
  matchBonusFn: (p: RawProduct) => number = () => 0,
): Promise<RankedProduct[]> {
  if (products.length === 0) return [];
  const brandScores = await getBrandScores();
  const maxReviews = Math.max(...products.map((p) => p.reviews), 1);
  const logMax = Math.log1p(maxReviews);

  return products
    .map((p) => {
      const rating = Math.max(0, Math.min(1, p.rating / 5));
      const review = Math.log1p(p.reviews) / logMax;
      const popularity = review;
      const brandScore = p.brand ? (brandScores.get(p.brand) ?? 0) : 0;
      const base =
        0.3 * rating + 0.25 * review + 0.2 * popularity + 0.25 * brandScore;
      const bonus = matchBonusFn(p);
      return { ...p, score: base + bonus, resolverPath: path, matchBonus: bonus };
    })
    .sort((a, b) => b.score - a.score);
}

/** Filter products through the constraint before ranking. */
function applyConstraint<T extends { name: string; domain: string | null }>(
  products: T[],
  constraint: Constraint,
): { kept: T[]; filtered: number } {
  const empty =
    constraint.allowed.length === 0 &&
    constraint.blocked.length === 0 &&
    !constraint.festival &&
    constraint.nameInclude.length === 0 &&
    constraint.nameExclude.length === 0;
  if (empty) {
    return { kept: products, filtered: 0 };
  }
  const kept = products.filter((p) => passesConstraint(p, constraint));
  return { kept, filtered: products.length - kept.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tier search
// ─────────────────────────────────────────────────────────────────────────────

async function searchExactProduct(
  req: Requirement,
  constraint: Constraint,
): Promise<{ ranked: RankedProduct[]; filtered: number }> {
  const keywords = req.nameMatch ?? [];
  if (keywords.length === 0) return { ranked: [], filtered: 0 };
  const products = await prisma.product.findMany({
    where: {
      inStock: true,
      OR: keywords.map((kw) => ({ name: { contains: kw, mode: "insensitive" as const } })),
    },
    take: 200,
  });

  // Diaper hard filter (carry over from v2 — never substitute adult diapers).
  let filtered: typeof products = req.name.toLowerCase().includes("diaper")
    ? products.filter((p) => !/adult|elderly|incontinence/i.test(p.name))
    : products;

  const constrained = applyConstraint(filtered, constraint);
  filtered = constrained.kept;

  if (filtered.length === 0) return { ranked: [], filtered: constrained.filtered };

  // Match-bonus: full-keyword hit at start of name beats mid-name hit.
  const bonus = (p: RawProduct): number => {
    const n = p.name.toLowerCase();
    let b = 0;
    for (const kw of keywords) {
      const k = kw.toLowerCase();
      if (n.startsWith(k)) b += 0.25;
      else if (n.includes(k)) b += 0.1;
    }
    return b;
  };

  const ranked = await rankProducts(filtered, "exact_product", bonus);
  return { ranked, filtered: constrained.filtered };
}

async function searchBrand(
  brand: string,
  constraint: Constraint,
): Promise<{ ranked: RankedProduct[]; filtered: number }> {
  // Exact brand match first.
  const exact = await prisma.product.findMany({
    where: { brand: { equals: brand, mode: "insensitive" }, inStock: true },
    take: 200,
  });
  if (exact.length > 0) {
    const c = applyConstraint(exact, constraint);
    if (c.kept.length > 0) {
      return { ranked: await rankProducts(c.kept, "brand", () => 0.2), filtered: c.filtered };
    }
  }
  // Trigram match for brand misspellings.
  type Row = RawProduct;
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, name, image, price, rating, reviews, quantity,
           "subCategory", category, brand, domain, "inStock"
    FROM "Product"
    WHERE brand IS NOT NULL AND brand % ${brand}
      AND "inStock" = true
    ORDER BY similarity(brand, ${brand}) DESC
    LIMIT 200
  `;
  if (rows.length > 0) {
    const c = applyConstraint(rows, constraint);
    if (c.kept.length > 0) {
      return { ranked: await rankProducts(c.kept, "brand", () => 0.1), filtered: c.filtered };
    }
    return { ranked: [], filtered: c.filtered };
  }
  return { ranked: [], filtered: 0 };
}

async function searchSubcategory(
  hints: string[],
  constraint: Constraint,
): Promise<{ ranked: RankedProduct[]; filtered: number }> {
  if (hints.length === 0) return { ranked: [], filtered: 0 };
  const products = await prisma.product.findMany({
    where: { subCategory: { in: hints }, inStock: true },
    take: 400,
  });
  if (products.length === 0) return { ranked: [], filtered: 0 };
  const c = applyConstraint(products, constraint);
  if (c.kept.length === 0) return { ranked: [], filtered: c.filtered };
  return { ranked: await rankProducts(c.kept, "subcategory"), filtered: c.filtered };
}

async function searchCategory(
  hints: string[],
  constraint: Constraint,
): Promise<{ ranked: RankedProduct[]; filtered: number }> {
  if (hints.length === 0) return { ranked: [], filtered: 0 };
  // Find parent categories of the hinted sub-categories, then broaden.
  const subs = await prisma.subCategory.findMany({
    where: { name: { in: hints } },
    select: { category: true },
  });
  const cats = [...new Set(subs.map((s) => s.category))];
  if (cats.length === 0) return { ranked: [], filtered: 0 };
  const products = await prisma.product.findMany({
    where: { category: { in: cats }, inStock: true },
    take: 400,
  });
  if (products.length === 0) return { ranked: [], filtered: 0 };
  const c = applyConstraint(products, constraint);
  if (c.kept.length === 0) return { ranked: [], filtered: c.filtered };
  return { ranked: await rankProducts(c.kept, "category"), filtered: c.filtered };
}

async function searchSynonym(
  req: Requirement,
  constraint: Constraint,
): Promise<{ ranked: RankedProduct[]; filtered: number }> {
  const target = req.name;
  type Row = { name: string };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT name FROM "SubCategory"
    WHERE name % ${target}
    ORDER BY similarity(name, ${target}) DESC
    LIMIT 5
  `;
  if (rows.length === 0) return { ranked: [], filtered: 0 };
  const products = await prisma.product.findMany({
    where: { subCategory: { in: rows.map((r) => r.name) }, inStock: true },
    take: 200,
  });
  if (products.length === 0) return { ranked: [], filtered: 0 };
  const c = applyConstraint(products, constraint);
  if (c.kept.length === 0) return { ranked: [], filtered: c.filtered };
  return { ranked: await rankProducts(c.kept, "synonym"), filtered: c.filtered };
}

async function searchEmbedding(
  req: Requirement,
  constraint: Constraint,
): Promise<{ ranked: RankedProduct[]; filtered: number }> {
  try {
    const text = [req.name, ...(req.hints ?? []), ...(req.nameMatch ?? [])]
      .filter(Boolean)
      .join(". ");
    const vec = await embedOne(text);
    const lit = toPgVector(vec);
    type Row = RawProduct & { distance: number };
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `
      SELECT id, name, image, price, rating, reviews, quantity,
             "subCategory", category, brand, domain, "inStock",
             (embedding <=> $1::vector) AS distance
      FROM "Product"
      WHERE embedding IS NOT NULL AND "inStock" = true
      ORDER BY embedding <=> $1::vector
      LIMIT 50
      `,
      lit,
    );
    if (rows.length === 0) return { ranked: [], filtered: 0 };
    const c = applyConstraint(rows, constraint);
    if (c.kept.length === 0) return { ranked: [], filtered: c.filtered };
    return { ranked: await rankProducts(c.kept, "embedding"), filtered: c.filtered };
  } catch {
    // embedding quota / unavailable
  }
  return { ranked: [], filtered: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a single requirement using the strict tier order.
 * The first tier that returns ANY products wins. Lower tiers are not consulted.
 */
export async function resolveRequirement(
  req: Requirement,
  constraint: Constraint = NO_CONSTRAINT,
): Promise<ResolvedRequirement> {
  let totalFiltered = 0;
  // Tier 1: exact_product — only when nameMatch is given AND type is exact_product or name.
  if (
    (req.type === "exact_product" || req.type === "name" || req.type === "ingredient") &&
    req.nameMatch &&
    req.nameMatch.length > 0
  ) {
    // For exact_product, prefer hint-bounded match first (sub-cat AND name).
    if (req.hints && req.hints.length > 0) {
      const products = await prisma.product.findMany({
        where: {
          inStock: true,
          subCategory: { in: req.hints },
          OR: req.nameMatch.map((kw) => ({
            name: { contains: kw, mode: "insensitive" as const },
          })),
        },
        take: 200,
      });
      let filtered: typeof products = req.name.toLowerCase().includes("diaper")
        ? products.filter((p) => !/adult|elderly|incontinence/i.test(p.name))
        : products;
      const c = applyConstraint(filtered, constraint);
      filtered = c.kept;
      totalFiltered += c.filtered;
      if (filtered.length > 0) {
        const ranked = await rankProducts(filtered, "exact_product", (p) => {
          const n = p.name.toLowerCase();
          let b = 0.15;
          for (const kw of req.nameMatch!) {
            if (n.startsWith(kw.toLowerCase())) b += 0.2;
          }
          return b;
        });
        return {
          requirement: req,
          candidates: ranked.slice(0, TOP_CANDIDATES),
          resolverPath: "exact_product",
          constraintFiltered: totalFiltered,
        };
      }
    }

    // Whole-catalog name match.
    const exact = await searchExactProduct(req, constraint);
    totalFiltered += exact.filtered;
    if (exact.ranked.length > 0) {
      return {
        requirement: req,
        candidates: exact.ranked.slice(0, TOP_CANDIDATES),
        resolverPath: "exact_product",
        constraintFiltered: totalFiltered,
      };
    }

    // CRITICAL: when nameMatch was specified and missed, do NOT substitute via
    // category/embedding. Return empty so coverage validator surfaces the gap.
    // This is the v2/v3 invariant: Atta never replaces Pav, Ghee never replaces Diapers.
    return { requirement: req, candidates: [], resolverPath: "none", constraintFiltered: totalFiltered };
  }

  // Tier 2: brand match.
  if (req.type === "brand" && req.brand) {
    const r = await searchBrand(req.brand, constraint);
    totalFiltered += r.filtered;
    if (r.ranked.length > 0) {
      return {
        requirement: req,
        candidates: r.ranked.slice(0, TOP_CANDIDATES),
        resolverPath: "brand",
        constraintFiltered: totalFiltered,
      };
    }
    // Even on miss, don't fall through — brand was the user's specific ask.
    return { requirement: req, candidates: [], resolverPath: "none", constraintFiltered: totalFiltered };
  }

  // Tier 3: exact sub-category match (hint-driven, no nameMatch).
  if (req.hints && req.hints.length > 0) {
    const r = await searchSubcategory(req.hints, constraint);
    totalFiltered += r.filtered;
    if (r.ranked.length > 0) {
      return {
        requirement: req,
        candidates: r.ranked.slice(0, TOP_CANDIDATES),
        resolverPath: "subcategory",
        constraintFiltered: totalFiltered,
      };
    }

    // Tier 4: parent category broaden.
    const cat = await searchCategory(req.hints, constraint);
    totalFiltered += cat.filtered;
    if (cat.ranked.length > 0) {
      return {
        requirement: req,
        candidates: cat.ranked.slice(0, TOP_CANDIDATES),
        resolverPath: "category",
        constraintFiltered: totalFiltered,
      };
    }
  }

  // Tier 5: synonym match on sub-category name.
  const syn = await searchSynonym(req, constraint);
  totalFiltered += syn.filtered;
  if (syn.ranked.length > 0) {
    return {
      requirement: req,
      candidates: syn.ranked.slice(0, TOP_CANDIDATES),
      resolverPath: "synonym",
      constraintFiltered: totalFiltered,
    };
  }

  // Tier 6: embedding fallback.
  const emb = await searchEmbedding(req, constraint);
  totalFiltered += emb.filtered;
  if (emb.ranked.length > 0) {
    return {
      requirement: req,
      candidates: emb.ranked.slice(0, TOP_CANDIDATES),
      resolverPath: "embedding",
      constraintFiltered: totalFiltered,
    };
  }

  return { requirement: req, candidates: [], resolverPath: "none", constraintFiltered: totalFiltered };
}

export async function resolveAll(
  reqs: Requirement[],
  constraintFor: (req: Requirement) => Constraint = () => NO_CONSTRAINT,
): Promise<ResolvedRequirement[]> {
  const out: ResolvedRequirement[] = [];
  for (const r of reqs) out.push(await resolveRequirement(r, constraintFor(r)));
  return out;
}

/**
 * Broaden a requirement that came back empty. Strips nameMatch/brand and uses
 * hints only. Returns empty if there are no hints to broaden into.
 */
export async function resolveBroader(
  req: Requirement,
  constraint: Constraint = NO_CONSTRAINT,
): Promise<ResolvedRequirement> {
  if (!req.hints || req.hints.length === 0) {
    return { requirement: req, candidates: [], resolverPath: "none" };
  }
  return resolveRequirement(
    {
      type: "subcategory",
      name: req.name,
      hints: req.hints,
      priority: req.priority,
    },
    constraint,
  );
}
