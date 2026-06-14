/**
 * Conversational planner — Stage 1 of v3.
 *
 * Replaces v2's one-shot router. The planner runs once per turn:
 *   input  = (full conversation history, the user's new message, optional KB hint)
 *   output = { status, reply, questions?, requirements? }
 *
 *   - status="clarifying": ask up to ~3 short questions before committing.
 *     Caller sends `reply` back to the user and waits for the next turn.
 *   - status="ready": requirements are finalized. Caller hands them to the
 *     resolver/composer and presents the cart.
 *
 * Hard limit: at most ONE clarifying turn. After that, the planner MUST go ready
 * with whatever it can infer — keeps casual users from getting interrogated.
 */
import { llm } from "./llm.js";
import { prisma } from "./db.js";
import type { Requirement } from "./router.js";

export type PlannerStatus = "clarifying" | "ready";

export type PlannerOutput = {
  status: PlannerStatus;
  reply: string;
  /** Asked when status="clarifying" (1-3 short questions). */
  questions?: string[];
  /** Final requirements when status="ready". */
  requirements?: {
    essentials: Requirement[];
    recommended: Requirement[];
    premium: Requirement[];
  };
  /** Slug to associate the cart with (mission/dish KB or LLM-suggested). */
  missionSlug: string | null;
  /** Whether the LLM matched a known KB entry. */
  kbHit: boolean;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["clarifying", "ready"] },
    reply: {
      type: "string",
      description: "Short, friendly assistant message shown in the chat UI.",
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "Up to 3 short clarifying questions when status='clarifying'.",
    },
    missionSlug: {
      type: "string",
      description:
        "Slug for the mission/dish ('movie_night', 'pav_bhaji'). Use a known slug if it matches; otherwise pick a snake_case label.",
    },
    essentials: { type: "array", items: REQ_SCHEMA() },
    recommended: { type: "array", items: REQ_SCHEMA() },
    premium: { type: "array", items: REQ_SCHEMA() },
  },
  required: ["status", "reply", "missionSlug", "essentials", "recommended", "premium", "questions"],
};

function REQ_SCHEMA() {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      hints: {
        type: "array",
        items: { type: "string" },
        description: "Sub-category names from the AVAILABLE list. Empty array if none fit.",
      },
      nameMatch: {
        type: "array",
        items: { type: "string" },
        description: "1-3 lowercase product-name keywords for whole-catalog matching.",
      },
    },
    required: ["name", "hints", "nameMatch"],
  };
}

type PlannerLLMOut = {
  status: PlannerStatus;
  reply: string;
  questions: string[];
  missionSlug: string;
  essentials: Requirement[];
  recommended: Requirement[];
  premium: Requirement[];
};

const SYSTEM_PROMPT = (
  subcatList: string,
  knownEntries: string,
  forceReady: boolean,
) => `
You are a shopping cart planner for an Indian quick-commerce app. Help the user assemble a cart for a mission (movie night, party) or a dish (pav bhaji, biryani) by:

1. Understanding their goal from the conversation.
2. ${forceReady ? "DO NOT ask any more questions — go to status='ready' now." : "If the query is detailed enough (occasion clear, party size known if relevant, preferences stated), go straight to status='ready'. If 1-2 quick clarifications would meaningfully improve the cart, ask them — set status='clarifying' and put 1-3 short questions in `questions`. Never ask more than once."}
3. When ready, output three requirement lists:
   - essentials: items the user MUST have. Be strict — only what's truly required.
     Pav Bhaji needs Pav, not generic 'bread'. Tea party needs tea + milk + sugar.
   - recommended: 2-4 items that meaningfully improve the experience.
   - premium: 2-3 nice-to-have upgrades.

For each requirement:
   - name:      short label ("Tea", "Pav", "Diapers")
   - hints:     sub-category names from the AVAILABLE list below where this item lives. Use exact strings. Empty array if no fit.
   - nameMatch: 1-3 lowercase keywords that would identify this product by name.
                Use this for SPECIFIC items where category alone isn't enough (e.g. "pav", "diaper", "biryani masala", "olive").
                Don't add nameMatch for generic categories ("any chips", "any milk").

Always set 'missionSlug' to a known slug if one matches, otherwise a snake_case label.
Always populate 'reply' with a friendly chat message — what you're showing or what you need to know.

KNOWN MISSION/DISH SLUGS (re-use exactly when matched):
${knownEntries || "(none)"}

AVAILABLE SUB-CATEGORIES:
${subcatList}
`.trim();

