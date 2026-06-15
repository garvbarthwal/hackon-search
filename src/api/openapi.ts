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
      "Conversational shopping cart planner. Converts user intent (product, " +
      "ingredient, dish, mission, or festival) into a structured cart via " +
      "deterministic retrieval over a Requirement Graph.",
    version: "5.0.0",
  },
  servers: [{ url: "/", description: "Current host" }],
  security: [{ BearerAuth: [] }],
  tags: [
    { name: "cart", description: "Plan and chat endpoints" },
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
        summary: "Plan a cart from a single query (stateless)",
        description:
          "Single-shot planner. Does not persist conversation state between " +
          "calls. For multi-turn clarification, use /v1/cart/chat.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PlanRequest" },
              examples: {
                product: { value: { query: "Maggi" } },
                dish: { value: { query: "Pav Bhaji" } },
                festival: { value: { query: "Diwali decorations" } },
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
    "/v1/cart/chat": {
      post: {
        tags: ["cart"],
        summary: "Conversational planner — supports clarification rounds",
        description:
          "Submit a user message. If the planner needs clarification, the " +
          "response has `status='clarification_required'` and a non-empty " +
          "`questions` array. Reply by calling this endpoint again with the " +
          "same `sessionId`. Maximum 2 clarification rounds.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatRequest" },
              examples: {
                start: { value: { message: "movie night" } },
                clarification: {
                  value: { sessionId: "abc-123", message: "4 people, sweet and savoury" },
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
          query: { type: "string", minLength: 1, example: "Maggi" },
          sessionId: { type: "string" },
        },
      },
      ChatRequest: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1 },
          sessionId: { type: "string" },
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
            enum: ["success", "partial_success", "clarification_required", "failed"],
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
          questions: { type: "array", items: { type: "string" } },
          reply: { type: "string" },
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
          sessionId: { type: "string" },
        },
        required: [
          "requestId",
          "status",
          "queryType",
          "coverage",
          "questions",
          "reply",
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
