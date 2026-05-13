/**
 * Per-process LRU cache for related-papers responses.
 *
 * Each /papers/related/[rowId] page load fires ~50 OpenAlex calls
 * (seed lookup + related_works fan-out + cited-by fan-out + CrossRef
 * title backfill). Citation graphs don't churn minute-to-minute —
 * caching the full RelatedResult for 6 hours collapses repeat loads
 * of the same paper to a single map lookup.
 *
 * Single-process scope: works because Minerva runs one Next.js
 * container on the droplet. Misses on container restart, which is
 * fine — the cache warms back up after a handful of queries.
 *
 * The cache is keyed by `${provider}:${seedId}` so a paper requested
 * via OpenAlex and the same paper requested via Semantic Scholar live
 * in separate entries (they return different shapes).
 */
import type { RelatedResult } from './types';

const MAX_ENTRIES = 200;
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

type Entry = { value: RelatedResult; expiresAt: number };

// Map preserves insertion order, which we exploit for cheap LRU
// eviction: delete + set on read moves the entry to the back.
const cache = new Map<string, Entry>();

export function getCached(key: string): RelatedResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // LRU touch — re-insert at the tail.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

export function setCached(key: string, value: RelatedResult): void {
  // Only cache "real" successes; errors and rate-limited results
  // shouldn't poison the next 6 h of requests.
  if (!value.ok || !value.papers || value.papers.length === 0) return;
  if (cache.size >= MAX_ENTRIES) {
    // Evict the LRU entry (the first in insertion order).
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}
