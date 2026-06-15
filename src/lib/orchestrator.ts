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
import { plan, aliasFastPath, type ChatMessage, type PlannerOutput, type Requirement } from "./planner.js";
import { resolveAll, type ResolvedRequirement } from "./resolver.js";
import { computeCoverage, type CoverageReport, COVERAGE_THRESHOLD } from "./coverage.js";
import { substitute, applySubstitutions, type Substitution } from "./substitution.js";
import { composeSmartCart, type SmartCart } from "./cart.js";
import { audit, type AuditorVerdict } from "./auditor.js";
import { constraintFor, festivalFromSlug, type Constraint } from "./constraints.js";

export type ChatTurnResponse = {
  sessionId: string;
  status: "clarifying" | "ready" | "needs_user_input";
  reply: string;
  questions: string[];
  cart?: SmartCart;
  coverage?: CoverageReport;
  auditor?: AuditorVerdict;
  trace: DebugTrace;
};

export type DebugTrace = {
  queryType: string;
  classifierConfidence: number;
  classifierReasoning: string;
  plannerStatus: string;
  plannerConfidence: number;
  missionSlug: string | null;
  festival: string | null;
  kbHit: boolean;
  aliasFastPath: boolean;
  cachedClassifier: boolean;
  requirements: PlannerOutput["requirements"] | null;
  resolverSteps: { requirement: string; resolverPath: string; candidates: number; constraintFiltered: number }[];
  constraints: { requirement: string; allowed: string[]; blocked: string[]; reason: string }[];
  coverage: number | null;
  unfulfilled: string[];
  substitutions: { requirement: string; picks: { name: string; reason: string }[] }[];
  auditor: AuditorVerdict | null;
  retries: number;
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
        festival: null,
        kbHit: false,
        aliasFastPath: usedAlias,
        cachedClassifier: false,
        requirements: planner.requirements,
        resolverSteps: [],
        constraints: [],
        coverage: null,
        unfulfilled: [],
        substitutions: [],
        auditor: null,
        retries: 0,
        retrievedProducts: 0,
        selectedProducts: 0,
        notes,
      },
    };
  }

  // ── Build per-requirement constraints ──────────────────────────────
  const festival = festivalFromSlug(planner.missionSlug ?? cls.slug);
  const reqs = planner.requirements;
  const buildConstraint = (req: Requirement): Constraint =>
    constraintFor(req, cls.queryType, festival);
  const constraintTrace: DebugTrace["constraints"] = [
    ...reqs.essentials,
    ...reqs.recommended,
    ...reqs.premium,
  ].map((r) => {
    const c = buildConstraint(r);
    return {
      requirement: r.name,
      allowed: c.allowed,
      blocked: c.blocked,
      reason: c.reason,
    };
  });
  if (festival) notes.push(`festival mode: ${festival}`);

  // ── Stage 3: resolve all requirements ──────────────────────────────
  const essentialsResolved = await resolveAll(reqs.essentials, buildConstraint);
  const recommendedResolved = await resolveAll(reqs.recommended, buildConstraint);
  const premiumResolved = await resolveAll(reqs.premium, buildConstraint);

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

  // ── Stage 6: compose + audit + retry ───────────────────────────────
  const banned = new Set<string>();
  let cart!: SmartCart;
  let auditorVerdict: AuditorVerdict = { valid: true, remove: [], reasons: [], summary: "" };
  let retries = 0;
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const stripBanned = (rs: ResolvedRequirement[]): ResolvedRequirement[] =>
      rs.map((r) => ({
        ...r,
        candidates: r.candidates.filter((c) => !banned.has(c.id)),
      }));

    const ess = stripBanned(augmentedEssentials);
    const rec = stripBanned(recommendedResolved);
    const prem = stripBanned(premiumResolved);

    const essentialSubCats = ess
      .flatMap((r) => r.candidates.slice(0, 1).map((p) => p.subCategory))
      .filter(Boolean);

    cart = composeSmartCart(ess, rec, prem, essentialSubCats);

    const auditInput = {
      query: message,
      queryType: cls.queryType,
      missionSlug: planner.missionSlug,
      requirements: reqs,
      cart: {
        essentials: cart.essentials.map((p) => ({
          productId: p.productId, name: p.name, requirement: p.requirement,
          subCategory: p.subCategory, brand: p.brand,
        })),
        recommended: cart.recommended.map((p) => ({
          productId: p.productId, name: p.name, requirement: p.requirement,
          subCategory: p.subCategory, brand: p.brand,
        })),
        premiumSuggestions: cart.premiumSuggestions.map((p) => ({
          productId: p.productId, name: p.name, requirement: p.requirement,
          subCategory: p.subCategory, brand: p.brand,
        })),
      },
    };
    auditorVerdict = await audit(auditInput);

    if (auditorVerdict.valid || auditorVerdict.remove.length === 0) {
      notes.push(
        `auditor: pass ${attempt === 0 ? "(first pass)" : `(after ${attempt} retries)`}`,
      );
      break;
    }

    notes.push(
      `auditor: removed ${auditorVerdict.remove.length} — ${auditorVerdict.summary.slice(0, 80)}`,
    );

    if (attempt === MAX_RETRIES) {
      notes.push(`auditor: max retries reached, returning best-effort cart`);
      break;
    }

    for (const id of auditorVerdict.remove) banned.add(id);
    retries = attempt + 1;
  }

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
    festival,
    kbHit: false,
    aliasFastPath: usedAlias,
    cachedClassifier: false,
    requirements: planner.requirements,
    resolverSteps: [
      ...augmentedEssentials.map((r) => ({
        requirement: r.requirement.name,
        resolverPath: r.resolverPath,
        candidates: r.candidates.length,
        constraintFiltered: r.constraintFiltered ?? 0,
      })),
      ...recommendedResolved.map((r) => ({
        requirement: `[recommended] ${r.requirement.name}`,
        resolverPath: r.resolverPath,
        candidates: r.candidates.length,
        constraintFiltered: r.constraintFiltered ?? 0,
      })),
      ...premiumResolved.map((r) => ({
        requirement: `[premium] ${r.requirement.name}`,
        resolverPath: r.resolverPath,
        candidates: r.candidates.length,
        constraintFiltered: r.constraintFiltered ?? 0,
      })),
    ],
    constraints: constraintTrace,
    coverage: coverage.coverage,
    unfulfilled: coverage.unfulfilled.map((u) => u.name),
    substitutions: substitutions.map((s) => ({
      requirement: s.requirement,
      picks: s.picks.map((p) => ({ name: p.product.name, reason: p.reason })),
    })),
    auditor: auditorVerdict,
    retries,
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
    auditor: auditorVerdict,
    trace,
  };
}
