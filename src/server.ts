import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import swaggerUi from "swagger-ui-express";
import { cartRouter } from "./api/cart.controller.js";
import { openApiSpec } from "./api/openapi.js";
import { requestIdMiddleware } from "./lib/middleware/requestId.js";
import { requireApiKey } from "./lib/middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(requestIdMiddleware());

// ── Static UI ──────────────────────────────────────────────────────────
app.use(express.static(path.resolve(__dirname, "..", "public")));

// ── Public system endpoints (no auth) ──────────────────────────────────
app.get("/v1/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "5.0.0",
    uptimeSec: Math.floor((Date.now() - startTime) / 1000),
    llmProvider: process.env.LLM_PROVIDER ?? "bedrock",
  });
});

app.get("/v1/openapi.json", (_req, res) => res.json(openApiSpec));
app.use(
  "/v1/docs",
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec as unknown as object, {
    customSiteTitle: "SmartCart API",
    swaggerOptions: { persistAuthorization: true },
  }),
);

// ── v1 cart routes (auth-gated) ────────────────────────────────────────
app.use("/v1/cart", requireApiKey(), cartRouter);

// ── 404 fallback for unknown /v1 paths ─────────────────────────────────
app.use("/v1", (req, res) => {
  res.status(404).json({
    requestId: req.requestId ?? "",
    status: "failed",
    error: { code: "not_found", message: `No route: ${req.method} ${req.originalUrl}` },
    timestamp: new Date().toISOString(),
  });
});

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.log(`[server] SmartCart v5 listening on http://localhost:${port}`);
  console.log(`[server] LLM provider: ${process.env.LLM_PROVIDER ?? "bedrock"}`);
  console.log(`[server] API docs:    http://localhost:${port}/v1/docs`);
  console.log(`[server] OpenAPI:     http://localhost:${port}/v1/openapi.json`);
  console.log(
    `[server] Auth:        ${process.env.SMARTCART_API_KEY ? "enabled (Bearer)" : "DISABLED (set SMARTCART_API_KEY)"}`,
  );
});
