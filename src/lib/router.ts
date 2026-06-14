import { prisma } from "./db.js";
import { llm } from "./llm.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type IntentType = "mission" | "dish" | "category_request" | "product_search" | "unknown";

export type Requirement = {
  name: string;
  hints?: string[];
  nameMatch?: string[];
};

export type RouterOutput = {
  intentType: IntentType;
  /** kb slug if matched (mission/dish), else null */
  kbSlug: string | null;
  /** plain-text categories the user explicitly named (category_request) */
  requestedCategories: string[];
  /** raw user query echoed back */
  query: string;
  /** if mission/dish KB miss, the LLM-suggested slug for caching */
  suggestedSlug: string | null;
  /** original LLM rationale for trace */
  reasoning: string;
};

export type KbEntry = {
  slug: string;
  type: "mission" | "dish";
  essentials: Requirement[];
  recommended: Requirement[];
  premium: Requirement[];
  isLlmGenerated: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Intent Router
// ─────────────────────────────────────────────────────────────────────────────

const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    intentType: {
      type: "string",
      enum: ["mission", "dish", "category_request", "product_search", "unknown"],
    },
    matchedSlug: { type: "string" },
    requestedCategories: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" },
  },
  required: ["intentType", "matchedSlug", "requestedCategories", "reasoning"],
};

type RouterLLMOut = {
  intentType: IntentType;
  matchedSlug: string;
  requestedCategories: string[];
  reasoning: string;
};

export async function routeIntent(query: string): Promise<RouterOutput> {
  const knownEntries = await prisma.missionKB.findMany({
    select: { slug: true, type: true, aliases: true },
  });

  // Fast path: alias match against known KB. Avoids LLM call entirely for the common case.
  const querylower = query.toLowerCase().trim();
  for (const e of knownEntries) {
    for (const alias of e.aliases) {
      const a = alias.toLowerCase();
      // Exact alias match OR alias-as-substring with word boundaries.
      if (querylower === a || new RegExp(`\\b${escapeRegex(a)}\\b`).test(querylower)) {
        return {
          intentType: e.type as IntentType,
          kbSlug: e.slug,
          requestedCategories: [],
          query,
          suggestedSlug: null,
          reasoning: `alias hit: '${alias}' → ${e.slug}`,
        };
      }
    }
  }

  // No alias match → use LLM router.
  const knownList = knownEntries
    .map((e) => `${e.slug} (${e.type}): aliases=${e.aliases.join(", ")}`)
    .join("\n");

  const prompt = [
    "Classify the shopping query into one of:",
    "- mission: an event/occasion/use-case (movie night, tea party, exam night).",
    "- dish: a specific dish/meal the user wants to make (pav bhaji, biryani, maggi).",
    "- category_request: user explicitly named one or more product categories (\"baby food and diapers\", \"chips and chocolate\").",
    "- product_search: user named a specific product/brand (\"oreo biscuits\", \"amul butter\").",
    "- unknown: cannot determine.",
    "",
    "If matchedSlug is one of the known slugs below, set matchedSlug to that slug. Otherwise:",
    "- mission/dish: set matchedSlug to a snake_case slug you'd use for it (e.g. 'taco_night'). Caller will generate a KB entry.",
    "- category_request: set matchedSlug to '' and put the explicit categories in requestedCategories.",
    "- product_search/unknown: set matchedSlug to ''.",
    "",
    "KNOWN ENTRIES:",
    knownList,
    "",
    `QUERY: ${JSON.stringify(query)}`,
  ].join("\n");

  const out = await llm.generateJSON<RouterLLMOut>({
    messages: [{ role: "user", content: prompt }],
    schema: ROUTER_SCHEMA,
  });

  // Resolve matchedSlug: LLM-named slug must exist in KB to count as a hit.
  let kbSlug: string | null = null;
  if (out.matchedSlug && knownEntries.some((e) => e.slug === out.matchedSlug)) {
    kbSlug = out.matchedSlug;
  }

  const suggestedSlug =
    !kbSlug && (out.intentType === "mission" || out.intentType === "dish") && out.matchedSlug
      ? out.matchedSlug
      : null;

  return {
    intentType: out.intentType,
    kbSlug,
    requestedCategories: out.requestedCategories ?? [],
    query,
    suggestedSlug,
    reasoning: out.reasoning ?? "",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// KB lookup + LLM generation for misses
// ─────────────────────────────────────────────────────────────────────────────

const KB_GEN_SCHEMA = {
  type: "object",
  properties: {
    essentials: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          hints: { type: "array", items: { type: "string" } },
          nameMatch: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
    },
    recommended: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          hints: { type: "array", items: { type: "string" } },
          nameMatch: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
    },
    premium: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          hints: { type: "array", items: { type: "string" } },
          nameMatch: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
    },
    aliases: { type: "array", items: { type: "string" } },
  },
  required: ["essentials", "recommended", "premium", "aliases"],
};

