/** The universal client-side row shape — the rows API's projection
 *  of the server `rows` table: identity, the schema-shaped JSONB
 *  `data` blob, and timestamps. Was copy-pasted into five section
 *  views; consolidated here so a field added in one place (e.g.
 *  `createdAt`) is visible everywhere.
 *
 *  `createdAt` and `sectionSlug` are optional: some construction
 *  paths don't carry them — SSE row patches synthesise a fresh
 *  `updatedAt` only, and `sectionSlug` is only set by the
 *  cross-section views (calendar / schedule). */
export type Row = {
  id: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt: string;
  sectionSlug?: string;
};
