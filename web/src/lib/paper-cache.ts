/**
 * DB-backed cache for the public paper-lookup chain. Same row
 * survives container restarts; cross-user shared (the data is
 * upstream-public and identical for every visitor).
 *
 * TTL is enforced in code rather than in SQL so callers can pick
 * a different freshness window per source:
 *
 *   - metadata (title / authors / venue): 7 d   — stable
 *   - citationCount / references list:    1 d   — drifts as
 *                                                  upstream re-indexes
 *
 * A row that's older than the TTL is treated as a miss (not
 * deleted — a later upsert overwrites it, and the trailing index
 * on fetchedAt is what a periodic vacuum would use).
 */
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

export async function getCachedLookup<T = unknown>(
  key: string,
  ttlSec: number,
): Promise<T | null> {
  try {
    const row = await db.query.paperLookupCache.findFirst({
      where: eq(schema.paperLookupCache.key, key),
    });
    if (!row) return null;
    const age = (Date.now() - new Date(row.fetchedAt).getTime()) / 1000;
    if (age > ttlSec) return null;
    return row.data as T;
  } catch {
    // Cache lookup never fails the request — degrade to a miss.
    return null;
  }
}

export async function setCachedLookup(key: string, data: unknown): Promise<void> {
  try {
    await db.insert(schema.paperLookupCache)
      .values({ key, data, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.paperLookupCache.key,
        set: { data, fetchedAt: new Date() },
      });
  } catch {
    // Same — never fail the user request because the cache write
    // hiccuped. The upstream answer already shipped.
  }
}

/** Cache-or-fetch helper. Wraps a producer so each upstream call
 *  site stays a one-liner: `cacheOrFetch(key, ttl, () => fetchX())`. */
export async function cacheOrFetch<T>(
  key: string,
  ttlSec: number,
  producer: () => Promise<T | null>,
): Promise<T | null> {
  const hit = await getCachedLookup<T>(key, ttlSec);
  if (hit !== null) return hit;
  const fresh = await producer();
  if (fresh !== null) await setCachedLookup(key, fresh);
  return fresh;
}
