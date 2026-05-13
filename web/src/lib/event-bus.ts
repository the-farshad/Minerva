/**
 * Per-user in-process event bus. Mutation routes call
 * `bus.emit(userId, event)` after a successful DB write; the SSE
 * route at `/api/sse` subscribes to events for the signed-in user
 * and streams them to every open tab on every device.
 *
 * Single-process scope: this works because Minerva runs as one
 * Next.js container on the droplet. If we ever shard the app
 * tier we'll need to swap this for PG LISTEN/NOTIFY or Redis
 * pub/sub — the call-sites stay the same, only this module
 * changes.
 *
 * Memory safety: subscribers register a handler and get back an
 * unsubscribe function; the SSE route calls it from its abort
 * signal so handlers don't accumulate after the tab closes.
 */
import { EventEmitter } from 'node:events';

export type MinervaEvent =
  | { kind: 'row.created'; sectionSlug: string; rowId: string; data: Record<string, unknown> }
  | { kind: 'row.updated'; sectionSlug: string; rowId: string; data: Record<string, unknown> }
  | { kind: 'row.deleted'; sectionSlug: string; rowId: string }
  /** N rows in one section mutated together — emitted by
   *  rewrite-tag, bulk-delete, import-sheet so the client invalidates
   *  the section's row list once instead of N times. */
  | { kind: 'rows.bulkChanged'; sectionSlug: string; rowIds: string[] }
  | { kind: 'section.changed'; sectionSlug: string }
  /** Slug changed (e.g. user renamed the section). The client uses
   *  this to redirect any tab parked on the old slug to the new one
   *  instead of 404-ing on the next refetch. */
  | { kind: 'section.renamed'; oldSlug: string; newSlug: string; title: string }
  /** Section was added/removed/reordered — sidebar should refetch. */
  | { kind: 'sections.listChanged' }
  | { kind: 'bookmark.changed'; url: string; op: 'created' | 'updated' | 'deleted' }
  | { kind: 'poll.changed'; token: string }
  | { kind: 'userprefs.changed' };

// Node EventEmitter is hot-reload friendly under the App Router's
// in-place module evaluation; storing on globalThis keeps a single
// bus across HMR cycles in dev.
type Bus = EventEmitter & { __minervaTagged?: boolean };
const g = globalThis as unknown as { __minervaBus?: Bus };
function getBus(): Bus {
  if (!g.__minervaBus) {
    const b = new EventEmitter() as Bus;
    // Many tabs per user → many listeners. The default cap of 10
    // would warn aggressively on the second open window.
    b.setMaxListeners(0);
    b.__minervaTagged = true;
    g.__minervaBus = b;
  }
  return g.__minervaBus;
}

export const bus = {
  /** Broadcast an event to every subscriber of this user. Fire-
   *  and-forget; subscribers handle their own errors. */
  emit(userId: string, event: MinervaEvent): void {
    getBus().emit(userId, event);
  },
  /** Subscribe to events for the given user. Returns the
   *  unsubscribe handle to call on tab-close / abort. */
  subscribe(userId: string, handler: (event: MinervaEvent) => void): () => void {
    const b = getBus();
    b.on(userId, handler);
    return () => { b.off(userId, handler); };
  },
};
