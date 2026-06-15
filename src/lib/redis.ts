/**
 * Redis client singleton + typed cache helpers.
 *
 * Key conventions (spec phase 6):
 *   planner:{queryType}:{normalizedQuery}    — full PlannerOutput
 *   classifier:{normalizedQuery}             — ClassifierOutput
 *   mission:{slug}                           — MissionKB row
 *   dish:{slug}                              — MissionKB row (type=dish)
 *   query_embedding:{hash}                   — embedding vector
 *   request:{requestId}                      — final CartResponse (24h)
 *   session:{sessionId}                      — conversation history (30 min idle TTL)
 *
 * TTL defaults to 30 days; pass a custom ttlSeconds to override.
 */
import { createClient, type RedisClientType } from "redis";

const TTL_30_DAYS = 30 * 24 * 60 * 60;

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

async function getClient(): Promise<RedisClientType> {
  if (client && client.isOpen) return client;
  if (connecting) return connecting;
  const url = process.env.REDIS_URL ?? "redis://localhost:6380";
  const c = createClient({ url });
  c.on("error", (err) => console.error("[redis] client error:", err.message));
  connecting = c.connect().then(() => {
    client = c as RedisClientType;
    connecting = null;
    return client;
  });
  return connecting;
}

export function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const c = await getClient();
    const raw = await c.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[redis] get failed:", (err as Error).message);
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = TTL_30_DAYS,
): Promise<void> {
  try {
    const c = await getClient();
    await c.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.error("[redis] set failed:", (err as Error).message);
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    const c = await getClient();
    await c.del(key);
  } catch (err) {
    console.error("[redis] del failed:", (err as Error).message);
  }
}

/** Closes the connection. Used by graceful shutdown / scripts. */
export async function disconnectRedis(): Promise<void> {
  if (client && client.isOpen) await client.quit();
  client = null;
}
