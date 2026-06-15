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
import type { ErrorResponse } from "../lib/types/cart.types.js";

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

cartRouter.post("/plan", async (req: Request, res: Response) => {
  const query = (req.body?.query ?? "").toString().trim();
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
  if (!query) {
    const e = err(req, "invalid_query", "`query` is required and must be non-empty.", 400);
    res.status(e.http).json(e.body);
    return;
  }
  try {
    const out = await cartService.plan({ query, sessionId, includeDebug: wantsDebug(req) });
    res.json(out);
  } catch (e) {
    console.error("[cart-controller] /plan error:", (e as Error).message);
    const r = err(req, "internal_error", (e as Error).message, 500);
    res.status(r.http).json(r.body);
  }
});

cartRouter.post("/chat", async (req: Request, res: Response) => {
  const query = (req.body?.message ?? req.body?.query ?? "").toString().trim();
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
  if (!query) {
    const e = err(req, "invalid_query", "`message` is required and must be non-empty.", 400);
    res.status(e.http).json(e.body);
    return;
  }
  try {
    const out = await cartService.chat({ query, sessionId, includeDebug: wantsDebug(req) });
    res.json(out);
  } catch (e) {
    console.error("[cart-controller] /chat error:", (e as Error).message);
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
