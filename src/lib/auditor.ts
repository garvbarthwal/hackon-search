/**
 * LLM Auditor.
 *
 * Runs every turn after cart composition. Checks the composed cart against
 * the original query and the requirement graph for:
 *
 *   1. Domain mismatches the constraint engine missed (always-on safety net)
 *   2. Requirement satisfaction (did each essential get something sensible?)
 *   3. Festival violations (Diwali query, but a Christmas product slipped in)
 *   4. Brand violations (user asked for Maggi, cart has Yippee)
 *   5. Generally irrelevant products
 *
 * The auditor NEVER picks replacements. It only outputs a list of product IDs
 * to remove with reasons. The orchestrator drops those products from each
 * resolved requirement's candidate list and re-composes the cart. Up to 2
 * retries.
 */
import { llm } from "./llm.js";
import type { Requirement } from "./planner.js";
import type { SmartCart } from "./cart.js";
import type { QueryType } from "./classifier.js";

export type AuditorVerdict = {
  valid: boolean;
  /** Cart productIds the auditor wants removed. */
  remove: string[];
  /** Per-product (or per-requirement) reason for removal/concern. */
  reasons: { productId: string; reason: string }[];
  /** Free-form summary for the trace / UI. */
  summary: string;
};

const AUDITOR_SCHEMA = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    remove: {
      type: "array",
      items: { type: "string" },
      description: "productIds to drop from the cart",
    },
    reasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["productId", "reason"],
      },
    },
    summary: { type: "string" },
  },
  required: ["valid", "remove", "reasons", "summary"],
};

const SYSTEM = `You are a strict shopping cart auditor.

Your job: review a proposed cart for the user's query. Identify products that should NOT be in the cart and explain why. You NEVER suggest replacements — only flag removals.

Always reject a product when:
1. Its domain disagrees with the user's intent.
   - Ingredient query (e.g. "Lemon"): a cleaning/personal-care product is wrong.
   - Dish query (e.g. "Pav Bhaji"): a non-edible product is wrong.
   - Festival query (e.g. "Diwali decorations"): a rival festival's product (Christmas, Halloween) is wrong.
2. The product is clearly off-topic for the requirement it's attached to.
3. The user named a brand (e.g. "Maggi") and the product is a different brand (e.g. Yippee). Flag the wrong-brand items so a brand-correct candidate gets the slot.
4. The product appears under "Baby Food" requirement but is actually adult food (Hakka noodles, ramen) — keep only true infant products.

Be strict but not paranoid. Substitutes that are reasonable (Pav → bread bun) should pass.

Output JSON:
- valid: true if the cart is OK as-is, false if anything must be removed.
- remove: array of productIds to drop.
- reasons: matching array — for each productId in 'remove', a one-sentence reason.
- summary: 1-2 sentences for the user/trace.`;

type AuditInput = {
  query: string;
  queryType: QueryType;
  missionSlug: string | null;
  requirements: {
    essentials: Requirement[];
    recommended: Requirement[];
    premium: Requirement[];
  };
  cart: {
    essentials: { productId: string; name: string; requirement: string; subCategory: string; brand: string | null }[];
    recommended: { productId: string; name: string; requirement: string; subCategory: string; brand: string | null }[];
    premiumSuggestions: { productId: string; name: string; requirement: string; subCategory: string; brand: string | null }[];
  };
};

export async function audit(input: AuditInput): Promise<AuditorVerdict> {
  // Empty cart: nothing to audit.
  const total =
    input.cart.essentials.length +
    input.cart.recommended.length +
    input.cart.premiumSuggestions.length;
  if (total === 0) {
    return { valid: true, remove: [], reasons: [], summary: "(empty cart — skipped)" };
  }

  const prompt = [
    `USER QUERY: ${JSON.stringify(input.query)}`,
    `QUERY TYPE: ${input.queryType}`,
    input.missionSlug ? `MISSION SLUG: ${input.missionSlug}` : "",
    "",
    `REQUIREMENTS:`,
    JSON.stringify(input.requirements, null, 2),
    "",
    `PROPOSED CART:`,
    JSON.stringify(input.cart, null, 2),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const out = await llm.generateJSON<AuditorVerdict>({
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      schema: AUDITOR_SCHEMA,
      temperature: 0,
    });
    return {
      valid: !!out.valid && (out.remove?.length ?? 0) === 0,
      remove: out.remove ?? [],
      reasons: out.reasons ?? [],
      summary: out.summary ?? "",
    };
  } catch (err) {
    // If the auditor itself fails, don't block the cart — log and pass through.
    return {
      valid: true,
      remove: [],
      reasons: [],
      summary: `auditor error: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}
