'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

/** Event payload mirrors `src/lib/event-bus.ts`. Kept inline so the
 *  client bundle doesn't have to import the server-side module. */
export type ServerEvent =
  | { kind: 'row.created'; sectionSlug: string; rowId: string; data: Record<string, unknown> }
  | { kind: 'row.updated'; sectionSlug: string; rowId: string; data: Record<string, unknown> }
  | { kind: 'row.deleted'; sectionSlug: string; rowId: string }
  | { kind: 'section.changed'; sectionSlug: string }
  | { kind: 'poll.changed'; token: string };

type Handler = (e: ServerEvent) => void;

/** Subscribe to the per-user SSE stream once at app mount. The
 *  optional `onEvent` callback fires synchronously for every
 *  event so callers can patch their local state (Kanban list,
 *  preview modal contents, etc.) without an extra fetch. When
 *  no callback is given, the hook falls back to invalidating the
 *  matching React Query cache key + a server-component refresh.
 *
 *  Reconnect-on-error: EventSource auto-reconnects on transport
 *  errors with browser-default backoff. We don't fight that.
 *  A `visibilitychange` listener re-establishes the stream if
 *  the user resumes a tab the browser had quietly suspended. */
export function useServerEvents(onEvent?: Handler) {
  const qc = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    const open = () => {
      if (es) return;
      es = new EventSource('/api/sse');
      const dispatch = (raw: MessageEvent) => {
        try {
          const event = JSON.parse(raw.data) as ServerEvent;
          if (onEvent) {
            onEvent(event);
          } else if (event.kind.startsWith('row.')) {
            const ev = event as Extract<ServerEvent, { sectionSlug: string }>;
            qc.invalidateQueries({ queryKey: ['rows', ev.sectionSlug] });
            router.refresh();
          } else {
            router.refresh();
          }
        } catch { /* malformed payload — ignore */ }
      };
      // Listen for each event kind by name; EventSource only
      // fires the default 'message' handler when no `event:`
      // field was sent.
      for (const kind of ['row.created', 'row.updated', 'row.deleted', 'section.changed', 'poll.changed']) {
        es.addEventListener(kind, dispatch as EventListener);
      }
      es.onerror = () => {
        // Browser will reconnect automatically; close+null so a
        // visibilitychange retry doesn't pile up streams.
        es?.close();
        es = null;
      };
    };
    open();
    const onVis = () => { if (document.visibilityState === 'visible') open(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      es?.close();
      es = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
