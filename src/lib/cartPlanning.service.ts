/**
 * v5 Cart Planning Service.
 *
 * Single entry point for `POST /v1/cart/plan`. The controller has zero
 * business logic — it parses HTTP, calls `plan()` here, and serializes the
 * result.
 *
 * Responsibilities:
 *   - Generate a requestId per call
 *   - Drive the underlying orchestrator pipeline
 *   - Write the final CartResponse to CartRequestLog (request audit)
 *   - Cache the response by requestId for status replay
 */
import { randomUUID } from "node:crypto";
import { processCartRequest } from "./orchestrator.js";
import { toCartResponse } from "./responseMapper.js";
import { prisma } from "./db.js";
import { cacheGet, cacheSet } from "./redis.js";
import type { CartParameters, CartResponse } from "./types/cart.types.js";

const REQUEST_CACHE_TTL = 24 * 60 * 60; // 24h

const requestKey = (id: string) => `request:${id}`;

export type PlanInput = {
  query: string;
  parameters?: CartParameters;
  includeDebug?: boolean;
};

export async function plan(input: PlanInput): Promise<CartResponse> {
  const requestId = randomUUID();
  const t0 = Date.now();
  const parameters = input.parameters ?? {};

  const result = await processCartRequest({ query: input.query, parameters });

  const response = toCartResponse({
    requestId,
    result,
    parameters,
    includeDebug: !!input.includeDebug,
  });

  const latencyMs = Date.now() - t0;

  // Persist + cache. Both are best-effort — never fail the request.
  await Promise.allSettled([
    prisma.cartRequestLog
      .create({
        data: {
          requestId,
          query: input.query,
          queryType: response.queryType,
          status: response.status,
          coverage: response.coverage,
          sessionId: null,
          response: response as object,
          latencyMs,
        },
      })
      .catch((err) => {
        console.error("[cart-service] failed to persist request log:", err.message);
      }),
    cacheSet(requestKey(requestId), response, REQUEST_CACHE_TTL),
  ]);

  console.log(
    `[cart-service] requestId=${requestId} query=${JSON.stringify(input.query).slice(0, 50)} ` +
      `type=${response.queryType} status=${response.status} cov=${response.coverage.toFixed(2)} ` +
      `latency=${latencyMs}ms`,
  );

  return response;
}

/** GET /v1/cart/status/:requestId — replay a stored response. */
export async function status(requestId: string): Promise<CartResponse | null> {
  const cached = await cacheGet<CartResponse>(requestKey(requestId));
  if (cached) return cached;
  const row = await prisma.cartRequestLog.findUnique({ where: { requestId } });
  if (!row) return null;
  return row.response as unknown as CartResponse;
}
