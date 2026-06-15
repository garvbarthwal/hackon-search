/**
 * Maps internal pipeline types → frozen v5 CartResponse.
 *
 * The internal `CartPipelineResult`, `SmartCart`, `PlannerOutput`, and
 * `AuditorVerdict` types are free to evolve. This file is the single
 * translation layer to the public contract.
 */
import type { CartPipelineResult } from "./orchestrator.js";
import type {
  CartResponse,
  CartStatus,
  CartParameters,
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
  return {
    name: r.name,
    type: r.type,
    priority: r.priority,
    ...(r.quantity ? { quantity: r.quantity } : {}),
  };
}

/** Decide the public status from the pipeline outcome + coverage. */
function deriveStatus(result: CartPipelineResult): CartStatus {
  const cov = result.coverage?.coverage ?? 0;
  if (result.status === "ready" && cov >= 0.9) return "success";
  if (cov > 0) return "partial_success";
  return "failed";
}

export function toCartResponse(args: {
  requestId: string;
  result: CartPipelineResult;
  parameters: CartParameters;
  includeDebug: boolean;
}): CartResponse {
  const { requestId, result, parameters, includeDebug } = args;
  const reqs = result.trace.requirements;
  const audit: ResponseAudit = {
    valid: result.auditor?.valid ?? true,
    removed: (result.auditor?.reasons ?? []).map((r) => ({
      productId: r.productId,
      reason: r.reason,
    })),
    retries: result.trace.retries,
    summary: result.auditor?.summary ?? "",
  };

  return {
    requestId,
    status: deriveStatus(result),
    queryType: result.trace.queryType as CartResponse["queryType"],
    coverage: result.coverage?.coverage ?? 0,
    parameters,
    requirements: {
      essentials: (reqs?.essentials ?? []).map(toRespReq),
      recommended: (reqs?.recommended ?? []).map(toRespReq),
      premium: (reqs?.premium ?? []).map(toRespReq),
    },
    cart: toRespCart(result.cart),
    audit,
    ...(includeDebug ? { debug: result.trace as unknown as Record<string, unknown> } : {}),
    timestamp: new Date().toISOString(),
  };
}
