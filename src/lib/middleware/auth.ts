/**
 * Bearer-token auth middleware.
 *
 * Reads SMARTCART_API_KEY from env. Requests must send
 *   Authorization: Bearer <key>
 *
 * If SMARTCART_API_KEY is unset, auth is treated as DISABLED (dev convenience).
 * The middleware logs a warning once at boot and lets all traffic through.
 *
 * Public endpoints (health, docs, openapi.json) bypass this — wire it only
 * onto the /v1/cart/* routes.
 */
import type { Request, Response, NextFunction } from "express";

let warned = false;

export function requireApiKey() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.SMARTCART_API_KEY;
    if (!expected) {
      if (!warned) {
        console.warn("[auth] SMARTCART_API_KEY not set — auth is DISABLED");
        warned = true;
      }
      next();
      return;
    }
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || match[1] !== expected) {
      const requestId = (req as Request & { requestId?: string }).requestId ?? "";
      res.status(401).json({
        requestId,
        status: "failed",
        error: { code: "unauthorized", message: "Missing or invalid API key." },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next();
  };
}
