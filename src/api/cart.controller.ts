/**
 * v5 Cart Controller — HTTP layer.
 *
 * All business logic lives in cartPlanning.service. This file only:
 *   - parses inputs
 *   - validates request shape
 *   - calls the service
 *   - serializes the response
 */
import { Router, type Request, type Response } from "express";
import * as cartService from "../lib/cartPlanning.service.js";
import type { ErrorResponse, CartParameters } from "../lib/types/cart.types.js";

export const cartRouter = Router();

function err(req: Request, code: string, message: string, http: number): { http: number; body: ErrorResponse } {
  return {
    http,
    body: {
      requestId: req.requestId ?? "",
      status: "failed",
      error: { code, message },
      timestamp: new Date().toISOString(),
    },
  };
}

function wantsDebug(req: Request): boolean {
  if (req.query?.debug === "1" || req.query?.debug === "true") return true;
  return req.header("x-debug") === "1";
}

function parseParameters(raw: unknown): CartParameters {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("`parameters` must be a JSON object.");
  }
  return raw as CartParameters;
}

cartRouter.post("/plan", async (req: Request, res: Response) => {
  const query = (req.body?.query ?? "").toString().trim();
  if (!query) {
    const e = err(req, "invalid_query", "`query` is required and must be non-empty.", 400);
    res.status(e.http).json(e.body);
    return;
  }
  let parameters: CartParameters;
  try {
    parameters = parseParameters(req.body?.parameters);
  } catch (e) {
    const r = err(req, "invalid_parameters", (e as Error).message, 400);
    res.status(r.http).json(r.body);
    return;
  }
  try {
    const out = await cartService.plan({ query, parameters, includeDebug: wantsDebug(req) });
    res.json(out);
  } catch (e) {
    console.error("[cart-controller] /plan error:", (e as Error).message);
    const r = err(req, "internal_error", (e as Error).message, 500);
    res.status(r.http).json(r.body);
  }
});

cartRouter.get("/status/:requestId", async (req: Request, res: Response) => {
  const id = String(req.params.requestId ?? "");
  if (!id) {
    const e = err(req, "invalid_request_id", "`requestId` path param is required.", 400);
    res.status(e.http).json(e.body);
    return;
  }
  try {
    const out = await cartService.status(id);
    if (!out) {
      const e = err(req, "not_found", `requestId ${id} not found.`, 404);
      res.status(e.http).json(e.body);
      return;
    }
    res.json(out);
  } catch (e) {
    console.error("[cart-controller] /status error:", (e as Error).message);
    const r = err(req, "internal_error", (e as Error).message, 500);
    res.status(r.http).json(r.body);
  }
});
