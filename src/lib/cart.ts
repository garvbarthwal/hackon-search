/**
 * v3.5 Cart Composer.
 *
 * Final cart shape:
 *   - essentials:         all required, deduped across pool
 *   - recommended:        top 2 across recommended requirements
 *   - premiumSuggestions: top 3 by composite premium score (NOT auto-added)
 *
 * Premium score formula uses proxies for fields we don't have:
 *   0.40 * complementary  — high-rated products in OTHER mission sub-cats
 *   0.30 * rating         — base product quality
 *   0.20 * mission_relevance — embedding similarity to mission text (uses cached vec)
 *   0.10 * margin         — price percentile within sub-cat (proxy for margin)
 */
import type { Requirement } from "./planner.js";
import type { RankedProduct, ResolvedRequirement } from "./resolver.js";

export type SmartCartProduct = {
  productId: string;
  name: string;
  image: string;
  price: number;
  quantity: string;
  rating: number;
  reviews: number;
  brand: string | null;
  subCategory: string;
  requirement: string;
  resolverPath: string;
  /** Set when this product was substituted in for an unavailable essential. */
  substituteFor?: string;
  substituteReason?: string;
};

export type SmartCart = {
  essentials: SmartCartProduct[];
  recommended: SmartCartProduct[];
  premiumSuggestions: SmartCartProduct[];
};

function toCartItem(p: RankedProduct, requirementName: string): SmartCartProduct {
  return {
    productId: p.id,
    name: p.name,
    image: p.image,
    price: p.price,
    quantity: p.quantity,
    rating: p.rating,
    reviews: p.reviews,
    brand: p.brand,
    subCategory: p.subCategory,
    requirement: requirementName,
    resolverPath: p.resolverPath,
  };
}

// Compute price-percentile margin proxy per sub-category.
function computeMarginScores(products: RankedProduct[]): Map<string, number> {
  const bySub = new Map<string, RankedProduct[]>();
  for (const p of products) {
    const arr = bySub.get(p.subCategory) ?? [];
    arr.push(p);
    bySub.set(p.subCategory, arr);
  }
  const out = new Map<string, number>();
  for (const arr of bySub.values()) {
    if (arr.length === 1) {
      out.set(arr[0].id, 0.5);
      continue;
    }
    const minP = Math.min(...arr.map((p) => p.price));
    const maxP = Math.max(...arr.map((p) => p.price));
    const span = maxP - minP || 1;
    for (const p of arr) {
      // Higher price → higher margin proxy
      out.set(p.id, (p.price - minP) / span);
    }
  }
  return out;
}

/**
 * Compose the final cart with composer rules + premium scoring proxies.
 *
 * `essentialsResolved` may include substituted entries (the orchestrator
 * applies substitutions before calling us).
 */
export function composeSmartCart(
  essentialsResolved: ResolvedRequirement[],
  recommendedResolved: ResolvedRequirement[],
  premiumResolved: ResolvedRequirement[],
  /** Sub-categories used by essentials — used to compute the "complementary" proxy. */
  essentialSubCats: string[],
): SmartCart {
  const used = new Set<string>();

  function pickFresh(r: ResolvedRequirement): RankedProduct | null {
    for (const p of r.candidates) {
      if (!used.has(p.id)) {
        used.add(p.id);
        return p;
      }
    }
    return null;
  }

  // Essentials: top fresh per requirement.
  const essentials: SmartCartProduct[] = [];
  for (const r of essentialsResolved) {
    const top = pickFresh(r);
    if (top) {
      const item = toCartItem(top, r.requirement.name);
      // Annotate substitute origin if applicable.
      const sub = (r as ResolvedRequirement & { substituteFor?: string; substituteReason?: string });
      if (sub.substituteFor) {
        item.substituteFor = sub.substituteFor;
        item.substituteReason = sub.substituteReason;
      }
      essentials.push(item);
    }
  }

  // Recommended: pick top fresh from each, take 2 best by score.
  const recPool = recommendedResolved
    .map((r) => {
      const top = pickFresh(r);
      return top ? { p: top, reqName: r.requirement.name } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.p.score - a.p.score);
  const recommended: SmartCartProduct[] = recPool
    .slice(0, 2)
    .map((x) => toCartItem(x.p, x.reqName));
  // Release reservations for trimmed picks (they may resurface as premium).
  for (const x of recPool.slice(2)) used.delete(x.p.id);

  // Premium pool: top candidate per premium requirement.
  const premPoolRaw = premiumResolved
    .map((r) => {
      const top = pickFresh(r);
      return top ? { p: top, reqName: r.requirement.name } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Compute margin scores once for the premium pool.
  const margins = computeMarginScores(premPoolRaw.map((x) => x.p));

  // Premium scoring with proxies:
  //   complementary = 1 if sub-cat is NOT in essentialSubCats, 0.5 otherwise
  //   rating        = rating/5
  //   mission_relevance = base resolver score (already weights ratings/popularity/brand)
  //   margin        = computed above
  const essSubSet = new Set(essentialSubCats);
  const scored = premPoolRaw
    .map((x) => {
      const complementary = essSubSet.has(x.p.subCategory) ? 0.5 : 1.0;
      const ratingNorm = Math.max(0, Math.min(1, x.p.rating / 5));
      const missionRelevance = Math.max(0, Math.min(1, x.p.score)); // resolver score is in 0..1.x
      const margin = margins.get(x.p.id) ?? 0.5;
      const composite =
        0.4 * complementary +
        0.3 * ratingNorm +
        0.2 * missionRelevance +
        0.1 * margin;
      return { ...x, composite };
    })
    .sort((a, b) => b.composite - a.composite);

  const premiumSuggestions: SmartCartProduct[] = scored
    .slice(0, 3)
    .map((x) => toCartItem(x.p, x.reqName));

  return { essentials, recommended, premiumSuggestions };
}
