/**
 * v3.5 Orchestrator.
 *
 *   query → classifier → planner (alias fast-path) → resolver → coverage
 *         → substitution (if coverage >= 0.9) → composer → final cart
 *
 * Stateful: takes (sessionId, history, message) and returns the next state of
 * the conversation. If the planner asks questions, we return early without
 * resolving — that round-trips through the chat UI.
 */
import { classify } from "./classifier.js";
import { plan, aliasFastPath, type ChatMessage, type PlannerOutput } from "./planner.js";
import { resolveAll, type ResolvedRequirement } from "./resolver.js";
import { computeCoverage, type CoverageReport, COVERAGE_THRESHOLD } from "./coverage.js";
import { substitute, applySubstitutions, type Substitution } from "./substitution.js";
import { composeSmartCart, type SmartCart } from "./cart.js";

export type ChatTurnResponse = {
  sessionId: string;
  status: "clarifying" | "ready" | "needs_user_input";
  reply: string;
  questions: string[];
  cart?: SmartCart;
  coverage?: CoverageReport;
  trace: DebugTrace;
};

export type DebugTrace = {
  queryType: string;
  classifierConfidence: number;
  classifierReasoning: string;
  plannerStatus: string;
  plannerConfidence: number;
  missionSlug: string | null;
  kbHit: boolean;
  aliasFastPath: boolean;
  cachedClassifier: boolean;
  requirements: PlannerOutput["requirements"] | null;
  resolverSteps: { requirement: string; resolverPath: string; candidates: number }[];
  coverage: number | null;
  unfulfilled: string[];
  substitutions: { requirement: string; picks: { name: string; reason: string }[] }[];
  retrievedProducts: number;
  selectedProducts: number;
  notes: string[];
};

/**
 * One turn of the conversation. `history` excludes the current `message`.
 */
