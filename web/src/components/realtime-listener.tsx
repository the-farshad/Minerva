'use client';

/**
 * Mount-once global subscriber to the per-user SSE stream.
 *
 * Until this existed, only `/s/[slug]/section-view.tsx` opened an
 * EventSource and patched local state. Schema changes, sidebar
 * updates, bookmark toggles and settings saves emitted events
 * that no client was listening for — so a mutation only became
 * visible after a full page refresh.
 *
 * With this component mounted in <Providers>, the default-dispatch
 * branch of `useServerEvents` runs for every event the active page
 * doesn't claim, so:
 *
 *   - section.changed / sections.listChanged → router.refresh()
 *   - section.renamed → router.replace(/s/<new>) when parked on old
 *   - bookmark.changed → React Query invalidation
 *   - userprefs.changed → React Query invalidation
 *   - row events → router.refresh() on non-section pages; skipped
 *     on /s/<slug> because section-view patches rows locally.
 *
 * The cost is one extra EventSource per tab (alongside the
 * section-view subscriber when /s/[slug] is open). Both connect
 * to the same per-user channel; the bus fans out. A single-source
 * refactor (one EventSource feeding a React context) is a future
 * improvement, not a correctness issue.
 */
import { useServerEvents } from '@/hooks/use-server-events';

export function RealtimeListener() {
  useServerEvents();
  return null;
}
