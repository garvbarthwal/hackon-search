/**
 * Stage 2 — Conversational Planner.
 *
 * Takes (history, classifierOutput, userMessage) and produces requirements.
 * Confidence-gated clarification: ask questions only when confidence < 0.75
 * AND essential information is missing. Hard limit: 2 clarification rounds.
 *
 * For non-mission/dish queries (product, brand, ingredient, category), the
 * planner still produces a Requirement[] but with shapes that drive the
 * resolver's tier 1/2/4/3 paths respectively.
 */
import { llm } from "./llm.js";
import { prisma } from "./db.js";
import { getCached, setCached } from "./cache.js";
import type { ClassifierOutput, QueryType } from "./classifier.js";

export type RequirementType = "required" | "recommended" | "optional" | "substitutable";

export type Requirement = {
  /** Required: exact_product, brand, ingredient, subcategory */
  type: "exact_product" | "brand" | "ingredient" | "subcategory" | "name";
  /** Display label / canonical name. */
  name: string;
  /** Sub-category names from the catalog (resolver tier 3). */
  hints?: string[];
  /** Lowercase name keywords (resolver tier 1, used for ingredient/exact_product). */
  nameMatch?: string[];
  /** Brand name (resolver tier 2). */
  brand?: string;
  /** required|recommended|optional|substitutable — drives validator behavior. */
  priority: RequirementType;
  /** Optional planner override of the constraint engine's domain allow-list. */
  allowedDomains?: string[];
};

export type PlannerOutput = {
  status: "clarifying" | "ready";
  queryType: QueryType;
  confidence: number;
  reply: string;
  questions: string[];
  missionSlug: string | null;
  requirements: {
    essentials: Requirement[];
    recommended: Requirement[];
    premium: Requirement[];
  };
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

const CONFIDENCE_THRESHOLD = 0.75;
const MAX_CLARIFICATIONS = 2;

const REQ_SCHEMA = () => ({
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["exact_product", "brand", "ingredient", "subcategory", "name"],
    },
    name: { type: "string" },
    hints: {
      type: "array",
      items: { type: "string" },
      description: "Sub-category names from AVAILABLE list. Empty if none.",
    },
    nameMatch: {
      type: "array",
      items: { type: "string" },
      description: "1-3 lowercase product-name keywords for whole-catalog match.",
    },
    brand: { type: "string", description: "Brand name when type=brand, '' otherwise." },
    priority: {
      type: "string",
      enum: ["required", "recommended", "optional", "substitutable"],
    },
  },
  required: ["type", "name", "hints", "nameMatch", "brand", "priority"],
});

const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["clarifying", "ready"] },
    confidence: { type: "number" },
    reply: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    missionSlug: { type: "string" },
    essentials: { type: "array", items: REQ_SCHEMA() },
    recommended: { type: "array", items: REQ_SCHEMA() },
    premium: { type: "array", items: REQ_SCHEMA() },
  },
  required: [
    "status",
    "confidence",
    "reply",
    "questions",
    "missionSlug",
    "essentials",
    "recommended",
    "premium",
  ],
};

type PlannerLLMOut = {
  status: "clarifying" | "ready";
  confidence: number;
  reply: string;
  questions: string[];
  missionSlug: string;
  essentials: Requirement[];
  recommended: Requirement[];
  premium: Requirement[];
};

const SYSTEM = (
  cls: ClassifierOutput,
  subcatList: string,
  knownEntries: string,
  topBrands: string,
  forceReady: boolean,
) => `
You are a shopping cart planner. The query has been pre-classified:
- queryType: ${cls.queryType}
- classifier confidence: ${cls.confidence.toFixed(2)}
- suggested slug: ${cls.slug ?? "(none)"}
- suggested brand: ${cls.brand ?? "(none)"}
- suggested ingredient: ${cls.ingredient ?? "(none)"}
- suggested categories: ${cls.categories.join(", ") || "(none)"}

Your job: produce a finalized requirement list, OR ask 1-3 short clarifying questions if essential info is missing.

REQUIREMENT SHAPES BY queryType:
- product:    one essential with type='exact_product'. Set nameMatch to 1-3 keywords identifying the product (e.g. "maggi", "oreo"). hints can include the right sub-category.
- brand:      one essential with type='brand'. Set brand to the canonical brand. hints can include the brand's typical sub-categories.
- ingredient: one essential with type='ingredient'. Set nameMatch to the ingredient noun + 1-2 synonyms. hints to relevant sub-cats (e.g. "Fresh Vegetables").
- category:   one essential per named category with type='subcategory'. hints = exact sub-category names from AVAILABLE list.
- dish:       full essentials list — actual ingredients to MAKE the dish. Pav Bhaji needs Pav (not generic bread). Use type='name' for sub-cat + nameMatch combos.
- mission:    full essentials list — items needed to fulfil the goal. Tea party = Tea + Milk + Sugar.
- festival:   full essentials list scoped to the named festival. Diwali = Diyas + Rangoli + Pooja items. Christmas = Tree + Decor. NEVER mix festivals — Diwali requirements never include Christmas keywords. Always set missionSlug to the festival's slug (diwali, christmas, holi, eid, raksha_bandhan).

CLARIFICATION POLICY:
- ${forceReady ? "DO NOT ASK QUESTIONS. Set status='ready' and produce best-effort requirements." : `Set status='clarifying' ONLY if confidence < ${CONFIDENCE_THRESHOLD} AND essential info is missing. Otherwise status='ready'.`}
- Ask AT MOST 3 short questions per turn. Examples for "Movie Night": "How many people?" "Sweet, savory, or both?". DON'T ask if those are already in the message.
- Set 'confidence' on 0..1 reflecting your certainty in the requirements.

PRIORITY FIELD:
- 'required' for items that MUST be in the cart for the goal to succeed.
- 'recommended' for items that improve the experience.
- 'optional' for nice-to-haves (mostly used in premium).
- 'substitutable' when an essential has well-known alternatives (Pav → Bread Roll / Burger Bun).

Always populate 'reply' with a friendly chat message — what you decided or what you need to know.
Always include 'missionSlug' (use known slug if matched, snake_case otherwise; '' for product/brand/ingredient queries).

KNOWN MISSION/DISH SLUGS (re-use exactly when matched):
${knownEntries || "(none)"}

TOP BRANDS:
${topBrands}

AVAILABLE SUB-CATEGORIES (use exact strings in 'hints'):
${subcatList}
`.trim();

