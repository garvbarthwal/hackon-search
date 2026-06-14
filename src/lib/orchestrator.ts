import {
  routeIntent,
  resolveOrGenerateKb,
  type RouterOutput,
  type KbEntry,
  type Requirement,
} from "./router.js";
import { resolveAll, type ResolvedRequirement } from "./resolver.js";
import {
  composeSmartCart,
  computeCoverage,
  retryMissing,
  COVERAGE_THRESHOLD,
  type SmartCart,
  type CoverageReport,
} from "./cart.js";

export type DebugTrace = {
  intentType: string;
  mission: string | null;
  kbSource: "static" | "llm_cached" | "llm_generated" | null;
  requirements: {
    essentials: Requirement[];
    recommended: Requirement[];
    premium: Requirement[];
  };
  resolvedCategories: { requirement: string; resolverPath: string }[];
  retrievedProducts: number;
  selectedProducts: number;
  coverage: number;
  validation: "pass" | "fail" | "partial";
  retried: boolean;
  unfulfilled: string[];
  notes: string[];
};

export type CartResponse = {
  query: string;
  cart: SmartCart;
  coverage: CoverageReport;
  trace: DebugTrace;
};

/**
 * v2 orchestrator: query → router → KB → resolver → coverage → compose.
 *
 * Behavior on coverage miss:
 *   - First pass uses strict resolver (sub-cat hints + nameMatch keywords).
 *   - If coverage < 0.9, retry missing essentials with a broader resolver
 *     (sub-cat hints only, then embedding fallback).
 *   - If still < 0.9, return a partial cart with `unfulfilled` populated.
 */
export async function generateSmartCart(query: string): Promise<CartResponse> {
  const notes: string[] = [];
  const router: RouterOutput = await routeIntent(query);
  notes.push(
    `Router: ${router.intentType}${router.kbSlug ? ` → ${router.kbSlug}` : ""}${router.suggestedSlug ? ` (LLM suggested: ${router.suggestedSlug})` : ""}`,
  );

  // Build requirement set from KB or fallback for category_request / product_search.
  let kb: KbEntry | null = null;
  let kbSource: DebugTrace["kbSource"] = null;

  if (router.intentType === "mission" || router.intentType === "dish") {
    if (router.kbSlug) {
      kb = await resolveOrGenerateKb(router);
      kbSource = "static"; // could be llm_cached if generated previously; load doesn't distinguish well
    } else if (router.suggestedSlug) {
      kb = await resolveOrGenerateKb(router);
      kbSource = "llm_generated";
      if (kb) notes.push(`KB miss — generated and cached entry for slug '${router.suggestedSlug}'`);
    }
  }

  let essentialReqs: Requirement[] = [];
  let recommendedReqs: Requirement[] = [];
  let premiumReqs: Requirement[] = [];

  if (kb) {
    essentialReqs = kb.essentials;
    recommendedReqs = kb.recommended;
    premiumReqs = kb.premium;
  } else if (router.intentType === "category_request") {
    // Treat each named category as an essential.
    essentialReqs = router.requestedCategories.map((c) => ({
      name: c,
      hints: [c],
      nameMatch: [c.toLowerCase()],
    }));
    notes.push(`category_request: treating ${router.requestedCategories.length} named categories as essentials`);
  } else if (router.intentType === "product_search") {
    // Use the query itself as a name-match requirement.
    essentialReqs = [{ name: query, nameMatch: [query.toLowerCase()] }];
    notes.push("product_search: matching by product name");
  } else {
    notes.push(`No KB and intent=${router.intentType} — returning empty cart.`);
  }

  // Resolve all three tiers
  let essentialsResolved = await resolveAll(essentialReqs);
  const recommendedResolved = await resolveAll(recommendedReqs);
  const premiumResolved = await resolveAll(premiumReqs);

  // Coverage check + one retry for missing essentials
  let coverage = computeCoverage(essentialsResolved);
  let retried = false;
  if (coverage.coverage < COVERAGE_THRESHOLD && coverage.unfulfilled.length > 0) {
    notes.push(
      `Coverage ${(coverage.coverage * 100).toFixed(0)}% < ${COVERAGE_THRESHOLD * 100}% — retrying ${coverage.unfulfilled.length} missing: ${coverage.unfulfilled.join(", ")}`,
    );
    essentialsResolved = await retryMissing(essentialsResolved);
    coverage = computeCoverage(essentialsResolved);
    retried = true;
  }

  const validation: DebugTrace["validation"] =
    coverage.coverage >= COVERAGE_THRESHOLD
      ? "pass"
      : coverage.fulfilledEssentials > 0
        ? "partial"
        : "fail";

  const cart = composeSmartCart(essentialsResolved, recommendedResolved, premiumResolved);

  const totalRetrieved =
    essentialsResolved.reduce((a, b) => a + b.candidates.length, 0) +
    recommendedResolved.reduce((a, b) => a + b.candidates.length, 0) +
    premiumResolved.reduce((a, b) => a + b.candidates.length, 0);

  const totalSelected =
    cart.essentials.length + cart.recommended.length + cart.premiumSuggestions.length;

  const trace: DebugTrace = {
    intentType: router.intentType,
    mission: kb?.slug ?? null,
    kbSource,
    requirements: {
      essentials: essentialReqs,
      recommended: recommendedReqs,
      premium: premiumReqs,
    },
    resolvedCategories: essentialsResolved.map((r) => ({
      requirement: r.requirement.name,
      resolverPath: r.resolverPath,
    })),
    retrievedProducts: totalRetrieved,
    selectedProducts: totalSelected,
    coverage: coverage.coverage,
    validation,
    retried,
    unfulfilled: coverage.unfulfilled,
    notes,
  };

  return { query, cart, coverage, trace };
}