export async function processTurn(args: {
  sessionId: string;
  history: ChatMessage[];
  message: string;
}): Promise<ChatTurnResponse> {
  const { sessionId, history, message } = args;
  const notes: string[] = [];

  // ── Stage 1: classify ──────────────────────────────────────────────
  const cls = await classify(message);
  notes.push(
    `classifier: ${cls.queryType} (conf=${cls.confidence.toFixed(2)}) — ${cls.reasoning.slice(0, 80)}`,
  );

  // ── Stage 2: plan (alias fast-path → LLM planner) ──────────────────
  let planner: PlannerOutput | null = await aliasFastPath(cls, history, message);
  let usedAlias = false;
  if (planner) {
    usedAlias = true;
    notes.push(`planner: alias fast-path hit → ${planner.missionSlug}`);
  } else {
    planner = await plan(cls, history, message);
    notes.push(`planner: ${planner.status} (conf=${planner.confidence.toFixed(2)})`);
  }

  // If still clarifying, return — no resolution this turn.
  if (planner.status === "clarifying") {
    return {
      sessionId,
      status: "clarifying",
      reply: planner.reply,
      questions: planner.questions,
      trace: {
        queryType: cls.queryType,
        classifierConfidence: cls.confidence,
        classifierReasoning: cls.reasoning,
        plannerStatus: planner.status,
        plannerConfidence: planner.confidence,
        missionSlug: planner.missionSlug,
        kbHit: false,
        aliasFastPath: usedAlias,
        cachedClassifier: false,
        requirements: planner.requirements,
        resolverSteps: [],
        coverage: null,
        unfulfilled: [],
        substitutions: [],
        retrievedProducts: 0,
        selectedProducts: 0,
        notes,
      },
    };
  }

  // ── Stage 3: resolve all requirements ──────────────────────────────
  const reqs = planner.requirements;
  const essentialsResolved = await resolveAll(reqs.essentials);
  const recommendedResolved = await resolveAll(reqs.recommended);
  const premiumResolved = await resolveAll(reqs.premium);

  // ── Stage 4: coverage ──────────────────────────────────────────────
  let coverage = computeCoverage(essentialsResolved);
  notes.push(
    `coverage: ${(coverage.coverage * 100).toFixed(0)}% (${coverage.fulfilledEssentials}/${coverage.totalEssentials}) → ${coverage.status}`,
  );

  // ── Stage 5: substitution ──────────────────────────────────────────
  const substitutions: Substitution[] = [];
  let augmentedEssentials: ResolvedRequirement[] = essentialsResolved;

  if (coverage.status === "needs_substitution" && coverage.substitutionCandidates.length > 0) {
    for (const cand of coverage.substitutionCandidates) {
      const sub = await substitute(cand);
      if (sub.picks.length > 0) {
        substitutions.push(sub);
        notes.push(
          `substituted ${cand.name} → ${sub.picks.map((p) => p.product.name).join(", ")}`,
        );
      }
    }
    if (substitutions.length > 0) {
      augmentedEssentials = applySubstitutions(essentialsResolved, substitutions);
      coverage = computeCoverage(augmentedEssentials);
    }
  }

  // ── Stage 6: compose ───────────────────────────────────────────────
  const essentialSubCats = augmentedEssentials
    .flatMap((r) => r.candidates.slice(0, 1).map((p) => p.subCategory))
    .filter(Boolean);

  const cart = composeSmartCart(
    augmentedEssentials,
    recommendedResolved,
    premiumResolved,
    essentialSubCats,
  );

  // ── Stage 7: build response ────────────────────────────────────────
  const totalRetrieved =
    augmentedEssentials.reduce((a, b) => a + b.candidates.length, 0) +
    recommendedResolved.reduce((a, b) => a + b.candidates.length, 0) +
    premiumResolved.reduce((a, b) => a + b.candidates.length, 0);

  const totalSelected =
    cart.essentials.length + cart.recommended.length + cart.premiumSuggestions.length;

  const status: ChatTurnResponse["status"] =
    coverage.status === "needs_user_input"
      ? "needs_user_input"
      : "ready";

  let reply = planner.reply;
  if (status === "needs_user_input") {
    reply = `I couldn't find ${coverage.unfulfilled.map((u) => u.name).join(", ")} in stock. Want me to skip those, or are alternatives okay?`;
  } else if (substitutions.length > 0) {
    reply = `${planner.reply} (Substituted: ${substitutions.map((s) => `${s.requirement} → ${s.picks[0]?.product.name}`).join("; ")})`;
  }

  const trace: DebugTrace = {
    queryType: cls.queryType,
    classifierConfidence: cls.confidence,
    classifierReasoning: cls.reasoning,
    plannerStatus: planner.status,
    plannerConfidence: planner.confidence,
    missionSlug: planner.missionSlug,
    kbHit: false,
    aliasFastPath: usedAlias,
    cachedClassifier: false,
    requirements: planner.requirements,
    resolverSteps: [
      ...augmentedEssentials.map((r) => ({
        requirement: r.requirement.name,
        resolverPath: r.resolverPath,
        candidates: r.candidates.length,
      })),
      ...recommendedResolved.map((r) => ({
        requirement: `[recommended] ${r.requirement.name}`,
        resolverPath: r.resolverPath,
        candidates: r.candidates.length,
      })),
      ...premiumResolved.map((r) => ({
        requirement: `[premium] ${r.requirement.name}`,
        resolverPath: r.resolverPath,
        candidates: r.candidates.length,
      })),
    ],
    coverage: coverage.coverage,
    unfulfilled: coverage.unfulfilled.map((u) => u.name),
    substitutions: substitutions.map((s) => ({
      requirement: s.requirement,
      picks: s.picks.map((p) => ({ name: p.product.name, reason: p.reason })),
    })),
    retrievedProducts: totalRetrieved,
    selectedProducts: totalSelected,
    notes,
  };

  return {
    sessionId,
    status,
    reply,
    questions: [],
    cart,
    coverage,
    trace,
  };
}
