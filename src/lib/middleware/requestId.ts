/**
 * Request-ID + structured-log middleware.
 *
 * Mints a UUID per request, attaches it to req.requestId, sets the
 * `X-Request-Id` response header, and emits a one-line JSON log on response
 * finish (path, method, status, latency, requestId).
 *
 * The cart service mints its OWN requestId for /v1/cart/plan and chat (the
 * one that lands in CartRequestLog). They are deliberately distinct — HTTP
 * request ID vs. cart-pipeline request ID.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header("x-request-id");
    const requestId = incoming && incoming.length < 80 ? incoming : randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const t0 = Date.now();
    res.on("finish", () => {
      const log = {
        ts: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        latencyMs: Date.now() - t0,
      };
      console.log(JSON.stringify(log));
    });

    next();
  };
}
