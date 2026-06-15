/**
 * v5 stateless response envelope.
 *
 * SmartCart is a pure cart-generation engine. It owns planning, retrieval,
 * validation and cart composition only. Conversation/clarification is the
 * caller's responsibility — the frontend gathers context, then sends a
 * structured `{ query, parameters }` request and receives a cart back.
 *
 * `cart`, `requirements`, and `audit` are the FROZEN public shapes — they are
 * NOT the same as the internal `SmartCart` / `PlannerOutput` /
 * `AuditorVerdict` types. The mapper in `responseMapper.ts` performs the
 * translation; if internal types change, the mapper is the only file that
 * needs to change.
 */

export type CartStatus = "success" | "partial_success" | "failed";

export type CartQueryType =
  | "product"
  | "brand"
  | "ingredient"
  | "dish"
  | "mission"
  | "festival"
  | "category"
  | "unknown";

/** Caller-supplied context. Arbitrary keys allowed — planner reads what it needs. */
export type CartParameters = Record<string, unknown>;

export type CartRequest = {
  query: string;
  parameters?: CartParameters;
};

/** A single requirement as it appears in the public response. */
export type ResponseRequirement = {
  name: string;
  type: string;
  priority: "required" | "recommended" | "optional" | "substitutable";
  /** Caller-readable target quantity (e.g. "2 packs", "500g", "for 5 people"). */
  quantity?: string;
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
  /** Echo of caller-supplied parameters (so the response is self-describing). */
  parameters: CartParameters;
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
