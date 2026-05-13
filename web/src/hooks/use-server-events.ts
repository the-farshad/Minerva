'use client';

import { useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

/** Event payload mirrors `src/lib/event-bus.ts`. Kept inline so the
 *  client bundle doesn't have to import the server-side module. */
export type ServerEvent =
  | { kind: 'row.created'; sectionSlug: string; rowId: string; data: Record<string, unknown> }
  | { kind: 'row.updated'; sectionSlug: string; rowId: string; data: Record<string, unknown> }
  | { kind: 'row.deleted'; sectionSlug: string; rowId: string }
  | { kind: 'rows.bulkChanged'; sectionSlug: string; rowIds: string[] }
  | { kind: 'section.changed'; sectionSlug: string }
  | { kind: 'section.renamed'; oldSlug: string; newSlug: string; title: string }
  | { kind: 'sections.listChanged' }
  | { kind: 'bookmark.changed'; url: string; op: 'created' | 'updated' | 'deleted' }
  | { kind: 'poll.changed'; token: string }
  | { kind: 'userprefs.changed' };

/** Every event kind we know how to dispatch — kept in one array so
 *  adding a new event variant only requires extending this list and
 *  the union above. */
const EVENT_KINDS: ServerEvent['kind'][] = [
  'row.created', 'row.updated', 'row.deleted',
  'rows.bulkChanged',
  'section.changed', 'section.renamed', 'sections.listChanged',
  'bookmark.changed', 'poll.changed', 'userprefs.changed',
];

type Handler = (e: ServerEvent) => void;

const NOTIF_ENABLED_KEY = 'minerva.v2.browserNotifications';

/** Surface a browser Notification for a Minerva event when the
 *  user has opted in via Settings → Browser notifications AND
 *  granted OS permission. Background-tab events trigger the OS
 *  banner; foreground events stay silent (the page UI updates
 *  via the same SSE handler so a duplicate banner is noise). */
function maybeShowBrowserNotification(event: ServerEvent) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    if (localStorage.getItem(NOTIF_ENABLED_KEY) !== '1') return;
  } catch { return; }
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  let title = 'Minerva';
  let body = '';
  if (event.kind === 'row.created') {
    title = `New in ${event.sectionSlug}`;
    body = String(event.data?.title || event.data?.name || event.rowId);
  } else if (event.kind === 'row.updated') {
    title = `Updated in ${event.sectionSlug}`;
    body = String(event.data?.title || event.data?.name || event.rowId);
  } else if (event.kind === 'row.deleted') {
    title = `Deleted from ${event.sectionSlug}`;
    body = event.rowId;
  } else if (event.kind === 'poll.changed') {
    title = 'Poll updated';
    body = event.token;
  } else {
    return;
  }
  try {
    const n = new Notification(title, { body, icon: '/icon.svg', tag: `minerva-${event.kind}` });
    setTimeout(() => { try { n.close(); } catch { /* tolerate */ } }, 6000);
  } catch { /* notification blocked by browser policy — silent */ }
}

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
/** How long to wait without ANY event (including the server's 25 s
 *  heartbeat) before we assume the stream has silently stalled and
 *  forcibly reconnect. 70 s covers two heartbeat misses with slack
 *  for proxy/network jitter. */
const WATCHDOG_MS = 70_000;

export function useServerEvents(onEvent?: Handler) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  /** pathname kept in a ref so the SSE listener (which never re-binds
   *  after the first mount) can read the current route to decide
   *  whether a section.renamed event should redirect this tab. */
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let lastEventAt = Date.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const reopen = () => { es?.close(); es = null; open(); };

    const handleEvent = (event: ServerEvent) => {
      lastEventAt = Date.now();
      maybeShowBrowserNotification(event);
      if (onEvent) {
        onEvent(event);
        return;
      }
      // Default dispatch: invalidate the query keys most likely to
      // depend on this event, then trigger a server-component
      // refresh so any non-React-Query state on the page also
      // reconciles. Each branch is intentionally narrow — broader
      // invalidations cause unnecessary refetch storms when the
      // user has many sections open.
      switch (event.kind) {
        case 'row.created':
        case 'row.updated':
        case 'row.deleted':
        case 'rows.bulkChanged':
          qc.invalidateQueries({ queryKey: ['rows', event.sectionSlug] });
          router.refresh();
          break;
        case 'section.changed':
          qc.invalidateQueries({ queryKey: ['section', event.sectionSlug] });
          qc.invalidateQueries({ queryKey: ['sections'] });
          router.refresh();
          break;
        case 'section.renamed': {
          qc.invalidateQueries({ queryKey: ['sections'] });
          // If THIS tab is parked on the old slug, redirect to the new
          // one so the next refetch doesn't 404. Otherwise the sidebar
          // refetch above is enough.
          const p = pathRef.current || '';
          const m = p.match(/^\/s\/([^/]+)/);
          if (m && m[1] === event.oldSlug) {
            router.replace(`/s/${event.newSlug}`);
          } else {
            router.refresh();
          }
          break;
        }
        case 'sections.listChanged':
          qc.invalidateQueries({ queryKey: ['sections'] });
          router.refresh();
          break;
        case 'bookmark.changed':
          qc.invalidateQueries({ queryKey: ['bookmarks'] });
          qc.invalidateQueries({ queryKey: ['bookmarks', event.url] });
          break;
        case 'poll.changed':
          qc.invalidateQueries({ queryKey: ['poll', event.token] });
          router.refresh();
          break;
        case 'userprefs.changed':
          qc.invalidateQueries({ queryKey: ['userprefs'] });
          break;
      }
    };

    function open() {
      if (es) return;
      es = new EventSource('/api/sse');
      lastEventAt = Date.now();
      const dispatch = (raw: MessageEvent) => {
        try {
          handleEvent(JSON.parse(raw.data) as ServerEvent);
        } catch { /* malformed payload — ignore */ }
      };
      for (const kind of EVENT_KINDS) {
        es.addEventListener(kind, dispatch as EventListener);
      }
      // The server also writes `: heartbeat\n\n` comment frames every
      // 25 s; those don't fire an event handler but they DO touch the
      // underlying readyState, which is what onmessage/dispatch
      // implicitly rely on. We treat any onmessage (named or not) as
      // proof of life.
      es.onmessage = () => { lastEventAt = Date.now(); };
      es.onerror = () => {
        // Browser will auto-reconnect on transient errors, but if it
        // doesn't, our watchdog will kick in below.
        es?.close();
        es = null;
      };
    }

    open();

    // Watchdog — force a reconnect if nothing's arrived for
    // WATCHDOG_MS. The server sends a heartbeat every 25 s, so going
    // silent past 70 s means either the connection has been broken
    // upstream or a reverse proxy is buffering us. Close + reopen.
    watchdog = setInterval(() => {
      if (Date.now() - lastEventAt > WATCHDOG_MS) reopen();
    }, 15_000);

    const onVis = () => { if (document.visibilityState === 'visible') open(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      if (watchdog) clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVis);
      es?.close();
      es = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
