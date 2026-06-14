/**
 * Requirement cache with 30-day TTL.
 * Keys: (normalized query, queryType). Returning a stale entry is OK if it
 * pre-dates the TTL — get() filters those.
 */
import { prisma } from "./db.js";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function getCached<T>(query: string, queryType: string): Promise<T | null> {
  const row = await prisma.requirementCache.findUnique({
    where: {
      query_queryType: { query: normalizeKey(query), queryType },
    },
  });
  if (!row) return null;
  const age = Date.now() - row.createdAt.getTime();
  if (age > TTL_MS) return null;
  return row.payload as T;
}

export async function setCached<T extends object>(
  query: string,
  queryType: string,
  payload: T,
): Promise<void> {
  const key = normalizeKey(query);
  await prisma.requirementCache.upsert({
    where: { query_queryType: { query: key, queryType } },
    create: { query: key, queryType, payload: payload as object },
    update: { payload: payload as object, createdAt: new Date() },
  });
}
