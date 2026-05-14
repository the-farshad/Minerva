/**
 * Vector-document format for sketches. Source of truth for strokes,
 * shapes, and per-page state — replaces the previous "flatten to PNG
 * on save" pipeline that lost individual-stroke addressability after
 * the first save.
 *
 * Persisted as JSON inside `row.data._sketchDoc`. PG TOAST handles
 * compression transparently. A small PNG thumbnail is still written
 * to `row.data.content` so the rest of the UI (list/grid cards,
 * markdown <img> rendering) keeps working without a vector renderer
 * on every read.
 *
 * Schema versioning is intentional — bump `schemaVersion` and add a
 * migration in `hydrateDoc` when the shape changes. Older saves with
 * lower version numbers still hydrate, just lose the fields that
 * didn't exist yet.
 */

export type SketchDocPoint = {
  x: number;
  y: number;
  /** Pressure in [0, 1]. Optional; absent → 1.0 (full base width). */
  pressure?: number;
  /** Pencil tilt in degrees from vertical, ±90. Not yet consumed by
   *  the renderer but captured so future pencil-shading work has the
   *  data without a re-save. */
  tiltX?: number;
  tiltY?: number;
  /** Capture time as epoch-ms. Optional; used by future "replay" or
   *  "playback" features and as a tiebreaker when ordering strokes
   *  across devices. */
  time?: number;
};

export type SketchDocStrokeStyle = {
  color: string;
  /** Base width in CSS px. Per-point pressure multiplies this for
   *  the rendered stroke width. */
  width: number;
  opacity: number;
  cap: 'round' | 'butt' | 'square';
  join: 'round' | 'miter' | 'bevel';
};

export type SketchDocTool = 'pen' | 'pencil' | 'marker' | 'highlighter' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'arrow' | 'obj-eraser' | 'lasso';

export type SketchDocStroke = {
  id: string;
  type: 'stroke';
  tool: SketchDocTool;
  points: SketchDocPoint[];
  style: SketchDocStrokeStyle;
};

export type SketchDocObject = SketchDocStroke;

export type SketchDocPaperSize =
  | 'auto'
  | 'a4-portrait' | 'a4-landscape'
  | 'letter-portrait' | 'letter-landscape'
  | 'square';

export type SketchDocPaperBackground = 'blank' | 'grid' | 'lined' | 'dotted' | 'graph';

export type SketchDocPaper = {
  size: SketchDocPaperSize;
  background?: SketchDocPaperBackground;
};

export type SketchDocPage = {
  id: string;
  objects: SketchDocObject[];
};

export type SketchDoc = {
  schemaVersion: 1;
  documentId: string;
  paper: SketchDocPaper;
  pages: SketchDocPage[];
};

/** Hard caps enforced server-side and (defensively) client-side to
 *  prevent a runaway sketch from bloating row.data past PG's
 *  practical JSONB-edit envelope (≈ 1 MB before PATCH performance
 *  degrades sharply). Sketches that hit these limits truncate the
 *  oldest material first. */
export const SKETCH_LIMITS = {
  /** Total JSON payload size after stringify. Slightly below PG
   *  TOAST's compression sweet-spot. */
  maxBytes: 512 * 1024,
  maxPages: 50,
  maxObjectsPerPage: 5_000,
  maxPointsPerObject: 10_000,
} as const;

/** Generate a short unique id for strokes and pages. Not
 *  cryptographic — just unique enough that two strokes in the same
 *  doc never collide. The doc id itself is provided by the caller
 *  (typically the row id). */
export function newSketchId(prefix: 'stroke' | 'page'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Try to parse a JSON string as a SketchDoc. Returns null on any
 *  shape mismatch — caller falls back to the legacy PNG path. */
export function parseSketchDoc(raw: unknown): SketchDoc | null {
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null;
  try {
    const obj = JSON.parse(raw) as Partial<SketchDoc>;
    if (!obj || typeof obj !== 'object') return null;
    if (obj.schemaVersion !== 1) return null;
    if (!Array.isArray(obj.pages)) return null;
    return obj as SketchDoc;
  } catch {
    return null;
  }
}

/** Server-side validation. Returns null if the payload is valid,
 *  else a short error string suitable for surfacing to the client. */
export function validateSketchDoc(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const doc = raw as Partial<SketchDoc>;
  if (doc.schemaVersion !== 1) return `unknown schemaVersion ${doc.schemaVersion}`;
  if (!doc.documentId || typeof doc.documentId !== 'string') return 'missing documentId';
  if (!doc.paper || typeof doc.paper !== 'object') return 'missing paper';
  if (!Array.isArray(doc.pages)) return 'pages not an array';
  if (doc.pages.length > SKETCH_LIMITS.maxPages) return `> ${SKETCH_LIMITS.maxPages} pages`;
  for (const [pi, p] of doc.pages.entries()) {
    if (!p || typeof p !== 'object') return `pages[${pi}] not an object`;
    if (!Array.isArray((p as SketchDocPage).objects)) return `pages[${pi}].objects not an array`;
    const objs = (p as SketchDocPage).objects;
    if (objs.length > SKETCH_LIMITS.maxObjectsPerPage) return `pages[${pi}] > ${SKETCH_LIMITS.maxObjectsPerPage} objects`;
    for (const [oi, o] of objs.entries()) {
      if (!o || typeof o !== 'object') return `pages[${pi}].objects[${oi}] not an object`;
      if (o.type !== 'stroke') return `unsupported object type ${o.type}`;
      if (!Array.isArray(o.points)) return `pages[${pi}].objects[${oi}].points not an array`;
      if (o.points.length > SKETCH_LIMITS.maxPointsPerObject) return `pages[${pi}].objects[${oi}] > ${SKETCH_LIMITS.maxPointsPerObject} points`;
    }
  }
  // Size check after structure validation so a malformed huge blob
  // is rejected on shape, not stringify cost.
  const size = JSON.stringify(doc).length;
  if (size > SKETCH_LIMITS.maxBytes) return `payload ${size} > ${SKETCH_LIMITS.maxBytes} bytes`;
  return null;
}
