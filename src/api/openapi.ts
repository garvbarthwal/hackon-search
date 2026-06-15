/**
 * OpenAPI 3.0 spec for SmartCart v5.
 *
 * Hand-rolled (not generated). Mirrors the types in `lib/types/cart.types.ts`
 * — when those change, update this file too.
 */
import type { OpenAPIV3 } from "./openapi.types.js";

export const openApiSpec: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "SmartCart API",
    description:
      "Stateless shopping cart engine. Converts a structured `{query, parameters}` " +
      "request into a cart via classifier → planner → resolver → ranker → coverage " +
      "→ auditor. SmartCart never asks questions or manages conversation — the caller " +
      "(web app, mobile, voice, agent) gathers context and passes it in via `parameters`.",
    version: "5.0.0",
  },
  servers: [{ url: "/", description: "Current host" }],
  security: [{ BearerAuth: [] }],
  tags: [
    { name: "cart", description: "Plan endpoint" },
    { name: "system", description: "Health and metadata" },
  ],
  paths: {
    "/v1/health": {
      get: {
        tags: ["system"],
        summary: "Service health probe",
        security: [],
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    version: { type: "string", example: "5.0.0" },
                    uptimeSec: { type: "number" },
                  },
                  required: ["status", "version"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/cart/plan": {
      post: {
        tags: ["cart"],
        summary: "Generate a cart from a query and optional parameters",
        description:
          "Stateless. Always attempts to generate a cart. The caller may pass any " +
          "parameters (`people`, `guestCount`, `tastePreference`, `budget`, " +
          "`vegetarian`, `babyAgeMonths`, `includeFood`, …); they override planner " +
          "defaults and scale quantities. Unknown keys are tolerated and forwarded " +
          "to the planner.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PlanRequest" },
              examples: {
                product: { value: { query: "Maggi" } },
                dish: {
                  value: { query: "Pav Bhaji", parameters: { servings: 6, spiceLevel: "medium" } },
                },
                mission: {
                  value: {
                    query: "movie night snacks",
                    parameters: { people: 5, tastePreference: ["sweet", "savory"] },
                  },
                },
                festival: { value: { query: "Diwali decorations" } },
                babyCare: {
                  value: {
                    query: "baby care products",
                    parameters: { babyAgeMonths: 8, includeFood: true, includeDiapers: true },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/CartResponse" },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/cart/status/{requestId}": {
      get: {
        tags: ["cart"],
        summary: "Replay a stored cart response by requestId",
        parameters: [
          {
            name: "requestId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { $ref: "#/components/responses/CartResponse" },
          "404": { $ref: "#/components/responses/Error" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API key (set SMARTCART_API_KEY on the server)",
      },
    },
    schemas: {
      PlanRequest: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, example: "movie night snacks" },
          parameters: {
            type: "object",
            description:
              "Free-form context the caller has already gathered. Common keys: " +
              "`people`, `guestCount`, `servings`, `tastePreference`, `spiceLevel`, " +
              "`budget`, `vegetarian`, `vegan`, `glutenFree`, `babyAgeMonths`, " +
              "`includeX`, `excludeX`. Unknown keys are tolerated.",
            additionalProperties: true,
            example: { people: 5, tastePreference: ["sweet", "savory"] },
          },
        },
      },
      Requirement: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          priority: {
            type: "string",
            enum: ["required", "recommended", "optional", "substitutable"],
          },
          quantity: { type: "string", description: "Scaled target quantity, when known." },
        },
        required: ["name", "type", "priority"],
      },
      CartItem: {
        type: "object",
        properties: {
          productId: { type: "string" },
          name: { type: "string" },
          image: { type: "string" },
          price: { type: "number" },
          quantity: { type: "string" },
          rating: { type: "number" },
          reviews: { type: "integer" },
          brand: { type: "string", nullable: true },
          subCategory: { type: "string" },
          requirement: { type: "string" },
          resolverPath: { type: "string" },
          substituteFor: { type: "string" },
          substituteReason: { type: "string" },
        },
        required: [
          "productId",
          "name",
          "image",
          "price",
          "quantity",
          "rating",
          "reviews",
          "subCategory",
          "requirement",
          "resolverPath",
        ],
      },
      CartResponse: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          status: {
            type: "string",
            enum: ["success", "partial_success", "failed"],
          },
          queryType: {
            type: "string",
            enum: [
              "product",
              "brand",
              "ingredient",
              "dish",
              "mission",
              "festival",
              "category",
              "unknown",
            ],
          },
          coverage: { type: "number", minimum: 0, maximum: 1 },
          parameters: { type: "object", additionalProperties: true },
          requirements: {
            type: "object",
            properties: {
              essentials: { type: "array", items: { $ref: "#/components/schemas/Requirement" } },
              recommended: { type: "array", items: { $ref: "#/components/schemas/Requirement" } },
              premium: { type: "array", items: { $ref: "#/components/schemas/Requirement" } },
            },
            required: ["essentials", "recommended", "premium"],
          },
          cart: {
            type: "object",
            properties: {
              essentials: { type: "array", items: { $ref: "#/components/schemas/CartItem" } },
              recommended: { type: "array", items: { $ref: "#/components/schemas/CartItem" } },
              premiumSuggestions: { type: "array", items: { $ref: "#/components/schemas/CartItem" } },
            },
            required: ["essentials", "recommended", "premiumSuggestions"],
          },
          audit: {
            type: "object",
            properties: {
              valid: { type: "boolean" },
              removed: {
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
              retries: { type: "integer" },
              summary: { type: "string" },
            },
            required: ["valid", "removed", "retries", "summary"],
          },
          debug: { type: "object", additionalProperties: true },
          timestamp: { type: "string", format: "date-time" },
        },
        required: [
          "requestId",
          "status",
          "queryType",
          "coverage",
          "parameters",
          "requirements",
          "cart",
          "audit",
          "timestamp",
        ],
      },
      ErrorResponse: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          status: { type: "string", enum: ["failed"] },
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            required: ["code", "message"],
          },
          timestamp: { type: "string", format: "date-time" },
        },
        required: ["requestId", "status", "error", "timestamp"],
      },
    },
    responses: {
      CartResponse: {
        description: "A planned cart",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/CartResponse" } },
        },
      },
      Error: {
        description: "Error envelope",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        },
      },
    },
  },
};
