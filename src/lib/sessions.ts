/**
 * Redis-backed session store.
 *
 * Replaces the in-memory `Map<sessionId, Session>` from the v4 server.
 * Sessions hold conversation history (ChatMessage[]). Idle TTL is enforced
 * via Redis EX — every read refreshes the timer.
 *
 * Spec: clarification rounds capped at 2; history is reset after a "ready"
 * turn (handled in the service layer, not here).
 */
import { randomUUID } from "node:crypto";
import { cacheGet, cacheSet, cacheDel } from "./redis.js";
import type { ChatMessage } from "./planner.js";

const SESSION_TTL_SECONDS = 30 * 60; // 30 min idle

const key = (id: string) => `session:${id}`;

export type SessionState = {
  history: ChatMessage[];
  createdAt: number;
};

export async function getSession(id: string): Promise<SessionState | null> {
  if (!id) return null;
  const s = await cacheGet<SessionState>(key(id));
  if (!s) return null;
  // Refresh TTL on read.
  await cacheSet(key(id), s, SESSION_TTL_SECONDS);
  return s;
}

export async function ensureSession(id: string | undefined): Promise<{ sessionId: string; state: SessionState }> {
  if (id) {
    const existing = await getSession(id);
    if (existing) return { sessionId: id, state: existing };
  }
  const sessionId = randomUUID();
  const state: SessionState = { history: [], createdAt: Date.now() };
  await cacheSet(key(sessionId), state, SESSION_TTL_SECONDS);
  return { sessionId, state };
}

export async function saveSession(id: string, state: SessionState): Promise<void> {
  await cacheSet(key(id), state, SESSION_TTL_SECONDS);
}

export async function deleteSession(id: string): Promise<void> {
  if (!id) return;
  await cacheDel(key(id));
}
