/**
 * v5 Cart Planning Service.
 *
 * The single entry point for both the /v1/cart/plan and /v1/cart/chat
 * endpoints. The controller has zero business logic — it parses HTTP, calls
 * `plan()` or `chat()` here, and serializes the result.
 *
 * Responsibilities:
 *   - Generate a requestId per call
 *   - Resolve / create the session (Redis-backed)
 *   - Drive the underlying orchestrator pipeline
 *   - Write the final CartResponse to CartRequestLog (request audit)
 *   - Cache the response by requestId for status replay
 */
import { randomUUID } from "node:crypto";
import { processTurn } from "./orchestrator.js";
import { ensureSession, getSession, saveSession } from "./sessions.js";
import { toCartResponse } from "./responseMapper.js";
import { prisma } from "./db.js";
import { cacheGet, cacheSet } from "./redis.js";
import type { CartResponse } from "./types/cart.types.js";

const REQUEST_CACHE_TTL = 24 * 60 * 60; // 24h

const requestKey = (id: string) => `request:${id}`;

export type PlanInput = {
  query: string;
  sessionId?: string;
  includeDebug?: boolean;
};

async function runPipeline(args: {
  query: string;
  sessionId?: string;
  includeDebug: boolean;
  isChat: boolean;
}): Promise<CartResponse> {
  const requestId = randomUUID();
  const t0 = Date.now();
  const { query, includeDebug, isChat } = args;

  // For chat: load or create session. For plan: stateless single-shot
  // (we still mint a sessionId so the response shape is uniform).
  const { sessionId, state } = await ensureSession(args.sessionId);

  const history = isChat ? state.history : [];
  const turn = await processTurn({ sessionId, history, message: query });

  // Update session for chat. Reset history when the planner closed the
  // conversation (status='ready' = a cart was returned).
  if (isChat) {
    state.history.push({ role: "user", content: query });
    state.history.push({ role: "assistant", content: turn.reply });
    if (turn.status === "ready") state.history = [];
    await saveSession(sessionId, state);
  }

  const response = toCartResponse({
    requestId,
    turn,
    includeDebug,
    sessionId,
  });

  const latencyMs = Date.now() - t0;

  // Persist + cache. Both are best-effort — never fail the request.
  await Promise.allSettled([
    prisma.cartRequestLog
      .create({
        data: {
          requestId,
          query,
          queryType: response.queryType,
          status: response.status,
          coverage: response.coverage,
          sessionId,
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
    `[cart-service] requestId=${requestId} query=${JSON.stringify(query).slice(0, 50)} ` +
      `type=${response.queryType} status=${response.status} cov=${response.coverage.toFixed(2)} ` +
      `latency=${latencyMs}ms`,
  );

  return response;
}

/** POST /v1/cart/plan — single-shot, no conversation state. */
export async function plan(input: PlanInput): Promise<CartResponse> {
  return runPipeline({
    query: input.query,
    sessionId: input.sessionId,
    includeDebug: !!input.includeDebug,
    isChat: false,
  });
}

/** POST /v1/cart/chat — multi-turn, persists conversation history. */
export async function chat(input: PlanInput): Promise<CartResponse> {
  return runPipeline({
    query: input.query,
    sessionId: input.sessionId,
    includeDebug: !!input.includeDebug,
    isChat: true,
  });
}

/** GET /v1/cart/status/:requestId — replay a stored response. */
export async function status(requestId: string): Promise<CartResponse | null> {
  const cached = await cacheGet<CartResponse>(requestKey(requestId));
  if (cached) return cached;
  const row = await prisma.cartRequestLog.findUnique({ where: { requestId } });
  if (!row) return null;
  return row.response as unknown as CartResponse;
}
