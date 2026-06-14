import { resolveBroader, type RankedProduct, type ResolvedRequirement } from "./resolver.js";
import type { KbEntry, Requirement } from "./router.js";

// ─────────────────────────────────────────────────────────────────────────────
// Coverage validator
// ─────────────────────────────────────────────────────────────────────────────

export const COVERAGE_THRESHOLD = 0.9;

export type CoverageReport = {
  totalEssentials: number;
  fulfilledEssentials: number;
  coverage: number;
  unfulfilled: string[];
};

export function computeCoverage(resolved: ResolvedRequirement[]): CoverageReport {
  const total = resolved.length;
  const fulfilled = resolved.filter((r) => r.candidates.length > 0).length;
  const unfulfilled = resolved
    .filter((r) => r.candidates.length === 0)
    .map((r) => r.requirement.name);
  return {
    totalEssentials: total,
    fulfilledEssentials: fulfilled,
    coverage: total === 0 ? 1 : fulfilled / total,
    unfulfilled,
  };
}

/**
 * One re-attempt for missing essentials, broadening the search.
 * Returns the updated resolved list. Caller computes coverage again.
 */
export async function retryMissing(
  resolved: ResolvedRequirement[],
): Promise<ResolvedRequirement[]> {
  const out: ResolvedRequirement[] = [];
  for (const r of resolved) {
    if (r.candidates.length === 0) {
      out.push(await resolveBroader(r.requirement));
    } else {
      out.push(r);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Cart Composer — v2 final shape
// ─────────────────────────────────────────────────────────────────────────────

export type SmartCartProduct = {
  productId: string;
  name: string;
  image: string;
  price: number;
  quantity: string;
  rating: number;
  reviews: number;
  subCategory: string;
  requirement: string;
  resolverPath: string;
};

export type SmartCart = {
  essentials: SmartCartProduct[];
  recommended: SmartCartProduct[];
  premiumSuggestions: SmartCartProduct[];
};

function pick(resolved: ResolvedRequirement, n = 1): RankedProduct[] {
  return resolved.candidates.slice(0, n);
}

function toCartItem(p: RankedProduct, requirementName: string): SmartCartProduct {
  return {
    productId: p.id,
    name: p.name,
    image: p.image,
    price: p.price,
    quantity: p.quantity,
    rating: p.rating,
    reviews: p.reviews,
    subCategory: p.subCategory,
    requirement: requirementName,
    resolverPath: p.resolverPath,
  };
}

/**
 * Compose the final cart per v2 spec rules:
 *   - ALL essentials (one product each, top-ranked)
 *   - TOP 2 recommended items (best 2 across recommended requirements)
 *   - TOP 3 premium suggestions (NOT auto-added)
 *
 * Dedupes products across all three sections — no productId appears twice.
 */
export function composeSmartCart(
  essentialsResolved: ResolvedRequirement[],
  recommendedResolved: ResolvedRequirement[],
  premiumResolved: ResolvedRequirement[],
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

  // Essentials: 1 per requirement
  const essentials: SmartCartProduct[] = [];
  for (const r of essentialsResolved) {
    const top = pickFresh(r);
    if (top) essentials.push(toCartItem(top, r.requirement.name));
  }

  // Recommended: pick top fresh from each, then take 2 best by score.
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
  // Release reservations for picks that were de-prioritized past slot 2 — they
  // can re-enter the premium pool.
  for (const x of recPool.slice(2)) used.delete(x.p.id);

  // Premium: top 3 by score across premium requirements.
  const premPool = premiumResolved
    .map((r) => {
      const top = pickFresh(r);
      return top ? { p: top, reqName: r.requirement.name } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.p.score - a.p.score);
  const premiumSuggestions: SmartCartProduct[] = premPool
    .slice(0, 3)
    .map((x) => toCartItem(x.p, x.reqName));

  return { essentials, recommended, premiumSuggestions };
}

// Convenience: extract essentials/recommended/premium requirement lists from a KB entry.
export function essentials(kb: KbEntry): Requirement[] {
  return kb.essentials;
}