export async function plan(
  cls: ClassifierOutput,
  history: ChatMessage[],
  userMessage: string,
): Promise<PlannerOutput> {
  // 1. Cache lookup for ready outputs only — single-turn queries with confidence ≥ threshold.
  if (history.length === 0 && cls.confidence >= CONFIDENCE_THRESHOLD) {
    const cached = await getCached<PlannerOutput>(userMessage, cls.queryType);
    if (cached && cached.status === "ready") return cached;
  }

  const subcats = await prisma.subCategory.findMany({ select: { name: true } });
  const known = await prisma.missionKB.findMany({
    select: { slug: true, type: true, aliases: true },
  });
  const topBrands = await prisma.brand.findMany({
    orderBy: { brandScore: "desc" },
    take: 25,
    select: { name: true, brandScore: true },
  });

  const turnsAsked = history.filter((m) => m.role === "assistant").length;
  const forceReady = turnsAsked >= MAX_CLARIFICATIONS;

  const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];

  const out = await llm.generateJSON<PlannerLLMOut>({
    system: SYSTEM(
      cls,
      subcats.map((s) => s.name).join(", "),
      known.map((k) => `${k.slug} (${k.type}): ${k.aliases.join(", ")}`).join("\n"),
      topBrands.map((b) => `${b.name} (${b.brandScore.toFixed(2)})`).join(", ") ||
        "(none extracted yet)",
      forceReady,
    ),
    messages,
    schema: PLANNER_SCHEMA,
    temperature: 0.3,
  });

  let status = out.status;
  if (forceReady && status === "clarifying") status = "ready";
  if (status === "ready" && (out.essentials?.length ?? 0) === 0 && !forceReady) {
    // Degenerate — re-ask once.
    status = "clarifying";
  }

  const result: PlannerOutput = {
    status,
    queryType: cls.queryType,
    confidence: Math.max(0, Math.min(1, out.confidence ?? cls.confidence)),
    reply: out.reply || (status === "clarifying" ? "Tell me a bit more?" : "Here's what I planned."),
    questions: status === "clarifying" ? (out.questions ?? []).slice(0, 3) : [],
    missionSlug: out.missionSlug || null,
    requirements: {
      essentials: out.essentials ?? [],
      recommended: out.recommended ?? [],
      premium: out.premium ?? [],
    },
  };

  // Cache only single-turn 'ready' outputs.
  if (history.length === 0 && status === "ready") {
    await setCached(userMessage, cls.queryType, result);
  }

  return result;
}

/**
 * Fast path: alias hits to the static KB. Returns null if no match.
 * No LLM call at all when this fires.
 */
export async function aliasFastPath(
  cls: ClassifierOutput,
  history: ChatMessage[],
  userMessage: string,
): Promise<PlannerOutput | null> {
  if (history.length > 0) return null;
  if (cls.queryType !== "mission" && cls.queryType !== "dish" && cls.queryType !== "festival") return null;

  const known = await prisma.missionKB.findMany();
  const q = userMessage.toLowerCase().trim();

  for (const e of known) {
    const match = e.aliases.some((a) => {
      const al = a.toLowerCase();
      return q === al || new RegExp(`\\b${escapeRegex(al)}\\b`).test(q);
    });
    if (match) {
      // Convert old KB shape to v3.5 Requirement shape.
      const adapt = (req: { name: string; hints?: string[]; nameMatch?: string[] }, prio: RequirementType): Requirement => ({
        type: req.nameMatch && req.nameMatch.length > 0 ? "name" : "subcategory",
        name: req.name,
        hints: req.hints ?? [],
        nameMatch: req.nameMatch ?? [],
        priority: prio,
      });
      return {
        status: "ready",
        queryType: e.type as QueryType,
        confidence: 0.95,
        reply: `Got it — planning a ${e.slug.replace(/_/g, " ")} cart.`,
        questions: [],
        missionSlug: e.slug,
        requirements: {
          essentials: (e.essentials as { name: string; hints?: string[]; nameMatch?: string[] }[]).map((r) => adapt(r, "required")),
          recommended: (e.recommended as { name: string; hints?: string[]; nameMatch?: string[] }[]).map((r) => adapt(r, "recommended")),
          premium: (e.premium as { name: string; hints?: string[]; nameMatch?: string[] }[]).map((r) => adapt(r, "optional")),
        },
      };
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