export async function plan(
  history: ChatMessage[],
  userMessage: string,
): Promise<PlannerOutput> {
  // Pull live vocab for the LLM. Sub-cats grounding stops it inventing categories.
  const subcats = await prisma.subCategory.findMany({ select: { name: true } });
  const subcatList = subcats.map((s) => s.name).join(", ");

  const known = await prisma.missionKB.findMany({
    select: { slug: true, type: true, aliases: true },
  });
  const knownEntries = known
    .map((e) => `${e.slug} (${e.type}): ${e.aliases.join(", ")}`)
    .join("\n");

  // After 1 clarification round, force a ready answer. We've asked enough.
  const askedAlready = history.some((m) => m.role === "assistant");
  const forceReady = askedAlready;

  const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];

  const out = await llm.generateJSON<PlannerLLMOut>({
    system: SYSTEM_PROMPT(subcatList, knownEntries, forceReady),
    messages,
    schema: PLANNER_SCHEMA,
    temperature: 0.3,
  });

  // Defensive: if planner asks again after we forced ready, override to ready.
  let status: PlannerStatus = out.status;
  if (forceReady && status === "clarifying") status = "ready";

  // If ready but no essentials, that's a degenerate output — fall back to clarifying once.
  if (status === "ready" && (!out.essentials || out.essentials.length === 0) && !forceReady) {
    return {
      status: "clarifying",
      reply:
        out.reply ||
        "I want to make sure I get this right — can you tell me a bit more about what you're shopping for?",
      questions: out.questions?.length ? out.questions : ["What's the occasion or dish?"],
      missionSlug: out.missionSlug || null,
      kbHit: false,
    };
  }

  const kbHit = !!out.missionSlug && known.some((e) => e.slug === out.missionSlug);

  if (status === "clarifying") {
    return {
      status,
      reply: out.reply,
      questions: (out.questions ?? []).slice(0, 3),
      missionSlug: out.missionSlug || null,
      kbHit,
    };
  }

  return {
    status: "ready",
    reply: out.reply,
    requirements: {
      essentials: out.essentials ?? [],
      recommended: out.recommended ?? [],
      premium: out.premium ?? [],
    },
    missionSlug: out.missionSlug || null,
    kbHit,
  };
}

/**
 * Optional fast-path: if the latest user message alias-matches a known KB entry
 * AND there's no prior history (so the user obviously typed a known phrase),
 * return the seeded requirements immediately without an LLM call.
 *
 * Returns null when there's no clean match — caller falls through to plan().
 */
export async function aliasFastPath(
  history: ChatMessage[],
  userMessage: string,
): Promise<PlannerOutput | null> {
  if (history.length > 0) return null;

  const known = await prisma.missionKB.findMany();
  const q = userMessage.toLowerCase().trim();

  for (const e of known) {
    for (const alias of e.aliases) {
      const a = alias.toLowerCase();
      if (q === a || new RegExp(`\\b${escapeRegex(a)}\\b`).test(q)) {
        return {
          status: "ready",
          reply: `Got it — planning a ${e.slug.replace(/_/g, " ")} cart for you.`,
          requirements: {
            essentials: e.essentials as unknown as Requirement[],
            recommended: e.recommended as unknown as Requirement[],
            premium: e.premium as unknown as Requirement[],
          },
          missionSlug: e.slug,
          kbHit: true,
        };
      }
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