type KbLLMOut = {
  essentials: Requirement[];
  recommended: Requirement[];
  premium: Requirement[];
  aliases: string[];
};

async function generateKbEntry(
  query: string,
  slug: string,
  type: "mission" | "dish",
): Promise<KbEntry> {
  // Provide the actual sub-category vocabulary so LLM hints land on real categories.
  const subcats = await prisma.subCategory.findMany({ select: { name: true } });
  const subcatList = subcats.map((s) => s.name).join(", ");

  const prompt = [
    `You are building a shopping requirement template for a ${type === "dish" ? "dish" : "mission/occasion"}.`,
    `${type === "dish" ? "DISH" : "MISSION"}: ${query}`,
    `SLUG: ${slug}`,
    "",
    "Output three requirement lists:",
    "- essentials: items the user MUST have to complete this. Be strict — only what's actually mandatory.",
    "  Pav Bhaji needs Pav, not 'bread'. Tea party needs tea + milk + sugar.",
    "- recommended: 2-4 items that meaningfully improve the experience but aren't strictly required.",
    "- premium: 2-3 nice-to-have upgrades.",
    "",
    "For each requirement provide:",
    "- name: short label ('Tea', 'Pav', 'Diapers')",
    "- hints: list of sub-category names from the AVAILABLE LIST below where this item would be found.",
    "         Only use exact strings from that list. Empty array is OK if none match.",
    "- nameMatch: 1-3 product-name keywords (lowercase) that would identify this item if scanning by name.",
    "",
    "Also output 3-5 aliases (free-form phrases users would type for this).",
    "",
    "AVAILABLE SUB-CATEGORIES:",
    subcatList,
  ].join("\n");

  const out = await llm.generateJSON<KbLLMOut>({
    messages: [{ role: "user", content: prompt }],
    schema: KB_GEN_SCHEMA,
  });

  // Persist for next time
  await prisma.missionKB.upsert({
    where: { slug },
    create: {
      slug,
      type,
      aliases: out.aliases ?? [],
      essentials: out.essentials as object,
      recommended: out.recommended as object,
      premium: out.premium as object,
      isLlmGenerated: true,
    },
    update: {
      type,
      aliases: out.aliases ?? [],
      essentials: out.essentials as object,
      recommended: out.recommended as object,
      premium: out.premium as object,
      isLlmGenerated: true,
    },
  });

  return {
    slug,
    type,
    essentials: out.essentials ?? [],
    recommended: out.recommended ?? [],
    premium: out.premium ?? [],
    isLlmGenerated: true,
  };
}

export async function loadKbEntry(slug: string): Promise<KbEntry | null> {
  const row = await prisma.missionKB.findUnique({ where: { slug } });
  if (!row) return null;
  return {
    slug: row.slug,
    type: row.type as "mission" | "dish",
    essentials: row.essentials as unknown as Requirement[],
    recommended: row.recommended as unknown as Requirement[],
    premium: row.premium as unknown as Requirement[],
    isLlmGenerated: row.isLlmGenerated,
  };
}

export async function resolveOrGenerateKb(
  router: RouterOutput,
): Promise<KbEntry | null> {
  if (router.kbSlug) {
    const hit = await loadKbEntry(router.kbSlug);
    if (hit) return hit;
  }
  if (
    router.suggestedSlug &&
    (router.intentType === "mission" || router.intentType === "dish")
  ) {
    return await generateKbEntry(router.query, router.suggestedSlug, router.intentType);
  }
  return null;
}
