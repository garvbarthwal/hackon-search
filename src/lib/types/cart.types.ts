/**
 * v5 frozen response envelope.
 *
 * The shape of `CartResponse` is the SmartCart API contract — every endpoint
 * that returns cart-shaped data must return this. New fields may be ADDED at
 * the end; existing fields must not be renamed or removed without a version
 * bump.
 *
 * `cart`, `requirements`, and `audit` here are the FROZEN public shapes —
 * they are NOT the same as the internal `SmartCart` / `PlannerOutput` /
 * `AuditorVerdict` types. The mapper in `src/api/v5.mapper.ts` performs the
 * translation; if internal types change, the mapper is the only file that
 * needs to change.
 */

export type CartStatus =
  | "success"
  | "partial_success"
  | "clarification_required"
  | "failed";

export type CartQueryType =
  | "product"
  | "brand"
  | "ingredient"
  | "dish"
  | "mission"
  | "festival"
  | "category"
  | "unknown";

export type CartRequest = {
  requestId: string;
  query: string;
  sessionId?: string;
};

/** A single requirement as it appears in the public response. */
export type ResponseRequirement = {
  name: string;
  type: string;
  priority: "required" | "recommended" | "optional" | "substitutable";
};

export type ResponseCartItem = {
  productId: string;
  name: string;
  image: string;
  price: number;
  quantity: string;
  rating: number;
  reviews: number;
  brand: string | null;
  subCategory: string;
  requirement: string;
  resolverPath: string;
  substituteFor?: string;
  substituteReason?: string;
};

export type ResponseCart = {
  essentials: ResponseCartItem[];
  recommended: ResponseCartItem[];
  premiumSuggestions: ResponseCartItem[];
};

export type ResponseAudit = {
  valid: boolean;
  removed: { productId: string; reason: string }[];
  retries: number;
  summary: string;
};

export type CartResponse = {
  requestId: string;
  status: CartStatus;
  queryType: CartQueryType;
  /** 0..1 — fraction of required essentials with a product. */
  coverage: number;
  /** When status='clarification_required', questions are populated. */
  questions: string[];
  /** Friendly chat reply. */
  reply: string;
  requirements: {
    essentials: ResponseRequirement[];
    recommended: ResponseRequirement[];
    premium: ResponseRequirement[];
  };
  cart: ResponseCart;
  audit: ResponseAudit;
  /** Optional debug envelope; only present when ?debug=1 or X-Debug:1. */
  debug?: Record<string, unknown>;
  /** ISO timestamp the response was generated. */
  timestamp: string;
  sessionId?: string;
};

/** Error envelope shared across all v1 endpoints. */
export type ErrorResponse = {
  requestId: string;
  status: "failed";
  error: {
    code: string;
    message: string;
  };
  timestamp: string;
};
