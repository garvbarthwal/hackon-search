/**
 * Maps internal pipeline types → frozen v5 CartResponse.
 *
 * The internal `ChatTurnResponse` (orchestrator), `SmartCart` (cart.ts),
 * `PlannerOutput` (planner.ts), and `AuditorVerdict` (auditor.ts) are free to
 * evolve. This file is the single translation layer to the public contract.
 */
import type { ChatTurnResponse } from "./orchestrator.js";
import type {
  CartResponse,
  CartStatus,
  ResponseCart,
  ResponseCartItem,
  ResponseRequirement,
  ResponseAudit,
} from "./types/cart.types.js";
import type { SmartCartProduct, SmartCart } from "./cart.js";
import type { Requirement } from "./planner.js";

function toRespItem(p: SmartCartProduct): ResponseCartItem {
  return {
    productId: p.productId,
    name: p.name,
    image: p.image,
    price: p.price,
    quantity: p.quantity,
    rating: p.rating,
    reviews: p.reviews,
    brand: p.brand,
    subCategory: p.subCategory,
    requirement: p.requirement,
    resolverPath: p.resolverPath,
    ...(p.substituteFor ? { substituteFor: p.substituteFor } : {}),
    ...(p.substituteReason ? { substituteReason: p.substituteReason } : {}),
  };
}

function toRespCart(cart: SmartCart | undefined): ResponseCart {
  if (!cart) return { essentials: [], recommended: [], premiumSuggestions: [] };
  return {
    essentials: cart.essentials.map(toRespItem),
    recommended: cart.recommended.map(toRespItem),
    premiumSuggestions: cart.premiumSuggestions.map(toRespItem),
  };
}

function toRespReq(r: Requirement): ResponseRequirement {
  return { name: r.name, type: r.type, priority: r.priority };
}

/** Decide the public status from the internal turn outcome + coverage. */
function deriveStatus(turn: ChatTurnResponse): CartStatus {
  if (turn.status === "clarifying") return "clarification_required";
  if (turn.status === "needs_user_input") return "partial_success";
  // status === "ready"
  const cov = turn.coverage?.coverage ?? 0;
  if (cov >= 0.9) return "success";
  if (cov > 0) return "partial_success";
  return "failed";
}

export function toCartResponse(args: {
  requestId: string;
  turn: ChatTurnResponse;
  includeDebug: boolean;
  sessionId?: string;
}): CartResponse {
  const { requestId, turn, includeDebug, sessionId } = args;
  const reqs = turn.trace.requirements;
  const audit: ResponseAudit = {
    valid: turn.auditor?.valid ?? true,
    removed: (turn.auditor?.reasons ?? []).map((r) => ({
      productId: r.productId,
      reason: r.reason,
    })),
    retries: turn.trace.retries,
    summary: turn.auditor?.summary ?? "",
  };

  return {
    requestId,
    status: deriveStatus(turn),
    queryType: turn.trace.queryType as CartResponse["queryType"],
    coverage: turn.coverage?.coverage ?? 0,
    questions: turn.questions ?? [],
    reply: turn.reply,
    requirements: {
      essentials: (reqs?.essentials ?? []).map(toRespReq),
      recommended: (reqs?.recommended ?? []).map(toRespReq),
      premium: (reqs?.premium ?? []).map(toRespReq),
    },
    cart: toRespCart(turn.cart),
    audit,
    ...(includeDebug ? { debug: turn.trace as unknown as Record<string, unknown> } : {}),
    timestamp: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
  };
}
