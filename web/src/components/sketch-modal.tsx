'use client';

/**
 * Apple-Notes-style sketch modal — rebuilt from scratch after
 * multiple incremental patches failed to make Apple Pencil work
 * reliably on iPad. Architecture choices (all deliberate):
 *
 *   1. No Radix Dialog. Renders via React's createPortal into
 *      document.body, with a plain `fixed inset-0` overlay.
 *      Radix Dialog's pointer/focus pipeline kept stepping on
 *      iPad's Pencil + pointer-capture combo.
 *
 *   2. Native `addEventListener` on the canvas, not React's
 *      synthetic `onPointerDown` etc. React delegates pointer
 *      events from `document`, which is interferred with by
 *      iOS Safari's gesture recognition layer when Apple
 *      Pencil is the input device. Direct listeners bypass it.
 *
 *   3. Both `pointer*` and `touch*` listeners with a dedupe
 *      ref. Whichever fires first wins; the other ignores.
 *      Belt-and-suspenders against the iPadOS path where one
 *      family mysteriously stays silent.
 *
 *   4. `touch-action: none` inline, `preventDefault` on touch
 *      events (passive:false) so the browser can't claim the
 *      gesture for scroll / pinch.
 *
 *   5. Five tools (pen / pencil / marker / highlighter /
 *      eraser), each with its own width range and alpha. Pen is
 *      pressure-variable when the input is an actual pen; every
 *      other tool uses a uniform width.
 *
 *   6. Quadratic-curve smoothing through midpoints for iOS-
 *      Notes-quality ink. Per-segment lineWidth so pressure
 *      variation shows even on the smoothed path.
 *
 *   7. Diagnostic strip baked in (bottom-right): shows the last
 *      event type, pointer type, pressure, and current stroke
 *      count. If the canvas STILL feels unresponsive on iPad
 *      after this rewrite, the strip will reveal which layer
 *      isn't firing — Pencil events, our handlers, or render.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  X, Trash2, Eraser, Pen, Pencil as PencilIcon, Highlighter,
  Brush, Loader2, Undo2, Redo2, FileDown, Slash,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Plus as PlusIcon, FileX, Lasso, Copy, Minus,
  Square, Circle, ArrowRight, FileText, SlidersHorizontal, Info, Type as TypeIcon, Hand,
  Triangle, Diamond, Star, Hexagon, Shapes as ShapesIcon, Palette,
} from 'lucide-react';
import { distanceToPolyline, pointInPolygon, polylineBBox } from '@/lib/sketch-hit-test';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { jsPDF } from 'jspdf';
import type { SketchDoc, SketchDocStroke, SketchDocText, SketchDocPage, SketchDocPaper, SketchDocPaperSize } from '@/lib/sketch-doc';
import { newSketchId } from '@/lib/sketch-doc';

type Tool =
  | 'pen' | 'pencil' | 'marker' | 'highlighter' | 'eraser'
  | 'line' | 'rect' | 'ellipse' | 'arrow'
  | 'triangle' | 'diamond' | 'star' | 'hexagon'
  | 'obj-eraser' | 'lasso' | 'text';

/** Shape tools share the same 2-point start/end gesture; the
 *  renderer derives the geometry from the bounding rect. Kept in a
 *  set so the toolbar can tuck them all behind one "Shapes" sub-nav
 *  and the gesture/commit code can branch on "is this a shape?". */
const SHAPE_TOOL_IDS = ['line', 'rect', 'ellipse', 'arrow', 'triangle', 'diamond', 'star', 'hexagon'] as const;
function isShapeTool(t: Tool): boolean {
  return (SHAPE_TOOL_IDS as readonly string[]).includes(t);
}

type ToolSpec = {
  id: Tool;
  label: string;
  Icon: typeof Pen;
  /** Width range exposed by the size tiers — `minWidth` is the
   *  thinnest tier, `maxWidth` the thickest. Kept wide so the user
   *  has both very fine and very bold options. */
  minWidth: number;
  maxWidth: number;
  /** Width used when no tier is explicitly picked (and for non-
   *  pressure input). Decoupled from the range so widening the
   *  tiers doesn't drag the natural default thicker. */
  defaultWidth: number;
  alpha: number;
};

const TOOLS: ToolSpec[] = [
  { id: 'pen',         label: 'Pen',         Icon: Pen,         minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'pencil',      label: 'Pencil',      Icon: PencilIcon,  minWidth: 0.5,  maxWidth: 16, defaultWidth: 2,  alpha: 0.85 },
  { id: 'marker',      label: 'Marker',      Icon: Brush,       minWidth: 3,    maxWidth: 48, defaultWidth: 10, alpha: 0.6  },
  { id: 'highlighter', label: 'Highlighter', Icon: Highlighter, minWidth: 6,    maxWidth: 64, defaultWidth: 18, alpha: 0.35 },
  // Vector shape tools — same 2-point start/end gesture as line;
  // the renderer derives the geometry from the bounding rect. All
  // live behind the toolbar's "Shapes" sub-nav (see SHAPE_TOOL_IDS).
  { id: 'line',        label: 'Line',        Icon: Slash,       minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'rect',        label: 'Rectangle',   Icon: Square,      minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'ellipse',     label: 'Ellipse',     Icon: Circle,      minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'arrow',       label: 'Arrow',       Icon: ArrowRight,  minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'triangle',    label: 'Triangle',    Icon: Triangle,    minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'diamond',     label: 'Diamond',     Icon: Diamond,     minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'star',        label: 'Star',        Icon: Star,        minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'hexagon',     label: 'Hexagon',     Icon: Hexagon,     minWidth: 0.75, maxWidth: 22, defaultWidth: 3,  alpha: 1    },
  { id: 'eraser',      label: 'Eraser',      Icon: Eraser,      minWidth: 4,    maxWidth: 80, defaultWidth: 18, alpha: 1    },
  // Vector-aware tools enabled by the SketchDoc model.
  // `obj-eraser` removes whole strokes per tap/swipe; `lasso`
  // selects strokes inside a freehand loop so the user can delete
  // / duplicate / drag-move them as a unit.
  { id: 'obj-eraser',  label: 'Erase obj',   Icon: Trash2,      minWidth: 4,    maxWidth: 40, defaultWidth: 12, alpha: 1    },
  { id: 'lasso',       label: 'Lasso',       Icon: Lasso,       minWidth: 2,    maxWidth: 2,  defaultWidth: 2,  alpha: 0.6  },
  // Text tool — taps place a <textarea> editing overlay. On iPadOS
  // that textarea is Scribble-enabled, so Apple Pencil handwriting
  // is converted to text on-device. Width/alpha are unused.
  { id: 'text',        label: 'Text',        Icon: TypeIcon,    minWidth: 1,    maxWidth: 1,  defaultWidth: 1,  alpha: 1    },
];

/** Expanded 16-swatch palette — two rows of inks (greys + dark
 *  jewel tones + warm/cool spectrum). The native colour input is
 *  still rendered next to the row so the user can pick anything
 *  off-palette when needed. */
const PALETTE = [
  '#1f1f1f', '#52525b', '#a1a1aa', '#ffffff',
  '#e11d48', '#ea580c', '#ca8a04', '#16a34a',
  '#0d9488', '#0284c7', '#4f46e5', '#7c3aed',
  '#c026d3', '#db2777', '#a16207', '#1e3a8a',
];

/** Per-point captured Pencil state. tilt (`tx`, `ty`) is in degrees
 *  from vertical, ±90; absent for finger/mouse input. Persisted via
 *  SketchDocPoint.tiltX / tiltY so a future shading renderer can
 *  use it without re-asking the user to redraw. */
type Point = { x: number; y: number; w: number; tx?: number; ty?: number };
type Stroke = { tool: Tool; color: string; alpha: number; points: Point[] };

/** Runtime typed-text object. `x`/`y` is the top-left anchor in
 *  model coordinates; `fontSize` is in model px. Mirrors
 *  SketchDocText 1:1 — the converters below are identity-ish. */
type TextObj = { x: number; y: number; text: string; fontSize: number; color: string };

/** Multi-page document model. Each page holds its own stroke
 *  history, typed-text objects, and optional background image; the
 *  editor flips between pages by changing `pageIndex`, with
 *  `strokesRef` / `textsRef` / `bgImageRef` / `pageOverrideRef`
 *  aliased to the current page's slots. `paper`, when set, overrides
 *  the document-wide paper settings for this page only. */
type PagePaperOverride = Partial<SketchDocPaper>;
type SketchPage = {
  strokes: Stroke[];
  texts: TextObj[];
  bg: HTMLImageElement | null;
  paper?: PagePaperOverride;
};

/** Paper format presets — affect the PDF export dimensions only.
 *  The on-screen canvas always fills the viewport regardless of
 *  format so the user gets maximum drawing area; `auto` exports
 *  at the actual canvas dimensions instead of forcing a standard
 *  paper aspect ratio. */
type PageFormat = 'auto' | 'a4-portrait' | 'a4-landscape' | 'letter-portrait' | 'letter-landscape' | 'square';
type PageBackground = 'blank' | 'lined' | 'grid' | 'dotted' | 'graph';
type PaperColor = 'white' | 'cream' | 'light' | 'dark' | 'black';
const PAPER_COLORS: { id: PaperColor; label: string; fill: string; ink: 'dark' | 'light' }[] = [
  { id: 'white',  label: 'White',  fill: '#ffffff', ink: 'dark' },
  { id: 'cream',  label: 'Cream',  fill: '#fbf5e8', ink: 'dark' },
  { id: 'light',  label: 'Light',  fill: '#f4f4f5', ink: 'dark' },
  { id: 'dark',   label: 'Dark',   fill: '#27272a', ink: 'light' },
  { id: 'black',  label: 'Black',  fill: '#0a0a0a', ink: 'light' },
];

const PAGE_FORMATS: { id: PageFormat; label: string; pxW: number; pxH: number }[] = [
  // pxW/pxH are CSS-px dimensions used for the PDF page size; the
  // SVG export uses them verbatim. Roughly 96 dpi so a 595x842 A4
  // page exports at print-typical scale.
  { id: 'auto',             label: 'Auto (canvas)',  pxW: 0,   pxH: 0   },
  { id: 'a4-portrait',      label: 'A4 portrait',    pxW: 595, pxH: 842 },
  { id: 'a4-landscape',     label: 'A4 landscape',   pxW: 842, pxH: 595 },
  { id: 'letter-portrait',  label: 'Letter portrait', pxW: 612, pxH: 792 },
  { id: 'letter-landscape', label: 'Letter landscape', pxW: 792, pxH: 612 },
  { id: 'square',           label: 'Square',         pxW: 720, pxH: 720 },
];

function getToolSpec(t: Tool): ToolSpec {
  return TOOLS.find((x) => x.id === t) ?? TOOLS[0];
}

/* ----- In-memory Stroke ↔ SketchDocStroke converters --------------
 * The runtime Stroke carries per-point absolute width (`w`). The
 * persisted SketchDocStroke carries a base `style.width` plus a
 * per-point `pressure` multiplier (0..1) so the same point-array
 * survives a roundtrip without losing the pressure-variation info.
 *   roundtrip:
 *     stroke.points[i].w  =  stroke.style.width × pressure[i]
 *   ↔
 *     pressure[i]          =  stroke.points[i].w / stroke.style.width
 */
function strokeToDocStroke(s: Stroke, id: string): SketchDocStroke {
  const widths = s.points.map((p) => p.w);
  const baseWidth = widths.length > 0
    ? widths.reduce((a, b) => a + b, 0) / widths.length
    : 1;
  return {
    id,
    type: 'stroke',
    // `Stroke.tool` is the editor's Tool union, which includes
    // 'text' — but the text tool never produces a Stroke (it places
    // a TextObj instead), so a stroke's tool is always a real
    // SketchDocTool. The cast bridges the wider type at this one
    // serialisation boundary.
    tool: s.tool as SketchDocStroke['tool'],
    points: s.points.map((p) => {
      const out: { x: number; y: number; pressure: number; tiltX?: number; tiltY?: number } = {
        x: p.x,
        y: p.y,
        pressure: baseWidth > 0 ? p.w / baseWidth : 1,
      };
      if (typeof p.tx === 'number') out.tiltX = p.tx;
      if (typeof p.ty === 'number') out.tiltY = p.ty;
      return out;
    }),
    style: {
      color: s.color,
      width: baseWidth,
      opacity: s.alpha,
      cap: 'round',
      join: 'round',
    },
  };
}

function docStrokeToStroke(ds: SketchDocStroke): Stroke {
  const baseWidth = ds.style.width || 1;
  return {
    tool: ds.tool,
    color: ds.style.color,
    alpha: ds.style.opacity,
    points: ds.points.map((p) => {
      const pt: Point = {
        x: p.x,
        y: p.y,
        w: baseWidth * (p.pressure ?? 1),
      };
      if (typeof p.tiltX === 'number') pt.tx = p.tiltX;
      if (typeof p.tiltY === 'number') pt.ty = p.tiltY;
      return pt;
    }),
  };
}

/** Text object ↔ SketchDocText converters. Nearly identity — the
 *  persisted form just carries an `id` + `type` discriminator. */
function textToDocText(t: TextObj, id: string): SketchDocText {
  return { id, type: 'text', x: t.x, y: t.y, text: t.text, fontSize: t.fontSize, color: t.color };
}
function docTextToText(dt: SketchDocText): TextObj {
  return { x: dt.x, y: dt.y, text: dt.text, fontSize: dt.fontSize || 28, color: dt.color || '#1f1f1f' };
}

/** Map between the editor's PageFormat enum and the persisted
 *  SketchDocPaperSize. They share the same value space — this is
 *  just a typed bridge so a future divergence (per-page sizes,
 *  custom dimensions) only needs to change in one place. */
function paperToDocSize(f: PageFormat): SketchDocPaperSize { return f; }
function docSizeToPaper(s: SketchDocPaperSize): PageFormat { return s; }

export function SketchModal({
  open, onClose, onSaved, seed, saveMode = 'upload', seedDoc, onAutoSave, documentId,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (url: string, name: string) => void;
  /** Existing sketch URL or data-URL to preload as the canvas
   *  background. Erasable as a stroke layer like any other ink.
   *  Used only when `seedDoc` is absent — when both are provided
   *  the vector doc wins. */
  seed?: string;
  /** How `save()` produces the URL passed to onSaved:
   *   - 'upload' (default): upload the PNG to the user's Drive and
   *     emit `/api/drive/file?id=...`. Used by the notes-pane Sketch
   *     tile where the canvas becomes a Drive-backed attachment.
   *   - 'inline': skip the upload, emit a base64 PNG `data:` URL.
   *     Used by inline-cell sketch columns where the row's column
   *     stores the bytes directly and there's no separate file. */
  saveMode?: 'upload' | 'inline';
  /** Existing vector document to hydrate the editor from. When
   *  present, every previously-saved stroke is reconstructed as a
   *  Stroke object on its original page — actually editable, not a
   *  flattened background image. Falls back to `seed` (PNG) for
   *  rows that pre-date the vector format. */
  seedDoc?: SketchDoc;
  /** Auto-save hook. Called on every stroke completion with a fresh
   *  full-document snapshot so the caller can PATCH it to PG. The
   *  caller is responsible for single-flighting (one in-flight PATCH
   *  at a time) so a fast scribbler can't pile up requests. */
  onAutoSave?: (doc: SketchDoc) => void;
  /** Stable document id (usually the row id). Captured into the doc
   *  so server-side validation can sanity-check the inbound payload
   *  against the row it's being written to. */
  documentId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Offscreen canvas for the strokes layer — eraser strokes punch
  // holes through it with `destination-out`, then it's composited
  // onto the main canvas which already has paper + pattern painted.
  // Doing it on a separate layer means erasing rubs out *ink only*;
  // the paper colour and lined / grid pattern below stay intact.
  // Lazily created on the first redraw and resized to match the
  // main canvas's pixel dimensions.
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Source of truth for the document. Each page owns its own stroke
   *  history; `strokesRef` and `bgImageRef` below are kept as aliases
   *  into the current page so the rest of the file (which already
   *  reads / mutates those refs in dozens of places) doesn't have to
   *  thread a page index through every callsite. */
  const pagesRef = useRef<SketchPage[]>([{ strokes: [], texts: [], bg: null }]);
  /** Stable id-per-page, indexed parallel to pagesRef. Persisted in
   *  the SketchDoc so subsequent autosaves keep the same page id
   *  even after reordering / deletion. */
  const pageIdsRef = useRef<string[]>([newSketchId('page')]);
  /** Stable id-per-stroke. Strokes are stored without ids in memory
   *  (the runtime Stroke type stayed minimal for backward compat);
   *  the id is generated lazily in buildDoc and remembered by
   *  identity via a Map so a re-serialise of an unchanged stroke
   *  emits the same id. */
  const strokeIdsRef = useRef<WeakMap<Stroke, string>>(new WeakMap());
  const textIdsRef = useRef<WeakMap<TextObj, string>>(new WeakMap());
  /** Lasso selection state. `selectedRef` holds the Set of currently-
   *  selected Stroke objects on the current page; `lassoRef` is the
   *  in-flight polyline being dragged; `moveStartRef` is the start
   *  pointer position for a drag-to-move on an existing selection. */
  const selectedRef = useRef<Set<Stroke>>(new Set());
  const lassoRef = useRef<{ x: number; y: number }[] | null>(null);
  const moveStartRef = useRef<{ x: number; y: number } | null>(null);
  /** Active resize transform on the current selection. `handle` is
   *  one of nw / n / ne / w / e / sw / s / se — the bbox handle the
   *  user grabbed. `anchor` is the opposite corner / midpoint that
   *  stays fixed during the resize. `originalBBox` snapshots the
   *  pre-drag bbox so the running ratio is computed relative to it
   *  (mutating the strokes mutates the live bbox too). */
  type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';
  const resizeRef = useRef<{
    handle: ResizeHandle;
    anchor: { x: number; y: number };
    originalBBox: { minX: number; minY: number; maxX: number; maxY: number };
    snapshot: { stroke: Stroke; points: { x: number; y: number; w: number }[] }[];
  } | null>(null);
  /** Active rotation. `pivot` is the selection bbox centre; `start`
   *  is the angle from pivot to the down-point so the running
   *  angle is reported as a delta against it. `snapshot` is the
   *  point coordinates at down-time so a stable rotation can be
   *  reapplied each move (rotating the live points instead would
   *  accumulate floating-point drift visibly). */
  const rotateRef = useRef<{
    pivot: { x: number; y: number };
    startAngle: number;
    snapshot: { stroke: Stroke; points: { x: number; y: number; w: number }[] }[];
  } | null>(null);
  const strokesRef = useRef<Stroke[]>(pagesRef.current[0].strokes);
  const textsRef = useRef<TextObj[]>(pagesRef.current[0].texts);
  /** Aliased to the current page's paper override (or null). redraw
   *  / drawStroke / fitPaperToView read it to resolve the effective
   *  paper settings — `override ?? document-wide` — without needing
   *  pageIndex in a stale closure. */
  const pageOverrideRef = useRef<PagePaperOverride | null>(pagesRef.current[0].paper ?? null);
  const redoRef = useRef<Stroke[]>([]);
  /** Undo/redo across both object kinds. `undoLogRef` records the
   *  kind of each undoable action in chronological order so undo()
   *  reverses the right array (strokes vs texts); `redoLogRef` +
   *  `textRedoRef` are the matching redo side (strokes still reuse
   *  the legacy `redoRef`). An empty log with strokes present falls
   *  back to a plain stroke pop — covers seedDoc-hydrated strokes
   *  that predate the log. */
  const undoLogRef = useRef<('stroke' | 'text')[]>([]);
  const redoLogRef = useRef<('stroke' | 'text')[]>([]);
  const textRedoRef = useRef<TextObj[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  /** Which event family started the current stroke — used to
   *  dedupe so we don't process pointermove AND touchmove for the
   *  same gesture. */
  const activeInputRef = useRef<'pointer' | 'touch' | null>(null);

  const [mounted, setMounted] = useState(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(PALETTE[0]);
  const [widthOverride, setWidthOverride] = useState<number | null>(null);
  /** Per-tool memory of the last colour + width override the user
   *  picked. Switching tools restores that tool's preferences so
   *  the highlighter doesn't surprise the pen with the
   *  highlighter's yellow. */
  const toolPrefsRef = useRef<Partial<Record<Tool, { color?: string; width?: number | null }>>>({});
  /** Per-tool alpha override. Lets the user pull the highlighter
   *  more / less transparent, the pen 100 % opaque, etc. — without
   *  changing the static ToolSpec defaults. */
  const [opacity, setOpacity] = useState<number | null>(null);
  /** Most-recently-used colours, capped at 8. Persisted in
   *  localStorage so the next session restores them. */
  const RECENT_KEY = 'minerva.v2.sketch.recentColors';
  const [recentColors, setRecentColors] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 8) : [];
    } catch { return []; }
  });
  function pushRecentColor(c: string) {
    setRecentColors((prev) => {
      const next = [c, ...prev.filter((x) => x !== c)].slice(0, 8);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }
  const [uploading, setUploading] = useState(false);
  const [debug, setDebug] = useState('idle');
  const [, force] = useState(0);
  /** Which page is currently visible / drawn into. `pageCount`
   *  mirrors `pagesRef.current.length` for the UI to rerender when
   *  pages are added / removed (pagesRef itself is a ref so React
   *  doesn't see length changes). */
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageFormat, setPageFormat] = useState<PageFormat>('auto');
  const [pageBackground, setPageBackground] = useState<PageBackground>('blank');
  const [paperColor, setPaperColor] = useState<PaperColor>('white');
  const [marginGuides, setMarginGuides] = useState(false);
  /** Paper-change scope. `all` (default) edits the document-wide
   *  paper settings; `page` writes an override onto the current
   *  page only ("just change this page"). Resets to `all` each
   *  open — it's a transient editing mode, not a saved preference. */
  const [paperScope, setPaperScope] = useState<'all' | 'page'>('all');
  /** Which grouped settings popover is open, if any. `paper`
   *  collects size / style / surface / margins; `pen` collects
   *  width / opacity / smoothing — the Notes-style pen options.
   *  Only one is open at a time; tapping anywhere else closes it. */
  const [openMenu, setOpenMenu] = useState<'paper' | 'pen' | 'color' | 'shapes' | null>(null);
  /** Active text-tool editing overlay. When set, a <textarea> is
   *  rendered on top of the canvas at the model anchor (x/y); on
   *  iPadOS that textarea is Scribble-enabled, so Apple Pencil
   *  handwriting is recognised on-device. `editIndex` is the index
   *  of an existing text object being re-edited, or null for a new
   *  one. Font size for new text is fixed at TEXT_FONT_SIZE model px. */
  const TEXT_FONT_SIZE = 28;
  const [textEditor, setTextEditor] = useState<
    { x: number; y: number; value: string; editIndex: number | null; color: string; fontSize: number } | null
  >(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  /** Index of the text object currently behind the editing overlay,
   *  or -1. Read by redraw() (a ref, not state, so imperative
   *  redraws right after setTextEditor see the correct value
   *  without waiting for a state flush) to skip drawing the object
   *  twice — the <textarea> is already showing it. */
  const editingTextIndexRef = useRef<number>(-1);
  /** Diagnostic strip in the canvas corner. Off by default — it's
   *  a debugging aid, not something the user needs while drawing —
   *  toggled from the header and persisted in localStorage. */
  const DEBUG_KEY = 'minerva.v2.sketch.debugStrip';
  const [showDebug, setShowDebug] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(DEBUG_KEY, showDebug ? '1' : '0'); } catch { /* ignore */ }
  }, [showDebug]);
  /** Pencil-only mode. When on, finger/touch input is ignored on
   *  the canvas — no drawing AND no pinch-zoom — so a resting palm
   *  or stray finger can't draw or shift the view while the Apple
   *  Pencil is in use. Pen and mouse input are unaffected; zoom is
   *  still available via the toolbar's +/- buttons. Mirrored into a
   *  ref because the native pointer/touch listeners are bound once
   *  per tool change and would otherwise close over a stale value.
   *  Persisted in localStorage. */
  const PEN_ONLY_KEY = 'minerva.v2.sketch.penOnly';
  const [penOnly, setPenOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem(PEN_ONLY_KEY) === '1'; } catch { return false; }
  });
  const penOnlyRef = useRef(penOnly);
  useEffect(() => {
    penOnlyRef.current = penOnly;
    try { localStorage.setItem(PEN_ONLY_KEY, penOnly ? '1' : '0'); } catch { /* ignore */ }
  }, [penOnly]);
  /** Handwriting smoothing level applied on stroke commit. A
   *  windowed moving-average over the point array — wider window
   *  = smoother but less faithful to fast detail. `med` is the
   *  default: enough to kill Pencil jitter without rounding off
   *  intentional sharp corners. Persisted in localStorage. */
  type SmoothLevel = 'none' | 'low' | 'med' | 'high' | 'max';
  const SMOOTH_LEVELS: { id: SmoothLevel; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'low', label: 'Low' },
    { id: 'med', label: 'Med' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
  ];
  const SMOOTH_KEY = 'minerva.v2.sketch.smoothing';
  const [smoothing, setSmoothing] = useState<SmoothLevel>(() => {
    if (typeof window === 'undefined') return 'med';
    try {
      const v = localStorage.getItem(SMOOTH_KEY);
      return (v === 'none' || v === 'low' || v === 'med' || v === 'high' || v === 'max') ? v : 'med';
    } catch { return 'med'; }
  });
  const smoothingRef = useRef<SmoothLevel>(smoothing);
  useEffect(() => {
    smoothingRef.current = smoothing;
    try { localStorage.setItem(SMOOTH_KEY, smoothing); } catch { /* ignore */ }
  }, [smoothing]);
  /** View transform — pan offset + zoom scale, in CSS-px units.
   *  `view_x = tx + scale * model_x`; the redraw applies the
   *  matching transform to the canvas context, and every pointer-
   *  event coord is converted view→model before reaching hit-test
   *  / stroke building. Scale clamped to a sane range so a stray
   *  pinch can't take the user to 1000× zoom. */
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const scaleRef = useRef(scale);
  const txRef = useRef(tx);
  const tyRef = useRef(ty);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { txRef.current = tx; }, [tx]);
  useEffect(() => { tyRef.current = ty; }, [ty]);
  /* Render-state refs. redraw() reads paper format / background /
   * surface colour / margin guides through these refs, not the
   * component-state closures, so imperative redraws fired from
   * frozen closures — the ResizeObserver `sync`, the seed-image
   * onload — always paint with the *current* paper settings. This
   * is the same stale-closure fix already applied to scale/tx/ty:
   * without it, a resize after a paper-format change repainted with
   * the open-time 'auto' format, snapping the canvas back to the
   * full-bleed view and hiding the selection. */
  const pageFormatRef = useRef(pageFormat);
  const pageBackgroundRef = useRef(pageBackground);
  const paperColorRef = useRef(paperColor);
  const marginGuidesRef = useRef(marginGuides);
  useEffect(() => { pageFormatRef.current = pageFormat; }, [pageFormat]);
  useEffect(() => { pageBackgroundRef.current = pageBackground; }, [pageBackground]);
  useEffect(() => { paperColorRef.current = paperColor; }, [paperColor]);
  useEffect(() => { marginGuidesRef.current = marginGuides; }, [marginGuides]);
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;

  /* Mount marker for createPortal — typeof document is undefined
   * during SSR; we only render the portal on the client tick. */
  useEffect(() => setMounted(true), []);

  /* Lock body scroll while open + restore body.pointer-events.
   *
   * Sketch opens almost exclusively from inside a Radix preview
   * dialog, and Radix Dialog sets `body { pointer-events: none }`
   * while it's open as its standard "block the page underneath"
   * behaviour. Our sketch portal is a direct child of <body>, so
   * it inherits that `none`. Result: every tap on the canvas or
   * the toolbar buttons silently dies and the diagnostic strip
   * reports body.pe=none with 0 events arriving.
   *
   * Force-clear pointer-events while the modal is open and restore
   * the prior value on close so Radix can continue managing the
   * parent dialog cleanly. */
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevPe = document.body.style.pointerEvents;
    document.body.style.overflow = 'hidden';
    document.body.style.pointerEvents = '';
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.pointerEvents = prevPe;
    };
  }, [open]);

  /* Sync the strokesRef / bgImageRef aliases to the current page
   * whenever pageIndex changes. The rest of the file (pointer
   * handlers, undo/redo/clear, save/export, debug strip) reads
   * those refs directly, so this single effect is the only place
   * page-switching logic needs to live. Resets redo history on
   * switch — redo doesn't cross page boundaries. */
  useEffect(() => {
    if (!open) return;
    const page = pagesRef.current[pageIndex];
    if (!page) return;
    strokesRef.current = page.strokes;
    textsRef.current = page.texts;
    pageOverrideRef.current = page.paper ?? null;
    bgImageRef.current = page.bg;
    redoRef.current = [];
    undoLogRef.current = [];
    redoLogRef.current = [];
    textRedoRef.current = [];
    drawingRef.current = null;
    activeInputRef.current = null;
    setTextEditor(null);
    // Selection + lasso state is per-page — switching pages clears
    // them so the lasso highlight from page 1 doesn't ghost over
    // page 2's strokes.
    selectedRef.current.clear();
    lassoRef.current = null;
    moveStartRef.current = null;
    redraw();
    force((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, open]);

  /* Tool change clears the editing selection — picking the pen
   * tool while strokes are selected is implicitly "I'm done with
   * those" and stale selection halo would distract from the new
   * drawing. Lasso state is also wiped so a half-drawn polyline
   * doesn't persist after switching away. */
  useEffect(() => {
    if (tool !== 'lasso' && selectedRef.current.size > 0) {
      selectedRef.current.clear();
      lassoRef.current = null;
      moveStartRef.current = null;
      redraw();
      force((n) => n + 1);
    }
    // Restore the picked-tool's last-used colour + width override
    // from per-tool memory. A first switch to a tool with no prior
    // prefs leaves the current settings as the defaults.
    const prefs = toolPrefsRef.current[tool];
    if (prefs) {
      if (typeof prefs.color === 'string') setColor(prefs.color);
      if (prefs.width !== undefined) setWidthOverride(prefs.width);
    }
    // Opacity resets to "tool default" on every tool switch so
    // changing tools doesn't drag the highlighter's alpha into the
    // pen, for instance.
    setOpacity(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /* Mirror the current colour + width into the tool-prefs map so
   * the next tool switch and back restores them. Runs after every
   * change to colour, width, or tool. */
  useEffect(() => {
    toolPrefsRef.current[tool] = {
      ...toolPrefsRef.current[tool],
      color,
      width: widthOverride,
    };
  }, [tool, color, widthOverride]);

  /* Render state that lives outside the imperative draw path —
   * paper format, page-style background, the view transform —
   * needs to trigger a redraw when it changes. Without this,
   * picking a Style from the dropdown updates the state but the
   * canvas keeps showing the old pattern until the next stroke
   * (or next close/reopen), which reads as "the dropdown does
   * nothing." */
  useEffect(() => {
    if (!open) return;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageBackground, pageFormat, scale, tx, ty, paperColor, marginGuides, open]);

  /** Imperative "fit the current paper format into the viewport".
   *  Runs on open, on every paper-format change (see the effect
   *  below), and on demand via the toolbar's Fit button. Centring
   *  the new page is the whole point — without it, picking a new
   *  size leaves the page rendered at the previous format's view
   *  transform, off-screen, reading as "the picker did nothing".
   *  Fits the *effective* format for the current page: a per-page
   *  size override wins over the document-wide `pageFormat`. Pass
   *  `explicitFormat` when the new value isn't in state yet (the
   *  document-wide setter is async). */
  function fitPaperToView(explicitFormat?: PageFormat) {
    const effFormat: PageFormat = explicitFormat
      ?? (pagesRef.current[pageIndex]?.paper?.size as PageFormat | undefined)
      ?? pageFormat;
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const viewW = c.clientWidth || c.width / dpr;
    const viewH = c.clientHeight || c.height / dpr;

    // Pick what to fit: the paper rect when a format is set, else
    // the bounding box of every stroke + text on the current page
    // (auto-mode "fit to content"). With no content either, fall
    // through to resetView — the previous always-reset behaviour
    // for an empty auto-mode canvas.
    let fitW = 0;
    let fitH = 0;
    let fitX = 0;
    let fitY = 0;
    const fmt = effFormat !== 'auto'
      ? PAGE_FORMATS.find((f) => f.id === effFormat && f.pxW > 0 && f.pxH > 0)
      : null;
    if (fmt) {
      fitW = fmt.pxW;
      fitH = fmt.pxH;
      fitX = 0;
      fitY = 0;
    } else {
      const pts: { x: number; y: number }[] = [];
      for (const s of strokesRef.current) for (const p of s.points) pts.push({ x: p.x, y: p.y });
      for (const t of textsRef.current) {
        // Texts have no width metric in their stored shape, so we
        // approximate with fontSize × length × 0.6 (rough average
        // glyph advance) — close enough for a one-tap "fit it".
        const w = t.text ? t.fontSize * 0.6 * Math.max(...t.text.split('\n').map((ln) => ln.length)) : 0;
        const h = t.text ? t.fontSize * 1.25 * t.text.split('\n').length : 0;
        pts.push({ x: t.x, y: t.y });
        pts.push({ x: t.x + w, y: t.y + h });
      }
      const bb = polylineBBox(pts);
      if (bb && (bb.maxX > bb.minX || bb.maxY > bb.minY)) {
        const pad = 24; // model-space padding around the content
        fitX = bb.minX - pad;
        fitY = bb.minY - pad;
        fitW = (bb.maxX - bb.minX) + 2 * pad;
        fitH = (bb.maxY - bb.minY) + 2 * pad;
      } else {
        // Empty auto-mode canvas — nothing to fit; just reset.
        resetView();
        return;
      }
    }

    const fit = Math.min((viewW * 0.9) / fitW, (viewH * 0.9) / fitH);
    const fitScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit));
    const centerTx = (viewW - fitScale * fitW) / 2 - fitScale * fitX;
    const centerTy = (viewH - fitScale * fitH) / 2 - fitScale * fitY;
    setScale(fitScale);
    setTx(centerTx);
    setTy(centerTy);
    scaleRef.current = fitScale;
    txRef.current = centerTx;
    tyRef.current = centerTy;
    redraw();
  }

  /* Fit the paper into the viewport on open, on every document-wide
   * format change, and on page switch (a page may carry its own
   * size override). Fitting only once (the old behaviour) left
   * later format changes rendering at the previous format's view
   * transform — off-screen, looking like the picker did nothing.
   * `auto` resets to the identity (full-bleed) view. */
  useEffect(() => {
    if (!open) return;
    fitPaperToView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageFormat, pageIndex, open]);

  /** Apply a paper property change, honouring `paperScope`.
   *  `all` updates the document-wide setting AND drops that
   *  property from every page's override, so the change is truly
   *  universal. `page` writes the property onto the current page's
   *  override only ("just change this page"). Either way: re-fit on
   *  a size change, redraw, persist. */
  function setPaperProp(
    prop: 'size' | 'background' | 'surface' | 'margins',
    value: PageFormat | PageBackground | PaperColor | boolean,
  ) {
    if (paperScope === 'page') {
      const page = pagesRef.current[pageIndex];
      if (page) {
        const next: PagePaperOverride = { ...(page.paper ?? {}) };
        (next as Record<string, unknown>)[prop] = value;
        page.paper = next;
        pageOverrideRef.current = next;
      }
    } else {
      if (prop === 'size') setPageFormat(value as PageFormat);
      else if (prop === 'background') setPageBackground(value as PageBackground);
      else if (prop === 'surface') setPaperColor(value as PaperColor);
      else if (prop === 'margins') setMarginGuides(value as boolean);
      for (const p of pagesRef.current) {
        if (p.paper && prop in p.paper) {
          const rest: PagePaperOverride = { ...p.paper };
          delete rest[prop];
          p.paper = Object.keys(rest).length > 0 ? rest : undefined;
        }
      }
      pageOverrideRef.current = pagesRef.current[pageIndex]?.paper ?? null;
    }
    // 'page' scope: state didn't change, so fit from the new
    // override. 'all' scope: the state setter is async — pass the
    // value explicitly so the fit doesn't lag a render behind.
    if (prop === 'size') fitPaperToView(value as PageFormat);
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }

  /* Canvas size, DPR, redraw on open + seed image load. */
  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!c || !wrap) return;

    // Hydrate from `seedDoc` when present — every previously-saved
    // stroke comes back as an editable Stroke object on its
    // original page. Page ids and per-stroke ids carry over so the
    // next autosave produces a stable diff (the same id keeps the
    // same line). Falls back to a single blank page when no
    // seedDoc; the PNG `seed` (legacy back-compat) is loaded as
    // page 0's background below.
    if (seedDoc && seedDoc.pages && seedDoc.pages.length > 0) {
      pagesRef.current = seedDoc.pages.map((p) => ({
        strokes: (p.objects || [])
          .filter((o): o is SketchDocStroke => o.type === 'stroke')
          .map(docStrokeToStroke),
        texts: (p.objects || [])
          .filter((o): o is SketchDocText => o.type === 'text')
          .map(docTextToText),
        bg: null,
        // Per-page paper override carries over verbatim — the
        // runtime shape is exactly Partial<SketchDocPaper>.
        paper: p.paper && Object.keys(p.paper).length > 0 ? { ...p.paper } : undefined,
      }));
      pageIdsRef.current = seedDoc.pages.map((p) => p.id);
      setPageCount(seedDoc.pages.length);
      setPageFormat(docSizeToPaper(seedDoc.paper?.size ?? 'auto'));
      setPageBackground(((seedDoc.paper?.background as PageBackground) ?? 'blank'));
      // Surface colour + margin guide are document-wide paper props,
      // persisted alongside size/background — restore them so the
      // sketch reopens looking exactly as the user left it.
      setPaperColor(((seedDoc.paper?.surface as PaperColor) ?? 'white'));
      setMarginGuides(seedDoc.paper?.margins ?? false);
    } else {
      pagesRef.current = [{ strokes: [], texts: [], bg: null }];
      pageIdsRef.current = [newSketchId('page')];
      setPageCount(1);
      setPageFormat('auto');
      setPageBackground('blank');
      setPaperColor('white');
      setMarginGuides(false);
    }
    // Reset the view transform on every open so the user starts at
    // 100% zoom + no pan — predictable starting state.
    setScale(1);
    setTx(0);
    setTy(0);
    scaleRef.current = 1;
    txRef.current = 0;
    tyRef.current = 0;
    setPageIndex(0);
    setTextEditor(null);
    setPaperScope('all');
    strokesRef.current = pagesRef.current[0].strokes;
    textsRef.current = pagesRef.current[0].texts;
    pageOverrideRef.current = pagesRef.current[0].paper ?? null;
    redoRef.current = [];
    undoLogRef.current = [];
    redoLogRef.current = [];
    textRedoRef.current = [];
    bgImageRef.current = null;
    drawingRef.current = null;
    activeInputRef.current = null;

    const sync = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = wrap.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
      c.style.width = rect.width + 'px';
      c.style.height = rect.height + 'px';
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        redraw();
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    window.addEventListener('resize', sync);

    let blobUrl: string | null = null;
    // Load the PNG `seed` as page 0's background ONLY when there is
    // no vector `seedDoc`. With a seedDoc the strokes are hydrated
    // as real editable vectors; also painting the PNG snapshot
    // underneath them drew every stroke twice (a faint doubled
    // ghost) and is pure legacy back-compat for pre-vector saves.
    const hasVectorDoc = !!(seedDoc && seedDoc.pages && seedDoc.pages.length > 0);
    if (seed && !hasVectorDoc) {
      const useBlobLoad = seed.startsWith('/');
      (async () => {
        try {
          let src = seed;
          if (useBlobLoad) {
            const r = await fetch(seed);
            if (!r.ok) throw new Error(`seed: ${r.status}`);
            const blob = await r.blob();
            src = URL.createObjectURL(blob);
            blobUrl = src;
          }
          const img = new Image();
          img.onload = () => {
            // Seed lives on page 0 — owned by the page so switching
            // pages and back restores it cleanly via the alias-sync
            // effect. Page 0 is also the current page on open, so
            // mirror to bgImageRef now for immediate redraw.
            pagesRef.current[0].bg = img;
            bgImageRef.current = img;
            redraw();
            force((n) => n + 1);
          };
          img.onerror = () => { bgImageRef.current = null; force((n) => n + 1); };
          img.src = src;
        } catch {
          bgImageRef.current = null;
          force((n) => n + 1);
        }
      })();
    }
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  /* Native input listeners — the heart of the iPad fix. */
  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;

    const widthFor = (basePressure: number, pointerType: string): number => {
      if (widthOverride != null) return widthOverride;
      const spec = getToolSpec(tool);
      if (tool === 'pen' && pointerType === 'pen' && basePressure > 0) {
        return spec.minWidth + (spec.maxWidth - spec.minWidth) * Math.max(0.1, basePressure);
      }
      // The tool's natural default for non-pressure inputs (mouse,
      // finger) and non-pen tools.
      return spec.defaultWidth;
    };

    const rectOf = () => c.getBoundingClientRect();
    /** Convert a client (viewport) point to MODEL coordinates by
     *  reversing the view-transform (pan + zoom). Strokes, hit-
     *  tests, lasso polygons all live in model space so they stay
     *  pixel-stable across zoom changes. */
    const toModel = (clientX: number, clientY: number) => {
      const r = rectOf();
      const vx = clientX - r.left;
      const vy = clientY - r.top;
      return {
        x: (vx - txRef.current) / scaleRef.current,
        y: (vy - tyRef.current) / scaleRef.current,
      };
    };

    const beginStroke = (clientX: number, clientY: number, pressure: number, ptype: string, tx?: number, ty?: number) => {
      const { x, y } = toModel(clientX, clientY);
      const spec = getToolSpec(tool);
      const firstPoint: Point = { x, y, w: widthFor(pressure, ptype) };
      if (typeof tx === 'number') firstPoint.tx = tx;
      if (typeof ty === 'number') firstPoint.ty = ty;
      drawingRef.current = {
        tool,
        color: tool === 'eraser' ? '#000' : color,
        // User-set opacity overrides the tool's default alpha.
        // Lets the user push the highlighter more / less
        // transparent without redefining the tool itself.
        alpha: typeof opacity === 'number' ? opacity : spec.alpha,
        points: [firstPoint],
      };
      // Any new stroke invalidates redo history (both sides).
      redoRef.current = [];
      redoLogRef.current = [];
      textRedoRef.current = [];
      setDebug(`down · ${ptype} · p=${pressure.toFixed(2)}`);
      redraw();
      force((n) => n + 1);
    };
    const continueStroke = (clientX: number, clientY: number, pressure: number, ptype: string, tx?: number, ty?: number) => {
      if (!drawingRef.current) return;
      const { x: nx, y: ny } = toModel(clientX, clientY);
      const pts = drawingRef.current.points;
      // Line tool: replace the SECOND point on every move so the
      // stroke stays as a straight segment from down-point to current.
      // The user sees a live preview as they drag; release commits
      // exactly two points (anchor + tip) — perfect ruler-line.
      // 2-point shape tools (line / rect / ellipse / arrow) all
      // share the same gesture: down = anchor, move = update
      // endpoint, up = commit. Renderer derives the shape from
      // the two stored points.
      const shapeTool = drawingRef.current.tool;
      if (isShapeTool(shapeTool)) {
        const pt: Point = { x: nx, y: ny, w: widthFor(pressure, ptype) };
        if (typeof tx === 'number') pt.tx = tx;
        if (typeof ty === 'number') pt.ty = ty;
        if (pts.length === 1) pts.push(pt);
        else pts[1] = pt;
        setDebug(`${shapeTool} · ${ptype} · pts=2`);
        redraw();
        return;
      }
      // Drop noise: Pencil fires ~120 Hz so successive samples may
      // land sub-pixel apart. The threshold is in MODEL units so a
      // zoom-in lets the user lay finer points without the filter
      // killing them. 2 px at scale=1; 1 px at scale=2 (zoom-in); etc.
      const noiseThresh = 2 / scaleRef.current;
      if (pts.length > 0) {
        const last = pts[pts.length - 1];
        const dx = nx - last.x;
        const dy = ny - last.y;
        if (dx * dx + dy * dy < noiseThresh * noiseThresh) return;
      }
      const pt: Point = { x: nx, y: ny, w: widthFor(pressure, ptype) };
      if (typeof tx === 'number') pt.tx = tx;
      if (typeof ty === 'number') pt.ty = ty;
      pts.push(pt);
      setDebug(`move · ${ptype} · p=${pressure.toFixed(2)} · pts=${pts.length}`);
      redraw();
    };
    const endStroke = (ptype: string) => {
      if (!drawingRef.current) return;
      const finished = drawingRef.current;
      // Handwriting refinement: a windowed moving-average smoothing
      // pass over the committed point array. Skipped for the 2-point
      // shape tools (line / rect / ellipse / arrow — they're already
      // mathematically exact) and for `none`. Endpoints are kept
      // anchored so the stroke doesn't visibly shrink at the tips.
      const sm = smoothingRef.current;
      const isShape = isShapeTool(finished.tool);
      if (!isShape && sm !== 'none' && finished.points.length >= 3) {
        // window half-width per level; `max` also runs a second
        // pass so high-frequency Pencil jitter is fully ironed out.
        const win = sm === 'low' ? 1 : sm === 'med' ? 2 : sm === 'high' ? 3 : 4;
        const passes = sm === 'max' ? 2 : 1;
        const smoothPass = (src: Point[]): Point[] => src.map((p, i) => {
          if (i === 0 || i === src.length - 1) return { ...p };
          let sx = 0, sy = 0, sw = 0, n = 0;
          for (let k = Math.max(0, i - win); k <= Math.min(src.length - 1, i + win); k++) {
            sx += src[k].x; sy += src[k].y; sw += src[k].w; n++;
          }
          const np: Point = { x: sx / n, y: sy / n, w: sw / n };
          if (typeof p.tx === 'number') np.tx = p.tx;
          if (typeof p.ty === 'number') np.ty = p.ty;
          return np;
        });
        let out = finished.points;
        for (let pass = 0; pass < passes; pass++) out = smoothPass(out);
        finished.points = out;
      }
      strokesRef.current.push(finished);
      undoLogRef.current.push('stroke');
      drawingRef.current = null;
      setDebug(`up · ${ptype} · strokes=${strokesRef.current.length}`);
      redraw();
      force((n) => n + 1);
      // Autosave hook — caller PATCHes the vector doc to PG. Fired
      // on every pointerup so a crash mid-session loses at most one
      // partial stroke. The caller is responsible for single-flight.
      if (onAutoSave) onAutoSave(buildDoc());
    };

    // ----- Editing-tool handlers -----------------------------------

    /** Hit-test threshold in CSS px. A 10 px halo around the
     *  rendered stroke is generous on touch + Pencil without
     *  bleeding into adjacent lines. */
    const HIT_THRESHOLD_VIEW_PX = 16;
    /** Local helper for editing-tool handlers — same view→model
     *  reverse-transform as `toModel`, just named for the editing
     *  context (lasso / obj-eraser / move-drag) where the coord
     *  meaning is "where on the page did the user point." */
    const localXY = (clientX: number, clientY: number) => toModel(clientX, clientY);

    const pickStrokeAt = (px: number, py: number): Stroke | null => {
      // Hit halo in MODEL units = view px / scale, so the tap halo
      // stays ~10 screen-px regardless of zoom level.
      const halo_view = HIT_THRESHOLD_VIEW_PX;
      const halo_model = halo_view / scaleRef.current;
      const list = strokesRef.current;
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        const strokeHalo = halo_model + (s.points.reduce((a, p) => a + p.w, 0) / Math.max(1, s.points.length)) / 2;
        if (distanceToPolyline(px, py, s.points) <= strokeHalo) return s;
      }
      return null;
    };

    const eraseAt = (px: number, py: number): boolean => {
      const hit = pickStrokeAt(px, py);
      if (!hit) return false;
      const idx = strokesRef.current.indexOf(hit);
      if (idx >= 0) strokesRef.current.splice(idx, 1);
      selectedRef.current.delete(hit);
      return true;
    };

    /** Bounding box of every currently-selected stroke. Used to
     *  decide whether a pointerdown in lasso mode starts a move
     *  (down-point inside the bbox) or a new lasso (outside). */
    const selectionBBox = () => {
      const all: { x: number; y: number }[] = [];
      for (const s of selectedRef.current) {
        for (const p of s.points) all.push({ x: p.x, y: p.y });
      }
      return polylineBBox(all);
    };

    // ----- Pointer dispatch by tool --------------------------------

    const downEditing = (clientX: number, clientY: number) => {
      const { x, y } = localXY(clientX, clientY);
      if (tool === 'obj-eraser') {
        if (eraseAt(x, y)) {
          redraw();
          force((n) => n + 1);
          if (onAutoSave) onAutoSave(buildDoc());
        }
        return;
      }
      if (tool === 'lasso') {
        const bb = selectionBBox();
        if (bb && selectedRef.current.size > 0) {
          // Handle hit-test FIRST. Handles sit ~10 model px outside
          // the bbox; the hit halo is ~12 view-px wide so they're
          // tappable with a finger / Pencil.
          const haloModel = 12 / scaleRef.current;
          const pad = 10 / scaleRef.current;
          const handles: { id: ResizeHandle; cx: number; cy: number }[] = [
            { id: 'nw', cx: bb.minX - pad, cy: bb.minY - pad },
            { id: 'n',  cx: (bb.minX + bb.maxX) / 2, cy: bb.minY - pad },
            { id: 'ne', cx: bb.maxX + pad, cy: bb.minY - pad },
            { id: 'w',  cx: bb.minX - pad, cy: (bb.minY + bb.maxY) / 2 },
            { id: 'e',  cx: bb.maxX + pad, cy: (bb.minY + bb.maxY) / 2 },
            { id: 'sw', cx: bb.minX - pad, cy: bb.maxY + pad },
            { id: 's',  cx: (bb.minX + bb.maxX) / 2, cy: bb.maxY + pad },
            { id: 'se', cx: bb.maxX + pad, cy: bb.maxY + pad },
          ];
          const hit = handles.find((h) => Math.hypot(x - h.cx, y - h.cy) <= haloModel);
          if (hit) {
            // Anchor = opposite handle's centre. Sub-frame fast-path
            // by case so we don't compute all 8 again.
            const anchor = (() => {
              switch (hit.id) {
                case 'nw': return { x: bb.maxX, y: bb.maxY };
                case 'n':  return { x: (bb.minX + bb.maxX) / 2, y: bb.maxY };
                case 'ne': return { x: bb.minX, y: bb.maxY };
                case 'w':  return { x: bb.maxX, y: (bb.minY + bb.maxY) / 2 };
                case 'e':  return { x: bb.minX, y: (bb.minY + bb.maxY) / 2 };
                case 'sw': return { x: bb.maxX, y: bb.minY };
                case 's':  return { x: (bb.minX + bb.maxX) / 2, y: bb.minY };
                case 'se': return { x: bb.minX, y: bb.minY };
              }
            })();
            const snapshot = Array.from(selectedRef.current).map((s) => ({
              stroke: s,
              points: s.points.map((p) => ({ x: p.x, y: p.y, w: p.w })),
            }));
            resizeRef.current = { handle: hit.id, anchor, originalBBox: bb, snapshot };
            return;
          }
          // Rotation handle: ~24 model-px above the n-handle.
          const rotR = 24 / scaleRef.current;
          const rotCx = (bb.minX + bb.maxX) / 2;
          const rotCy = bb.minY - pad - rotR;
          if (Math.hypot(x - rotCx, y - rotCy) <= haloModel) {
            const pivot = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
            const snapshot = Array.from(selectedRef.current).map((s) => ({
              stroke: s,
              points: s.points.map((p) => ({ x: p.x, y: p.y, w: p.w })),
            }));
            rotateRef.current = {
              pivot,
              startAngle: Math.atan2(y - pivot.y, x - pivot.x),
              snapshot,
            };
            return;
          }
          // Inside the bbox = move-drag (existing behaviour).
          if (x >= bb.minX - 6 && x <= bb.maxX + 6 && y >= bb.minY - 6 && y <= bb.maxY + 6) {
            moveStartRef.current = { x, y };
            return;
          }
        }
        // Otherwise clear selection and start a new lasso polyline.
        selectedRef.current.clear();
        lassoRef.current = [{ x, y }];
        redraw();
        force((n) => n + 1);
      }
    };

    const moveEditing = (clientX: number, clientY: number) => {
      const { x, y } = localXY(clientX, clientY);
      if (tool === 'obj-eraser') {
        if (eraseAt(x, y)) {
          redraw();
          force((n) => n + 1);
        }
        return;
      }
      if (tool === 'lasso') {
        if (resizeRef.current) {
          // Compute scale factor from the anchor (opposite handle).
          // Each axis independently so the user can pinch only one
          // dimension via a side handle. The snapshot points are
          // re-projected each move so floating-point drift can't
          // accumulate across many move events.
          const r = resizeRef.current;
          const o = r.originalBBox;
          const aw = r.anchor.x;
          const ah = r.anchor.y;
          // Per-axis effective sign: which side of the anchor the
          // user is dragging. Skip axes the handle doesn't touch
          // (e.g. 'n' is vertical-only).
          let sx = 1;
          let sy = 1;
          if (r.handle === 'nw' || r.handle === 'w' || r.handle === 'sw') {
            const dxOrig = o.minX - aw;
            const dxNow = x - aw;
            sx = dxOrig !== 0 ? dxNow / dxOrig : 1;
          } else if (r.handle === 'ne' || r.handle === 'e' || r.handle === 'se') {
            const dxOrig = o.maxX - aw;
            const dxNow = x - aw;
            sx = dxOrig !== 0 ? dxNow / dxOrig : 1;
          }
          if (r.handle === 'nw' || r.handle === 'n' || r.handle === 'ne') {
            const dyOrig = o.minY - ah;
            const dyNow = y - ah;
            sy = dyOrig !== 0 ? dyNow / dyOrig : 1;
          } else if (r.handle === 'sw' || r.handle === 's' || r.handle === 'se') {
            const dyOrig = o.maxY - ah;
            const dyNow = y - ah;
            sy = dyOrig !== 0 ? dyNow / dyOrig : 1;
          }
          // Clamp to a minimum scale so the user can't flip the
          // selection inside-out by dragging past the anchor.
          if (Math.abs(sx) < 0.05) sx = sx < 0 ? -0.05 : 0.05;
          if (Math.abs(sy) < 0.05) sy = sy < 0 ? -0.05 : 0.05;
          for (const snap of r.snapshot) {
            for (let i = 0; i < snap.points.length; i++) {
              const op = snap.points[i];
              const np = snap.stroke.points[i];
              np.x = aw + (op.x - aw) * sx;
              np.y = ah + (op.y - ah) * sy;
              // Stroke widths scale with the average of |sx|, |sy|
              // so a 2x resize doubles line thickness — feels right.
              np.w = op.w * (Math.abs(sx) + Math.abs(sy)) / 2;
            }
          }
          redraw();
          return;
        }
        if (rotateRef.current) {
          const r = rotateRef.current;
          const angleNow = Math.atan2(y - r.pivot.y, x - r.pivot.x);
          const delta = angleNow - r.startAngle;
          const cosA = Math.cos(delta);
          const sinA = Math.sin(delta);
          for (const snap of r.snapshot) {
            for (let i = 0; i < snap.points.length; i++) {
              const op = snap.points[i];
              const np = snap.stroke.points[i];
              const dx = op.x - r.pivot.x;
              const dy = op.y - r.pivot.y;
              np.x = r.pivot.x + dx * cosA - dy * sinA;
              np.y = r.pivot.y + dx * sinA + dy * cosA;
              np.w = op.w;
            }
          }
          redraw();
          return;
        }
        if (moveStartRef.current) {
          const dx = x - moveStartRef.current.x;
          const dy = y - moveStartRef.current.y;
          // Translate every selected stroke's points by the delta.
          // The points array is mutated in place — keeps the alias
          // bound to pagesRef and avoids reallocating per-frame.
          for (const s of selectedRef.current) {
            for (const p of s.points) { p.x += dx; p.y += dy; }
          }
          moveStartRef.current = { x, y };
          redraw();
          return;
        }
        if (lassoRef.current) {
          // Lasso noise filter — looser than drawing's (0.5 model
          // px) so a quick small loop still captures enough points
          // for a meaningful polygon. Scales inversely with zoom
          // for the same reason the drawing filter does.
          const last = lassoRef.current[lassoRef.current.length - 1];
          if (last) {
            const ddx = x - last.x;
            const ddy = y - last.y;
            const minDist = 0.5 / scaleRef.current;
            if (ddx * ddx + ddy * ddy < minDist * minDist) return;
          }
          lassoRef.current.push({ x, y });
          redraw();
        }
      }
    };

    const upEditing = () => {
      if (tool === 'obj-eraser') {
        // Autosave after a swipe-erase gesture so a fast wipe
        // produces one PATCH at the end rather than per-deleted-stroke.
        if (onAutoSave) onAutoSave(buildDoc());
        return;
      }
      if (tool === 'lasso') {
        if (resizeRef.current) {
          resizeRef.current = null;
          if (onAutoSave) onAutoSave(buildDoc());
          return;
        }
        if (rotateRef.current) {
          rotateRef.current = null;
          if (onAutoSave) onAutoSave(buildDoc());
          return;
        }
        if (moveStartRef.current) {
          moveStartRef.current = null;
          if (onAutoSave) onAutoSave(buildDoc());
          return;
        }
        if (lassoRef.current) {
          const polygon = lassoRef.current;
          lassoRef.current = null;
          // ≥2 points + a non-zero bbox is enough to imply a swept
          // path; 3 was too strict and discarded the common
          // quick-flick selection where the user drags briefly
          // across a few strokes.
          const bb = polylineBBox(polygon);
          const swept = bb && (bb.maxX - bb.minX > 4 / scaleRef.current || bb.maxY - bb.minY > 4 / scaleRef.current);
          if (polygon.length >= 2 && swept) {
            // A stroke is selected when EITHER:
            //  (a) it's enclosed — any of its points falls inside
            //      the lasso polygon (the loop-around gesture), OR
            //  (b) it's crossed — any lasso vertex lands within a
            //      ~14 view-px halo of the stroke's polyline (the
            //      scribble-across gesture, which has near-zero
            //      enclosed area so (a) alone would miss it).
            const crossHalo = 14 / scaleRef.current;
            for (const s of strokesRef.current) {
              const enclosed = s.points.some((p) => pointInPolygon(p.x, p.y, polygon));
              const crossed = !enclosed && polygon.some((lp) => distanceToPolyline(lp.x, lp.y, s.points) <= crossHalo);
              if (enclosed || crossed) {
                selectedRef.current.add(s);
              }
            }
          }
          redraw();
          force((n) => n + 1);
        }
      }
    };

    // --- Pointer Events (pen + mouse + most touch on modern browsers)
    const onPointerDown = (e: PointerEvent) => {
      // Pencil-only mode: ignore finger/touch entirely (pen + mouse
      // still draw). Stops a resting palm or stray finger.
      if (penOnlyRef.current && e.pointerType === 'touch') return;
      if (activeInputRef.current === 'touch') return; // touch path already engaged
      // Text tool: a tap doesn't draw — it places / re-opens a text
      // editing overlay. Handled on pointerup so a stray micro-drag
      // doesn't matter; nothing to do on down.
      if (tool === 'text') { e.preventDefault(); return; }
      activeInputRef.current = 'pointer';
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* old Safari */ }
      if (tool === 'obj-eraser' || tool === 'lasso') {
        downEditing(e.clientX, e.clientY);
        return;
      }
      const p = e.pressure > 0 ? e.pressure : (e.pointerType === 'pen' ? 0.5 : 1);
      beginStroke(e.clientX, e.clientY, p, e.pointerType, e.tiltX, e.tiltY);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (tool === 'text') return;
      if (activeInputRef.current !== 'pointer') return;
      e.preventDefault();
      if (tool === 'obj-eraser' || tool === 'lasso') {
        moveEditing(e.clientX, e.clientY);
        return;
      }
      if (!drawingRef.current) return;
      // Coalesced events — iPad Pencil at 120 Hz often delivers two
      // or three sub-frame samples that the browser batches into a
      // single pointermove. Iterating them gives a noticeably
      // smoother curve at the cost of a few more points per stroke.
      // Falls back to the singleton event on platforms without the
      // API (Chrome on Linux is rolling support, Safari has it).
      let events: PointerEvent[];
      if (typeof e.getCoalescedEvents === 'function') {
        const ce = e.getCoalescedEvents();
        events = ce.length > 0 ? ce : [e];
      } else {
        events = [e];
      }
      for (const ev of events) {
        const p = ev.pressure > 0 ? ev.pressure : (ev.pointerType === 'pen' ? 0.5 : 1);
        continueStroke(ev.clientX, ev.clientY, p, ev.pointerType, ev.tiltX, ev.tiltY);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (penOnlyRef.current && e.pointerType === 'touch') return;
      if (tool === 'text') {
        // Finger taps are handled by onTouchEnd; pen + mouse here.
        // Without this split, a finger tap fires both paths and
        // opens the editor twice.
        if (e.pointerType === 'touch') return;
        e.preventDefault();
        const { x, y } = toModel(e.clientX, e.clientY);
        openTextEditor(x, y, pickTextAt(x, y));
        activeInputRef.current = null;
        return;
      }
      if (activeInputRef.current !== 'pointer') return;
      try { c.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      if (tool === 'obj-eraser' || tool === 'lasso') {
        upEditing();
      } else {
        endStroke(e.pointerType);
      }
      activeInputRef.current = null;
    };

    // --- Two-finger pinch/pan state. When two touches are active
    // we suspend drawing and translate / scale the view. End of
    // pinch (back to ≤1 touch) clears the state and the next 1-
    // finger gesture starts a fresh stroke.
    let pinch: { d: number; midX: number; midY: number } | null = null;
    const dist = (a: Touch, b: Touch) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const midpoint = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    // --- Touch Events fallback (iOS Safari < 13, and the cases
    // where pointer events mysteriously don't fire for the first
    // tap on a fresh canvas)
    const onTouchStart = (e: TouchEvent) => {
      // Pencil-only mode: finger touches do nothing — no drawing,
      // and no two-finger pinch-zoom. Toolbar +/- still zooms.
      if (penOnlyRef.current) return;
      if (activeInputRef.current === 'pointer') return;
      e.preventDefault();
      if (e.touches.length >= 2) {
        // Two-finger pinch starts — bail out of any in-flight stroke
        // and switch to view-transform mode.
        drawingRef.current = null;
        activeInputRef.current = 'touch';
        const t1 = e.touches[0], t2 = e.touches[1];
        const m = midpoint(t1, t2);
        pinch = { d: dist(t1, t2), midX: m.x, midY: m.y };
        return;
      }
      activeInputRef.current = 'touch';
      const t = e.touches[0];
      if (!t) return;
      // Text tool: placement happens on touchend (same as the
      // pointer path). Nothing to begin here.
      if (tool === 'text') return;
      if (tool === 'obj-eraser' || tool === 'lasso') {
        downEditing(t.clientX, t.clientY);
        return;
      }
      const pressure = typeof t.force === 'number' && t.force > 0 ? t.force : 0.5;
      beginStroke(t.clientX, t.clientY, pressure, 'touch');
    };
    const onTouchMove = (e: TouchEvent) => {
      if (penOnlyRef.current) return;
      e.preventDefault();
      // Two-finger pinch+pan path. Mid-point pin: the model point
      // under the current pinch midpoint should stay under the new
      // pinch midpoint after the transform updates. Combines zoom-
      // around-pinch-center with pan in one math.
      if (pinch && e.touches.length >= 2) {
        const t1 = e.touches[0], t2 = e.touches[1];
        const nd = dist(t1, t2);
        const m = midpoint(t1, t2);
        const r = c.getBoundingClientRect();
        const prevMidX = pinch.midX - r.left;
        const prevMidY = pinch.midY - r.top;
        const curMidX = m.x - r.left;
        const curMidY = m.y - r.top;
        // Scale change ratio. Clamp the resulting scale.
        const desired = (scaleRef.current * nd) / Math.max(1, pinch.d);
        const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, desired));
        // The pinch midpoint at time of last move corresponded to
        // model (mx, my). After updating scale we want the new
        // midpoint to map to that same (mx, my) → solve for new
        // tx, ty. Then add the pan delta (curMid - prevMid) so the
        // two-finger drag also translates.
        const mx = (prevMidX - txRef.current) / scaleRef.current;
        const my = (prevMidY - tyRef.current) / scaleRef.current;
        const newTx = curMidX - newScale * mx;
        const newTy = curMidY - newScale * my;
        setScale(newScale);
        setTx(newTx);
        setTy(newTy);
        scaleRef.current = newScale;
        txRef.current = newTx;
        tyRef.current = newTy;
        pinch = { d: nd, midX: m.x, midY: m.y };
        redraw();
        return;
      }
      if (tool === 'text') return;
      if (activeInputRef.current !== 'touch') return;
      const t = e.touches[0];
      if (!t) return;
      if (tool === 'obj-eraser' || tool === 'lasso') {
        moveEditing(t.clientX, t.clientY);
        return;
      }
      const pressure = typeof t.force === 'number' && t.force > 0 ? t.force : 0.5;
      continueStroke(t.clientX, t.clientY, pressure, 'touch');
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (penOnlyRef.current) return;
      e.preventDefault();
      if (pinch) {
        // End of pinch when we drop below 2 touches; the remaining
        // one (if any) DOES NOT auto-resume drawing — Apple Notes
        // semantics. The user lifts both, then starts fresh.
        if (e.touches.length < 2) pinch = null;
        if (e.touches.length === 0) activeInputRef.current = null;
        return;
      }
      if (tool === 'text') {
        const t = e.changedTouches[0];
        if (t) {
          const { x, y } = toModel(t.clientX, t.clientY);
          openTextEditor(x, y, pickTextAt(x, y));
        }
        activeInputRef.current = null;
        return;
      }
      if (activeInputRef.current !== 'touch') return;
      if (tool === 'obj-eraser' || tool === 'lasso') {
        upEditing();
      } else {
        endStroke('touch');
      }
      activeInputRef.current = null;
    };

    // --- Mouse-wheel zoom (desktop). Zooms around the cursor —
    // same midpoint-pin math as pinch, just with a single point
    // (the cursor). Negative deltaY = zoom in, positive = zoom out.
    const onWheel = (e: WheelEvent) => {
      // Modifier-free wheel scrolls the page normally; require Ctrl
      // (or Meta on macOS) to engage zoom. Matches Figma / Miro.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scaleRef.current * factor));
      const mx = (px - txRef.current) / scaleRef.current;
      const my = (py - tyRef.current) / scaleRef.current;
      const newTx = px - newScale * mx;
      const newTy = py - newScale * my;
      setScale(newScale);
      setTx(newTx);
      setTy(newTy);
      scaleRef.current = newScale;
      txRef.current = newTx;
      tyRef.current = newTy;
      redraw();
    };

    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerUp);
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove',  onTouchMove,  { passive: false });
    c.addEventListener('touchend',   onTouchEnd,   { passive: false });
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('touchcancel', onTouchEnd,  { passive: false });

    return () => {
      c.removeEventListener('pointerdown', onPointerDown);
      c.removeEventListener('pointermove', onPointerMove);
      c.removeEventListener('pointerup', onPointerUp);
      c.removeEventListener('pointercancel', onPointerUp);
      c.removeEventListener('touchstart', onTouchStart);
      c.removeEventListener('touchmove', onTouchMove);
      c.removeEventListener('touchend', onTouchEnd);
      c.removeEventListener('touchcancel', onTouchEnd);
      c.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool, color, widthOverride]);

  function redraw() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // Read the view transform from the refs, not component state.
    // redraw() is invoked from closures captured once on open (the
    // ResizeObserver `sync`, the seed-image onload), which would
    // otherwise paint with the stale tx/ty/scale from that render
    // while the pointer handlers' `toModel` uses the live refs —
    // producing a cursor/stroke offset after any zoom/fit followed
    // by a layout-triggered resize. The refs are kept in lockstep
    // with state, so reading them here is always correct.
    const scale = scaleRef.current;
    const tx = txRef.current;
    const ty = tyRef.current;
    // Likewise read the paper settings from refs — same stale-
    // closure hazard as the transform above. The current page's
    // override (if any) wins over the document-wide value.
    const ov = pageOverrideRef.current;
    const pageFormat = (ov?.size as PageFormat | undefined) ?? pageFormatRef.current;
    const pageBackground = (ov?.background as PageBackground | undefined) ?? pageBackgroundRef.current;
    const paperColor = (ov?.surface as PaperColor | undefined) ?? paperColorRef.current;
    const marginGuides = ov?.margins ?? marginGuidesRef.current;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale(dpr, dpr);
    // View-transform — pan + zoom. Applied AFTER the DPR scale so
    // tx/ty/scale read in CSS px / model units. Strokes / lasso /
    // selection halos / background pattern all render in model
    // space below this transform, so changing scale is pixel-stable.
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    // Resolve the paper colour once — it now applies in EVERY mode,
    // not just when a paper format is set. In `auto` mode it fills
    // the whole visible canvas (full light/dark control without
    // touching the app theme); with a format it fills the paper
    // rect. `paper.ink` ('dark' on light paper, 'light' on dark
    // paper) drives the pattern + border + margin colours so they
    // always contrast.
    const paper = PAPER_COLORS.find((p) => p.id === paperColor) ?? PAPER_COLORS[0];
    const paperFmtDraw = pageFormat !== 'auto'
      ? PAGE_FORMATS.find((f) => f.id === pageFormat && f.pxW > 0 && f.pxH > 0)
      : null;
    {
      const viewW0 = c.clientWidth || c.width / dpr;
      const viewH0 = c.clientHeight || c.height / dpr;
      ctx.save();
      ctx.fillStyle = paper.fill;
      if (paperFmtDraw) {
        ctx.fillRect(0, 0, paperFmtDraw.pxW, paperFmtDraw.pxH);
        ctx.strokeStyle = paper.ink === 'light' ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1 / scale;
        ctx.strokeRect(0, 0, paperFmtDraw.pxW, paperFmtDraw.pxH);
        if (marginGuides) {
          const mx = paperFmtDraw.pxW * 0.05;
          const my = paperFmtDraw.pxH * 0.05;
          ctx.setLineDash([6 / scale, 4 / scale]);
          ctx.strokeStyle = paper.ink === 'light' ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)';
          ctx.strokeRect(mx, my, paperFmtDraw.pxW - 2 * mx, paperFmtDraw.pxH - 2 * my);
        }
      } else {
        // Auto mode — fill the entire visible model region with the
        // paper colour. Extend generously so panning doesn't expose
        // an unfilled edge.
        const fxMin = -tx / scale - viewW0;
        const fyMin = -ty / scale - viewH0;
        const fw = (viewW0 / scale) + 2 * viewW0;
        const fh = (viewH0 / scale) + 2 * viewH0;
        ctx.fillRect(fxMin, fyMin, fw, fh);
      }
      ctx.restore();
    }
    if (pageBackground !== 'blank') {
      // Pattern bounds: clip to the paper rectangle when a non-auto
      // format is set (the pattern represents lines on a sheet of
      // paper; it shouldn't bleed past the page edges). Otherwise
      // fill the visible model area derived from the inverse
      // transform.
      const viewW = c.clientWidth || c.width / dpr;
      const viewH = c.clientHeight || c.height / dpr;
      let mxMin: number, mxMax: number, myMin: number, myMax: number;
      const paperFmt = pageFormat !== 'auto' ? PAGE_FORMATS.find((f) => f.id === pageFormat) : null;
      if (paperFmt && paperFmt.pxW > 0 && paperFmt.pxH > 0) {
        mxMin = 0;
        myMin = 0;
        mxMax = paperFmt.pxW;
        myMax = paperFmt.pxH;
      } else {
        mxMin = -tx / scale;
        mxMax = (viewW - tx) / scale;
        myMin = -ty / scale;
        myMax = (viewH - ty) / scale;
      }
      // Line width in MODEL units so the rendered line stays ~1
      // view-px regardless of zoom level.
      const linePxModel = 1 / scale;
      ctx.save();
      // Pattern ink derives from the PAPER colour, not the app
      // theme — dark ink on light paper, light ink on dark paper —
      // so the lines are always visible. Bumped from 0.10 to 0.22
      // so the pattern reads clearly on white paper (the old value
      // was barely perceptible).
      const onDarkPaper = paper.ink === 'light';
      const lineColor = onDarkPaper ? 'rgba(220,220,228,0.22)' : 'rgba(40,40,50,0.22)';
      const dotColor = onDarkPaper ? 'rgba(220,220,228,0.34)' : 'rgba(40,40,50,0.34)';
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = linePxModel;
      const snapStart = (min: number, pitch: number) => Math.ceil(min / pitch) * pitch;
      if (pageBackground === 'lined') {
        const pitch = 28;
        for (let y = snapStart(myMin, pitch); y <= myMax; y += pitch) {
          ctx.beginPath();
          ctx.moveTo(mxMin, y);
          ctx.lineTo(mxMax, y);
          ctx.stroke();
        }
      } else if (pageBackground === 'grid' || pageBackground === 'graph') {
        const pitch = pageBackground === 'graph' ? 16 : 32;
        for (let x = snapStart(mxMin, pitch); x <= mxMax; x += pitch) {
          ctx.beginPath();
          ctx.moveTo(x, myMin);
          ctx.lineTo(x, myMax);
          ctx.stroke();
        }
        for (let y = snapStart(myMin, pitch); y <= myMax; y += pitch) {
          ctx.beginPath();
          ctx.moveTo(mxMin, y);
          ctx.lineTo(mxMax, y);
          ctx.stroke();
        }
      } else if (pageBackground === 'dotted') {
        ctx.fillStyle = dotColor;
        const pitch = 24;
        const r = 1 / scale;
        for (let y = snapStart(myMin, pitch); y <= myMax; y += pitch) {
          for (let x = snapStart(mxMin, pitch); x <= mxMax; x += pitch) {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }
    if (bgImageRef.current) {
      // Background image lives at canvas-origin model coords —
      // fits the *initial* CSS viewport on first open (scale=1).
      // After zoom/pan, it stays anchored to model space so the
      // user can zoom in on it like any other content.
      const cw = c.clientWidth || c.width / dpr;
      const ch = c.clientHeight || c.height / dpr;
      const iw = bgImageRef.current.naturalWidth;
      const ih = bgImageRef.current.naturalHeight;
      const r = Math.min(cw / iw, ch / ih);
      const w = iw * r;
      const h = ih * r;
      ctx.drawImage(bgImageRef.current, (cw - w) / 2, (ch - h) / 2, w, h);
    }
    // Strokes layer — rendered onto an offscreen canvas so the
    // pixel eraser's `destination-out` punches holes through ink
    // only. The paper / pattern / bg image painted above on the
    // main canvas stay intact and show through the erased pixels.
    {
      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
      }
      const off = offscreenCanvasRef.current;
      if (off.width !== c.width || off.height !== c.height) {
        off.width = c.width;
        off.height = c.height;
      }
      const octx = off.getContext('2d');
      if (octx) {
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, off.width, off.height);
        octx.scale(dpr, dpr);
        octx.translate(tx, ty);
        octx.scale(scale, scale);
        for (const s of strokesRef.current) drawStroke(octx, s);
        if (drawingRef.current) drawStroke(octx, drawingRef.current);
        // Composite the strokes layer onto the main canvas. Reset
        // the main ctx transform to draw the offscreen at raw
        // pixel (0,0); restoring afterwards puts the view
        // transform back so later text / selection / lasso draw
        // in model space as before.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(off, 0, 0);
        ctx.restore();
      }
    }
    // Typed-text objects render above strokes, in model space (the
    // ctx is already pan/zoom-transformed). The one being live-
    // edited is skipped — the <textarea> overlay is showing it
    // instead, so drawing it here too would double it.
    for (let ti = 0; ti < textsRef.current.length; ti++) {
      if (editingTextIndexRef.current === ti) continue;
      const t = textsRef.current[ti];
      if (!t.text) continue;
      ctx.save();
      ctx.fillStyle = t.color;
      ctx.font = `${t.fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      t.text.split('\n').forEach((ln, li) => {
        ctx.fillText(ln, t.x, t.y + li * t.fontSize * 1.25);
      });
      ctx.restore();
    }
    // Selection highlight — a 2 px translucent-blue outline drawn
    // beneath each selected stroke. Sits in screen coordinates so a
    // tiny sub-pixel stroke is still visibly tagged.
    if (selectedRef.current.size > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)';
      ctx.lineWidth = 3 / scale; // stay ~3 view-px regardless of zoom
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of selectedRef.current) {
        if (s.points.length === 0) continue;
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x, s.points[i].y);
        }
        ctx.stroke();
      }
      const bb = polylineBBox(
        Array.from(selectedRef.current).flatMap((s) => s.points.map((p) => ({ x: p.x, y: p.y }))),
      );
      if (bb) {
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
        ctx.lineWidth = 1 / scale;
        const pad = 4 / scale;
        ctx.strokeRect(bb.minX - pad, bb.minY - pad, (bb.maxX - bb.minX) + 2 * pad, (bb.maxY - bb.minY) + 2 * pad);
        // 8 resize handles + 1 rotation handle, drawn as small
        // filled circles in MODEL coords but sized in view-px so
        // they stay tappable at any zoom.
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
        ctx.lineWidth = 1.5 / scale;
        const handleR = 5 / scale;
        const handlePad = 10 / scale;
        const positions: [number, number][] = [
          [bb.minX - handlePad, bb.minY - handlePad],
          [(bb.minX + bb.maxX) / 2, bb.minY - handlePad],
          [bb.maxX + handlePad, bb.minY - handlePad],
          [bb.minX - handlePad, (bb.minY + bb.maxY) / 2],
          [bb.maxX + handlePad, (bb.minY + bb.maxY) / 2],
          [bb.minX - handlePad, bb.maxY + handlePad],
          [(bb.minX + bb.maxX) / 2, bb.maxY + handlePad],
          [bb.maxX + handlePad, bb.maxY + handlePad],
        ];
        for (const [hx, hy] of positions) {
          ctx.beginPath();
          ctx.arc(hx, hy, handleR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        // Rotation handle: a circle 24 view-px above the top edge,
        // joined to the bbox by a short stem.
        const rotR = 24 / scale;
        const rotCx = (bb.minX + bb.maxX) / 2;
        const rotCy = bb.minY - handlePad - rotR;
        ctx.beginPath();
        ctx.moveTo(rotCx, bb.minY - handlePad);
        ctx.lineTo(rotCx, rotCy + handleR);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rotCx, rotCy, handleR + 1 / scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    if (lassoRef.current && lassoRef.current.length > 0) {
      ctx.save();
      ctx.setLineDash([5 / scale, 4 / scale]);
      ctx.strokeStyle = 'rgba(234, 88, 12, 0.85)';
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      ctx.moveTo(lassoRef.current[0].x, lassoRef.current[0].y);
      for (let i = 1; i < lassoRef.current.length; i++) {
        ctx.lineTo(lassoRef.current[i].x, lassoRef.current[i].y);
      }
      // Auto-close: draw the implied closing segment back to the
      // start, lighter, so the user sees the region the lasso will
      // actually enclose (pointInPolygon closes the polygon too).
      if (lassoRef.current.length > 2) {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(lassoRef.current[lassoRef.current.length - 1].x, lassoRef.current[lassoRef.current.length - 1].y);
        ctx.lineTo(lassoRef.current[0].x, lassoRef.current[0].y);
        ctx.strokeStyle = 'rgba(234, 88, 12, 0.4)';
        ctx.stroke();
      } else {
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    if (s.points.length === 0) return;
    ctx.save();
    if (s.tool === 'eraser') {
      // True pixel erase: punch transparent holes through the
      // strokes layer with `destination-out`. The caller (redraw)
      // routes eraser strokes onto the offscreen strokes canvas,
      // so this never touches paper / pattern / bg image — those
      // live on the main canvas underneath the composited layer
      // and remain visible through the punched-out pixels.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
    }
    if (s.points.length === 1) {
      const p = s.points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (s.points.length === 2) {
      const [a, b] = s.points;
      ctx.lineWidth = (a.w + b.w) / 2;
      // Rectangle: stroke the bounding rect derived from the two
      // anchor points. The user drags from one corner to another.
      if (s.tool === 'rect') {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
        return;
      }
      // Ellipse: parametric, inscribed in the same bounding rect.
      if (s.tool === 'ellipse') {
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const rx = Math.abs(b.x - a.x) / 2;
        const ry = Math.abs(b.y - a.y) / 2;
        ctx.beginPath();
        // ctx.ellipse handles the parametric draw cleanly with
        // built-in arc subdivision — much smoother than sampling.
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return;
      }
      // Arrow: a line from a to b plus a filled arrowhead at b.
      // Head size scales with the stroke width so a thick arrow
      // gets a proportionally thicker tip.
      if (s.tool === 'arrow') {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const headLen = Math.max(8, ctx.lineWidth * 3);
        const headW = headLen * 0.6;
        // Tip end-point pulled back slightly so the arrowhead's
        // base meets the shaft cleanly without overshooting.
        const ux = dx / len;
        const uy = dy / len;
        const tipX = b.x;
        const tipY = b.y;
        const baseX = tipX - ux * headLen;
        const baseY = tipY - uy * headLen;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(baseX, baseY);
        ctx.stroke();
        // Arrowhead: filled triangle (tip, left-base, right-base).
        const px = -uy;
        const py = ux;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX + px * headW / 2, baseY + py * headW / 2);
        ctx.lineTo(baseX - px * headW / 2, baseY - py * headW / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        return;
      }
      // Polygon shapes — triangle / diamond / hexagon / star. Each
      // derives its vertices from the bounding rect of the two
      // anchor points, then strokes one closed path.
      if (s.tool === 'triangle' || s.tool === 'diamond' || s.tool === 'star' || s.tool === 'hexagon') {
        const minX = Math.min(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxX = Math.max(a.x, b.x);
        const maxY = Math.max(a.y, b.y);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const rx = (maxX - minX) / 2;
        const ry = (maxY - minY) / 2;
        let pts: { x: number; y: number }[];
        if (s.tool === 'triangle') {
          pts = [{ x: cx, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
        } else if (s.tool === 'diamond') {
          pts = [{ x: cx, y: minY }, { x: maxX, y: cy }, { x: cx, y: maxY }, { x: minX, y: cy }];
        } else if (s.tool === 'hexagon') {
          pts = [];
          for (let i = 0; i < 6; i++) {
            const ang = -Math.PI / 2 + (i * Math.PI) / 3;
            pts.push({ x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) });
          }
        } else {
          // 5-point star: alternating outer (bbox) / inner radius.
          pts = [];
          for (let i = 0; i < 10; i++) {
            const ang = -Math.PI / 2 + (i * Math.PI) / 5;
            const f = i % 2 === 0 ? 1 : 0.4;
            pts.push({ x: cx + rx * f * Math.cos(ang), y: cy + ry * f * Math.sin(ang) });
          }
        }
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
        return;
      }
      // Plain line (and any other 2-point fallback).
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      return;
    }
    // Smoothing strategy depends on whether the tool has alpha < 1.
    //
    // For OPAQUE tools (pen, alpha=1, eraser) we render each
    // Catmull-Rom segment as its own bezierCurveTo() so the line
    // width can taper segment-to-segment with pressure variation —
    // this is what gives the pen its inky feel.
    //
    // For TRANSLUCENT tools (highlighter alpha=0.35, marker 0.6,
    // pencil 0.85, line) each per-segment stroke() composites against
    // the previous: a 0.35-alpha join overlaps the adjacent
    // 0.35-alpha segment and the visible pixel ends up at
    // 1 − (1 − 0.35)² ≈ 0.58 — visibly darker than the rest of the
    // stroke. The fix is to emit one continuous path: a single
    // beginPath() → many bezierCurveTo() → one stroke() composites
    // exactly once, no joins darker than the body. We trade per-
    // segment width variation (acceptable for uniform-width tools).
    const widthAt = (i: number): number => {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(s.points.length - 1, i + 2); k++) {
        sum += s.points[k].w;
        count += 1;
      }
      return sum / count;
    };
    const isUniformWidth = s.tool === 'highlighter' || s.tool === 'marker' || s.tool === 'pencil' || s.tool === 'line';
    if (isUniformWidth) {
      const avgW = s.points.reduce((a, p) => a + p.w, 0) / s.points.length;
      ctx.lineWidth = avgW;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 0; i < s.points.length - 1; i++) {
        const p0 = s.points[Math.max(0, i - 1)];
        const p1 = s.points[i];
        const p2 = s.points[i + 1];
        const p3 = s.points[Math.min(s.points.length - 1, i + 2)];
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
      }
      ctx.stroke();
    } else {
      for (let i = 0; i < s.points.length - 1; i++) {
        const p0 = s.points[Math.max(0, i - 1)];
        const p1 = s.points[i];
        const p2 = s.points[i + 1];
        const p3 = s.points[Math.min(s.points.length - 1, i + 2)];
        // Catmull-Rom → cubic Bezier control points (tension 0.5,
        // the classic centripetal-style smoothing factor).
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        ctx.lineWidth = (widthAt(i) + widthAt(i + 1)) / 2;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function undo() {
    const kind = undoLogRef.current.pop();
    if (kind === 'text') {
      const t = textsRef.current.pop();
      if (t) { textRedoRef.current.push(t); redoLogRef.current.push('text'); }
    } else {
      // 'stroke' — or undefined (empty log): fall back to a stroke
      // pop so seedDoc-hydrated strokes are still undoable.
      const popped = strokesRef.current.pop();
      if (popped) { redoRef.current.push(popped); redoLogRef.current.push('stroke'); }
    }
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  function redo() {
    const kind = redoLogRef.current.pop();
    if (kind === 'text') {
      const t = textRedoRef.current.pop();
      if (t) { textsRef.current.push(t); undoLogRef.current.push('text'); }
    } else {
      const popped = redoRef.current.pop();
      if (popped) { strokesRef.current.push(popped); undoLogRef.current.push('stroke'); }
    }
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  function clearAll() {
    // Confirm before destroying everything on the current page —
    // undo would only step back stroke-by-stroke on a giant
    // multi-hundred-stroke page, so a misclick on Clear is
    // expensive. Skip the confirm when there's nothing to clear.
    if (strokesRef.current.length === 0 && textsRef.current.length === 0 && !bgImageRef.current) return;
    if (typeof window !== 'undefined' && !window.confirm(
      `Clear all ${strokesRef.current.length} stroke${strokesRef.current.length === 1 ? '' : 's'} on this page?`
    )) return;
    // Mutate in place so the alias from pagesRef stays bound — a
    // fresh [] would orphan the page object's strokes array and
    // subsequent pushes would land in the alias-only array,
    // disappearing on the next page switch.
    strokesRef.current.length = 0;
    textsRef.current.length = 0;
    redoRef.current.length = 0;
    undoLogRef.current.length = 0;
    redoLogRef.current.length = 0;
    textRedoRef.current.length = 0;
    drawingRef.current = null;
    editingTextIndexRef.current = -1;
    setTextEditor(null);
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }

  // ----- Text tool ----------------------------------------------

  /** Open the text editing overlay. `mx`/`my` are model coords.
   *  When `index` is given the existing text object is re-edited;
   *  otherwise a new object is staged at the tapped point. */
  function openTextEditor(mx: number, my: number, index: number | null) {
    let next: { x: number; y: number; value: string; editIndex: number | null; color: string; fontSize: number };
    if (index !== null) {
      const t = textsRef.current[index];
      if (!t) return;
      editingTextIndexRef.current = index;
      next = { x: t.x, y: t.y, value: t.text, editIndex: index, color: t.color, fontSize: t.fontSize };
    } else {
      editingTextIndexRef.current = -1;
      next = { x: mx, y: my, value: '', editIndex: null, color, fontSize: TEXT_FONT_SIZE };
    }
    // flushSync so the <textarea> is mounted + positioned *before*
    // we focus it. The focus() call must run synchronously inside
    // the triggering pointer/touch gesture — iOS Safari only raises
    // the keyboard for a focus() made during a user gesture, and a
    // deferred setTimeout focus (the old approach) silently failed
    // on iPad: the box appeared but couldn't be typed into.
    flushSync(() => setTextEditor(next));
    redraw();
    textEditorRef.current?.focus();
  }

  /** Commit (or discard) the text editing overlay. Empty text is
   *  dropped — both for a brand-new object and for an existing one
   *  the user cleared (cleared text = delete the object). */
  function commitTextEditor() {
    const ed = textEditor;
    if (!ed) return;
    const value = ed.value.trim();
    if (ed.editIndex !== null) {
      const t = textsRef.current[ed.editIndex];
      if (t) {
        if (value) {
          t.text = value;
        } else {
          textsRef.current.splice(ed.editIndex, 1);
        }
      }
    } else if (value) {
      textsRef.current.push({ x: ed.x, y: ed.y, text: value, fontSize: ed.fontSize, color: ed.color });
      // New text object — log it for undo, invalidate redo history.
      undoLogRef.current.push('text');
      redoRef.current = [];
      redoLogRef.current = [];
      textRedoRef.current = [];
    }
    editingTextIndexRef.current = -1;
    setTextEditor(null);
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }

  /** Hit-test the text objects on the current page — returns the
   *  topmost index whose rendered box contains the model point, or
   *  null. Used so tapping an existing text re-opens it for editing
   *  instead of stacking a new one on top. */
  function pickTextAt(mx: number, my: number): number | null {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d') ?? null;
    for (let i = textsRef.current.length - 1; i >= 0; i--) {
      const t = textsRef.current[i];
      const lines = t.text.split('\n');
      const lineH = t.fontSize * 1.25;
      const h = Math.max(lineH, lines.length * lineH);
      let w = t.fontSize * 4;
      if (ctx) {
        ctx.save();
        ctx.font = `${t.fontSize}px ui-sans-serif, system-ui, sans-serif`;
        w = Math.max(...lines.map((ln) => ctx.measureText(ln).width), 8);
        ctx.restore();
      }
      const pad = 6;
      if (mx >= t.x - pad && mx <= t.x + w + pad && my >= t.y - pad && my <= t.y + h + pad) {
        return i;
      }
    }
    return null;
  }

  // ----- Multi-page navigation ----------------------------------

  /** Commit any in-flight stroke to the page before switching so a
   *  partially-drawn line isn't lost on a page change mid-gesture. */
  function commitInFlight() {
    if (drawingRef.current) {
      strokesRef.current.push(drawingRef.current);
      drawingRef.current = null;
    }
  }
  function goToPage(idx: number) {
    if (idx < 0 || idx >= pagesRef.current.length) return;
    commitInFlight();
    setPageIndex(idx);
  }
  /** Delete every stroke currently in selectedRef. Used by the
   *  contextual selection toolbar that appears under the lasso. */
  function deleteSelection() {
    if (selectedRef.current.size === 0) return;
    const survive: Stroke[] = [];
    for (const s of strokesRef.current) {
      if (!selectedRef.current.has(s)) survive.push(s);
    }
    strokesRef.current.length = 0;
    for (const s of survive) strokesRef.current.push(s);
    selectedRef.current.clear();
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  /** Duplicate every selected stroke at a small offset; the new
   *  copies become the new selection so the user can drag them
   *  straight away without an extra tap. */
  function duplicateSelection() {
    if (selectedRef.current.size === 0) return;
    const OFFSET = 16;
    const fresh: Stroke[] = [];
    for (const s of selectedRef.current) {
      fresh.push({
        tool: s.tool,
        color: s.color,
        alpha: s.alpha,
        points: s.points.map((p) => ({ x: p.x + OFFSET, y: p.y + OFFSET, w: p.w })),
      });
    }
    for (const f of fresh) strokesRef.current.push(f);
    selectedRef.current = new Set(fresh);
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }

  function addPage() {
    commitInFlight();
    pagesRef.current.push({ strokes: [], texts: [], bg: null });
    pageIdsRef.current.push(newSketchId('page'));
    setPageCount(pagesRef.current.length);
    setPageIndex(pagesRef.current.length - 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  /** Programmatic zoom around the canvas centre. Used by the
   *  toolbar's +/- pills; the same midpoint-pin math is in the
   *  inline wheel handler but lives there because it needs the
   *  cursor position. */
  function zoomBy(factor: number) {
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const px = r.width / 2;
    const py = r.height / 2;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scaleRef.current * factor));
    const mx = (px - txRef.current) / scaleRef.current;
    const my = (py - tyRef.current) / scaleRef.current;
    const newTx = px - newScale * mx;
    const newTy = py - newScale * my;
    setScale(newScale);
    setTx(newTx);
    setTy(newTy);
    scaleRef.current = newScale;
    txRef.current = newTx;
    tyRef.current = newTy;
    redraw();
  }
  function resetView() {
    setScale(1);
    setTx(0);
    setTy(0);
    scaleRef.current = 1;
    txRef.current = 0;
    tyRef.current = 0;
    redraw();
  }

  function deleteCurrentPage() {
    if (pagesRef.current.length <= 1) {
      // Last page — clear it instead of removing the document.
      clearAll();
      return;
    }
    commitInFlight();
    pagesRef.current.splice(pageIndex, 1);
    pageIdsRef.current.splice(pageIndex, 1);
    setPageCount(pagesRef.current.length);
    // Stay on the same visual slot, or step back if we deleted the
    // last page. The alias-sync effect handles the rebind.
    setPageIndex(Math.max(0, Math.min(pageIndex, pagesRef.current.length - 1)));
    if (onAutoSave) onAutoSave(buildDoc());
  }

  /** Duplicate the current page — clones the strokes (deep-copy of
   *  each point), inserts the clone right after the current page,
   *  and switches to it. The clone gets a fresh page id so the
   *  next autosave persists both. */
  function duplicateCurrentPage() {
    commitInFlight();
    const cur = pagesRef.current[pageIndex];
    if (!cur) return;
    const clone: SketchPage = {
      strokes: cur.strokes.map((s) => ({
        tool: s.tool,
        color: s.color,
        alpha: s.alpha,
        points: s.points.map((p) => ({ ...p })),
      })),
      texts: cur.texts.map((t) => ({ ...t })),
      bg: cur.bg,
      paper: cur.paper ? { ...cur.paper } : undefined,
    };
    pagesRef.current.splice(pageIndex + 1, 0, clone);
    pageIdsRef.current.splice(pageIndex + 1, 0, newSketchId('page'));
    setPageCount(pagesRef.current.length);
    setPageIndex(pageIndex + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  /** Reorder the current page by one slot. dir=-1 moves it left,
   *  dir=+1 moves it right. No-op at the ends. Selection / lasso
   *  state is wiped via the alias-sync effect, which fires when
   *  pageIndex changes. */
  function movePage(dir: -1 | 1) {
    const from = pageIndex;
    const to = from + dir;
    if (to < 0 || to >= pagesRef.current.length) return;
    commitInFlight();
    const p = pagesRef.current.splice(from, 1)[0];
    const id = pageIdsRef.current.splice(from, 1)[0];
    pagesRef.current.splice(to, 0, p);
    pageIdsRef.current.splice(to, 0, id);
    setPageIndex(to);
    if (onAutoSave) onAutoSave(buildDoc());
  }

  /** Build a SketchDoc snapshot of the current editor state. The
   *  doc carries stable per-stroke + per-page ids so a subsequent
   *  autosave emits the same id for an unchanged stroke (PG patch
   *  stays diffable, future per-object operations can address by
   *  id). The `documentId` is filled from the caller's prop —
   *  typically the row id. */
  function buildDoc(): SketchDoc {
    const idFor = (s: Stroke): string => {
      let id = strokeIdsRef.current.get(s);
      if (!id) {
        id = newSketchId('stroke');
        strokeIdsRef.current.set(s, id);
      }
      return id;
    };
    const idForText = (t: TextObj): string => {
      let id = textIdsRef.current.get(t);
      if (!id) {
        id = newSketchId('stroke');
        textIdsRef.current.set(t, id);
      }
      return id;
    };
    const pages: SketchDocPage[] = pagesRef.current.map((page, i) => ({
      id: pageIdsRef.current[i] || newSketchId('page'),
      objects: [
        ...page.strokes.map((s) => strokeToDocStroke(s, idFor(s))),
        ...page.texts.map((t) => textToDocText(t, idForText(t))),
      ],
      // Persist the per-page paper override only when it actually
      // holds something — keeps the doc clean for the common case.
      ...(page.paper && Object.keys(page.paper).length > 0 ? { paper: { ...page.paper } } : {}),
    }));
    return {
      schemaVersion: 1,
      documentId: documentId || 'sketch',
      paper: {
        size: paperToDocSize(pageFormat),
        background: pageBackground,
        surface: paperColor,
        margins: marginGuides,
      },
      pages,
    };
  }

  // Cmd-Z / Cmd-Shift-Z / Esc keyboard shortcuts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { void closeWithSave(); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) &&  e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ----- Save / Export -------------------------------------------

  function canvasSizeCss(): { w: number; h: number } {
    const c = canvasRef.current;
    if (!c) return { w: 800, h: 600 };
    return {
      w: c.clientWidth || c.width / (window.devicePixelRatio || 1),
      h: c.clientHeight || c.height / (window.devicePixelRatio || 1),
    };
  }
  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Persist + close. There is no explicit Save button: strokes
   *  autosave to the vector doc on every pointerup (`onAutoSave`),
   *  so closing only needs to flush the PNG thumbnail the row
   *  preview renders. Nothing is confirmed and nothing is cleared —
   *  reopening rehydrates from the autosaved vector doc. */
  async function closeWithSave() {
    const c = canvasRef.current;
    if (!c) { onClose(); return; }
    const hasAny = strokesRef.current.length > 0
      || textsRef.current.length > 0
      || !!bgImageRef.current
      || pagesRef.current.some((p) => p.strokes.length > 0 || p.texts.length > 0 || !!p.bg);
    if (!hasAny) { onClose(); return; }
    setUploading(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `sketch-${stamp}.png`;
      if (saveMode === 'inline') {
        // Bytes go straight into row.data — no upload.
        onSaved(c.toDataURL('image/png'), name);
      } else {
        const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'));
        if (blob) {
          const fd = new FormData();
          fd.append('file', blob, name);
          fd.append('name', name);
          fd.append('kind', 'misc');
          const r = await fetch('/api/drive/upload', { method: 'POST', body: fd });
          const j = (await r.json().catch(() => ({}))) as { fileId?: string; error?: string };
          if (r.ok && j.fileId) onSaved(`/api/drive/file?id=${encodeURIComponent(j.fileId)}`, name);
        }
      }
      const otherPagesWithContent = pagesRef.current.reduce(
        (n, p, i) => n + (i !== pageIndex && (p.strokes.length > 0 || p.texts.length > 0 || !!p.bg) ? 1 : 0),
        0,
      );
      if (otherPagesWithContent > 0) {
        toast.success(`Saved (preview is the current page — use Export → PDF for all ${otherPagesWithContent + 1}).`);
      }
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setUploading(false);
      onClose();
    }
  }

  async function exportSvg() {
    if (strokesRef.current.length === 0 && textsRef.current.length === 0 && !bgImageRef.current) {
      notify.error('Sketch is empty.'); return;
    }
    const { w, h } = canvasSizeCss();
    const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`];
    parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
    if (bgImageRef.current) {
      try {
        const off = document.createElement('canvas');
        off.width = bgImageRef.current.naturalWidth;
        off.height = bgImageRef.current.naturalHeight;
        const octx = off.getContext('2d');
        if (octx) {
          octx.drawImage(bgImageRef.current, 0, 0);
          const dataUrl = off.toDataURL('image/png');
          const iw = bgImageRef.current.naturalWidth;
          const ih = bgImageRef.current.naturalHeight;
          const r = Math.min(w / iw, h / ih);
          parts.push(`<image href="${dataUrl}" x="${(w - iw * r) / 2}" y="${(h - ih * r) / 2}" width="${iw * r}" height="${ih * r}"/>`);
        }
      } catch { /* tainted — skip */ }
    }
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      const avg = s.points.reduce((a, p) => a + p.w, 0) / s.points.length;
      const stroke = s.tool === 'eraser' ? '#ffffff' : s.color;
      if (s.points.length === 1) {
        const p = s.points[0];
        parts.push(`<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(avg / 2).toFixed(2)}" fill="${stroke}" fill-opacity="${s.alpha}"/>`);
        continue;
      }
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="${s.alpha}" stroke-width="${avg.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    const esc = (str: string) => str.replace(/[&<>"]/g, (ch) => (
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'
    ));
    for (const t of textsRef.current) {
      if (!t.text) continue;
      t.text.split('\n').forEach((ln, li) => {
        parts.push(
          `<text x="${t.x.toFixed(2)}" y="${(t.y + t.fontSize * (li + 0.8)).toFixed(2)}" ` +
          `font-family="ui-sans-serif, system-ui, sans-serif" font-size="${t.fontSize}" ` +
          `fill="${t.color}">${esc(ln)}</text>`,
        );
      });
    }
    parts.push('</svg>');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(new Blob([parts.join('')], { type: 'image/svg+xml' }), `sketch-${stamp}.svg`);
    toast.success('SVG downloaded.');
  }

  async function exportPdf() {
    const totalPages = pagesRef.current.length;
    const hasAnything = pagesRef.current.some((p) => p.strokes.length > 0 || p.texts.length > 0 || p.bg);
    if (!hasAnything) {
      notify.error('Sketch is empty.'); return;
    }
    // PDF dimensions: when the user picked a standard paper format
    // every page gets those dimensions; `auto` uses the current
    // canvas aspect ratio (back-compat with the single-page flow).
    const { w: canvasW, h: canvasH } = canvasSizeCss();
    const fmt = PAGE_FORMATS.find((f) => f.id === pageFormat) ?? PAGE_FORMATS[0];
    const pageW = fmt.pxW > 0 ? fmt.pxW : canvasW;
    const pageH = fmt.pxH > 0 ? fmt.pxH : canvasH;
    const pdf = new jsPDF({
      orientation: pageW >= pageH ? 'l' : 'p',
      unit: 'px',
      format: [pageW, pageH],
      hotfixes: ['px_scaling'],
    });
    pdf.setLineCap('round'); pdf.setLineJoin('round');

    // Each page from pagesRef becomes a PDF page. Strokes were
    // drawn against the canvas coordinate system (canvasW x canvasH);
    // scale them to the PDF page so the layout reads the same.
    const sx = pageW / canvasW;
    const sy = pageH / canvasH;
    for (let i = 0; i < totalPages; i++) {
      if (i > 0) pdf.addPage([pageW, pageH], pageW >= pageH ? 'l' : 'p');
      const page = pagesRef.current[i];
      if (page.bg) {
        try {
          const off = document.createElement('canvas');
          off.width = page.bg.naturalWidth;
          off.height = page.bg.naturalHeight;
          const octx = off.getContext('2d');
          if (octx) {
            octx.drawImage(page.bg, 0, 0);
            const dataUrl = off.toDataURL('image/png');
            const iw = page.bg.naturalWidth;
            const ih = page.bg.naturalHeight;
            const r = Math.min(pageW / iw, pageH / ih);
            pdf.addImage(dataUrl, 'PNG', (pageW - iw * r) / 2, (pageH - ih * r) / 2, iw * r, ih * r);
          }
        } catch { /* skip */ }
      }
      for (const s of page.strokes) {
        if (s.points.length === 0) continue;
        const avg = s.points.reduce((a, p) => a + p.w, 0) / s.points.length;
        const stroke = s.tool === 'eraser' ? '#ffffff' : s.color;
        pdf.setDrawColor(stroke);
        pdf.setLineWidth(avg * Math.max(sx, sy));
        if (s.points.length === 1) {
          const p = s.points[0];
          pdf.setFillColor(stroke);
          pdf.circle(p.x * sx, p.y * sy, (avg / 2) * Math.max(sx, sy), 'F');
          continue;
        }
        const lines: [number, number][] = [];
        for (let k = 1; k < s.points.length; k++) {
          lines.push([(s.points[k].x - s.points[k - 1].x) * sx, (s.points[k].y - s.points[k - 1].y) * sy]);
        }
        pdf.lines(lines, s.points[0].x * sx, s.points[0].y * sy, [1, 1], 'S');
      }
      for (const t of page.texts) {
        if (!t.text) continue;
        pdf.setTextColor(t.color);
        pdf.setFontSize(t.fontSize * Math.max(sx, sy) * 0.75); // px → pt
        const lineH = t.fontSize * sy;
        t.text.split('\n').forEach((ln, li) => {
          pdf.text(ln, t.x * sx, t.y * sy + lineH * (li + 0.8));
        });
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    pdf.save(`sketch-${stamp}.pdf`);
    toast.success(`PDF downloaded (${totalPages} page${totalPages === 1 ? '' : 's'}, ${fmt.label}).`);
  }

  if (!mounted || !open) return null;

  const activeSpec = getToolSpec(tool);
  const effectiveWidth = widthOverride ?? activeSpec.defaultWidth;
  // Save/Export are enabled when ANY page has content — multi-page
  // PDF export ships whatever pages have strokes or a background.
  const hasContent = pagesRef.current.some((p) => p.strokes.length > 0 || p.texts.length > 0 || !!p.bg);
  // Effective paper settings for the *current* page — a per-page
  // override wins over the document-wide value. Drives the Paper
  // popover's selected-pill highlight. `curPageOverride` is read
  // straight off pagesRef (mutated in place by setPaperProp; the
  // `force()` re-render keeps this in sync).
  const curPageOverride = pagesRef.current[pageIndex]?.paper;
  const effPaper = {
    size: (curPageOverride?.size as PageFormat | undefined) ?? pageFormat,
    background: (curPageOverride?.background as PageBackground | undefined) ?? pageBackground,
    surface: (curPageOverride?.surface as PaperColor | undefined) ?? paperColor,
    margins: curPageOverride?.margins ?? marginGuides,
  };
  const pageHasOverride = !!curPageOverride && Object.keys(curPageOverride).length > 0;

  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-[80] flex flex-col bg-zinc-50 dark:bg-zinc-950"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Top bar: title + page-nav + Undo/Redo/Clear/Save/Export/Close */}
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <strong className="text-sm">Sketch</strong>
        {/* Page navigator: prev / [n of m] / next / add. Sits next
          * to the title so the page state reads immediately; the
          * "+" button adds a blank page after the current one. The
          * Trash chip removes the current page (or clears the last
          * remaining page in place). */}
        <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">
          <SketchIconButton
            label="Previous page"
            icon={<ChevronLeft className="h-3.5 w-3.5" />}
            disabled={pageIndex === 0 || uploading}
            onActivate={() => goToPage(pageIndex - 1)}
          />
          <span className="select-none font-mono text-[10px] text-zinc-500" title={`Page ${pageIndex + 1} of ${pageCount}`}>
            {pageIndex + 1} / {pageCount}
          </span>
          <SketchIconButton
            label="Next page"
            icon={<ChevronRight className="h-3.5 w-3.5" />}
            disabled={pageIndex >= pageCount - 1 || uploading}
            onActivate={() => goToPage(pageIndex + 1)}
          />
          <SketchIconButton
            label="Add page"
            icon={<PlusIcon className="h-3.5 w-3.5" />}
            disabled={uploading}
            onActivate={addPage}
          />
          <SketchIconButton
            label="Duplicate page"
            icon={<Copy className="h-3.5 w-3.5" />}
            disabled={uploading}
            onActivate={duplicateCurrentPage}
          />
          <SketchIconButton
            label="Move page earlier"
            icon={<ChevronUp className="h-3.5 w-3.5" />}
            disabled={uploading || pageIndex === 0}
            onActivate={() => movePage(-1)}
          />
          <SketchIconButton
            label="Move page later"
            icon={<ChevronDown className="h-3.5 w-3.5" />}
            disabled={uploading || pageIndex >= pageCount - 1}
            onActivate={() => movePage(1)}
          />
          <SketchIconButton
            label="Delete this page"
            icon={<FileX className="h-3.5 w-3.5" />}
            disabled={uploading}
            onActivate={deleteCurrentPage}
          />
        </div>
        {/* Zoom controls — same dual-handler pattern as the rest of
          * the toolbar so Pencil taps fire reliably. The middle pill
          * shows the current scale and resets to 100% on tap. */}
        <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">
          <SketchIconButton
            label="Zoom out"
            icon={<Minus className="h-3.5 w-3.5" />}
            disabled={uploading || scale <= ZOOM_MIN}
            onActivate={() => zoomBy(0.8)}
          />
          <button
            type="button"
            onClick={() => resetView()}
            onPointerUp={(e) => { if (e.pointerType === 'pen') resetView(); }}
            style={{ cursor: 'pointer' }}
            title="Reset zoom (100%)"
            className="select-none rounded-full px-2 py-0.5 font-mono text-[10px] text-zinc-600 hover:bg-white dark:text-zinc-400 dark:hover:bg-zinc-950"
          >
            {Math.round(scale * 100)}%
          </button>
          <SketchIconButton
            label="Zoom in"
            icon={<PlusIcon className="h-3.5 w-3.5" />}
            disabled={uploading || scale >= ZOOM_MAX}
            onActivate={() => zoomBy(1.25)}
          />
          <button
            type="button"
            onClick={() => fitPaperToView()}
            onPointerUp={(e) => { if (e.pointerType === 'pen') fitPaperToView(); }}
            style={{ cursor: 'pointer' }}
            title={effPaper.size === 'auto' ? 'Fit content (or reset view if empty)' : 'Fit page to screen'}
            className="select-none rounded-full px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-white dark:text-zinc-400 dark:hover:bg-zinc-950"
          >
            Fit
          </button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <SketchIconButton
            label="Undo (⌘Z)"
            icon={<Undo2 className="h-4 w-4" />}
            disabled={(strokesRef.current.length === 0 && textsRef.current.length === 0) || uploading}
            onActivate={undo}
          />
          <SketchIconButton
            label="Redo (⌘⇧Z)"
            icon={<Redo2 className="h-4 w-4" />}
            disabled={(redoRef.current.length === 0 && textRedoRef.current.length === 0) || uploading}
            onActivate={redo}
          />
          <SketchIconButton
            label="Clear"
            icon={<Trash2 className="h-4 w-4" />}
            disabled={!hasContent || uploading}
            onActivate={clearAll}
          />
          {/* Export buttons are plain inline pills — no Radix
            * DropdownMenu, because that dropdown's `pointer-events:
            * none` lock on body was preventing iPad Pencil taps
            * from opening the menu (or hitting an item inside it).
            * Two visible pills are also one tap instead of two. */}
          <SketchButton
            label="SVG"
            icon={<FileDown className="h-3.5 w-3.5" />}
            disabled={!hasContent || uploading}
            onActivate={() => void exportSvg()}
          />
          <SketchButton
            label="PDF"
            icon={<FileDown className="h-3.5 w-3.5" />}
            disabled={!hasContent || uploading}
            onActivate={() => void exportPdf()}
          />
          <SketchIconButton
            label={penOnly ? 'Pencil only — finger ignored (tap to allow finger)' : 'Allow finger drawing (tap for Pencil-only)'}
            icon={<Hand className={`h-4 w-4 ${penOnly ? 'text-zinc-400' : 'text-zinc-900 dark:text-white'}`} />}
            onActivate={() => setPenOnly((v) => !v)}
          />
          <SketchIconButton
            label={showDebug ? 'Hide diagnostic strip' : 'Show diagnostic strip'}
            icon={<Info className={`h-4 w-4 ${showDebug ? 'text-zinc-900 dark:text-white' : 'text-zinc-400'}`} />}
            onActivate={() => setShowDebug((v) => !v)}
          />
          {/* No explicit Save — strokes autosave on every pointerup;
            * closing flushes the PNG thumbnail and persists. */}
          <SketchIconButton
            label={uploading ? 'Saving…' : 'Done (Esc) — saves and closes'}
            icon={uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            disabled={uploading}
            onActivate={closeWithSave}
          />
        </div>
      </header>

      {/* Canvas — fills remaining vertical space, never scrolls. */}
      <div
        ref={wrapRef}
        className="relative flex-1 overflow-hidden bg-white dark:bg-zinc-950"
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          style={{
            cursor: tool === 'eraser' || tool === 'obj-eraser' ? 'cell'
              : tool === 'lasso' ? 'grab'
              : tool === 'text' ? 'text'
              : 'crosshair',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
        />
        {/* Text-tool editing overlay — a real <textarea> so iPadOS
          * Scribble converts Apple Pencil handwriting to text on the
          * device. Positioned at the model anchor projected through
          * the live view transform; font-size tracks the zoom so
          * what's typed matches what redraw() will paint. Commits on
          * blur or ⌘/Ctrl+Enter; Esc discards. */}
        {textEditor && (
          <textarea
            ref={textEditorRef}
            value={textEditor.value}
            onChange={(e) => setTextEditor((ed) => (ed ? { ...ed, value: e.target.value } : ed))}
            onBlur={commitTextEditor}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                editingTextIndexRef.current = -1;
                setTextEditor(null);
                redraw();
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitTextEditor();
              }
            }}
            spellCheck={false}
            placeholder="Type or write with Pencil…"
            rows={1}
            className="absolute resize-none overflow-hidden whitespace-pre rounded-sm border border-dashed border-blue-400/70 bg-transparent p-0 leading-[1.25] outline-none"
            style={{
              left: tx + scale * textEditor.x,
              top: ty + scale * textEditor.y,
              minWidth: 40,
              fontSize: scale * textEditor.fontSize,
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              color: textEditor.color,
              caretColor: textEditor.color,
              touchAction: 'auto',
            }}
          />
        )}
        {/* Selection action chip — appears at the top of the canvas
          * when one or more strokes are lassoed. Delete removes the
          * selection in one go; Duplicate clones them with a small
          * offset (the clones become the new selection so the user
          * can drag them straight away). The dashed bbox + blue
          * stroke halo are drawn directly on the canvas by redraw(). */}
        {tool === 'lasso' && selectedRef.current.size > 0 && (
          <div className="absolute left-1/2 top-2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-1.5 py-1 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900/95">
            <span className="px-1.5 text-[11px] text-zinc-500">{selectedRef.current.size} selected</span>
            <SketchIconButton
              label="Delete selection"
              icon={<Trash2 className="h-4 w-4" />}
              onActivate={deleteSelection}
            />
            <SketchIconButton
              label="Duplicate selection"
              icon={<Copy className="h-4 w-4" />}
              onActivate={duplicateSelection}
            />
            <SketchIconButton
              label="Clear selection"
              icon={<X className="h-4 w-4" />}
              onActivate={() => {
                selectedRef.current.clear();
                redraw();
                force((n) => n + 1);
              }}
            />
          </div>
        )}
        {/* Live diagnostic — proves whether events are arriving
          * and which family. Off by default; toggled from the
          * header Info button and persisted in localStorage. */}
        {showDebug && (
          <div className="pointer-events-none absolute bottom-2 right-2 max-w-[90vw] rounded-md bg-black/75 px-2 py-1 font-mono text-[10px] leading-tight text-white">
            <div>
              canvas={canvasRef.current ? `${canvasRef.current.clientWidth}×${canvasRef.current.clientHeight}` : '?×?'}
              {' '}· strokes={strokesRef.current.length}{drawingRef.current ? '+1' : ''}
              {bgImageRef.current ? ' · bg' : ''}
            </div>
            <div>event: {debug}</div>
            <div>
              body.pe=
              {typeof document !== 'undefined' && document.body.style.pointerEvents === 'none'
                ? <span className="text-red-400">none (STUCK)</span>
                : 'ok'}
              {' '}· tool={tool} · w={effectiveWidth.toFixed(1)}
            </div>
          </div>
        )}
      </div>

      {/* Outside-tap catcher — closes whichever grouped popover is
        * open. Sits below the footer (z-[60] vs the footer's
        * z-[70]) so the popover panels stay interactive. */}
      {openMenu && (
        <div
          className="fixed inset-0 z-[60]"
          onClick={() => setOpenMenu(null)}
          onPointerUp={(e) => { if (e.pointerType === 'pen') setOpenMenu(null); }}
        />
      )}
      {/* Bottom toolbar — Apple-Notes feel: tools / colours, with
        * width / opacity / smoothing under a "Pen" popover and
        * size / style / surface / margins under "Paper". Bottom
        * placement so Pencil reach is short on iPad. */}
      {/* `min-h` keeps the footer a fixed height as its contents
        * swap (the eraser cluster, colour cluster, Pen trigger all
        * render conditionally on the active tool). Without it the
        * footer reflowed taller/shorter on a tool switch, the
        * flex-1 canvas above resized to match, and the resize-driven
        * redraw made the canvas visibly jump. */}
      <footer className="relative z-[70] flex min-h-[3.25rem] flex-wrap items-center justify-between gap-3 border-t border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Tool selector. Primary tools stay visible; the eight
          * shape tools tuck behind one "Shapes" sub-nav button. The
          * Eraser has two modes — Pixel (rubs out ink under the
          * stroke, paper + lines remain) and Object (removes the
          * whole stroke). Both modes share the one toolbar slot;
          * the inline switch below picks which is active. */}
        <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
          {TOOLS.filter((t) => t.id !== 'obj-eraser' && !isShapeTool(t.id)).map((t) => {
            const active = t.id === 'eraser'
              ? (tool === 'eraser' || tool === 'obj-eraser')
              : tool === t.id;
            return (
              <SketchToolButton
                key={t.id}
                label={t.label}
                icon={<t.Icon className="h-4 w-4" />}
                active={active}
                onActivate={() => { setTool(t.id); setWidthOverride(null); }}
              />
            );
          })}
          {(() => {
            const shapeActive = isShapeTool(tool);
            const ShapeIcon = shapeActive ? getToolSpec(tool).Icon : ShapesIcon;
            return (
              <SketchToolButton
                label={shapeActive ? getToolSpec(tool).label : 'Shapes'}
                icon={<ShapeIcon className="h-4 w-4" />}
                active={shapeActive}
                onActivate={() => setOpenMenu((m) => (m === 'shapes' ? null : 'shapes'))}
              />
            );
          })()}
        </div>
        {/* Shapes sub-nav popover — every shape tool behind one tap */}
        {openMenu === 'shapes' && (
          <div className="fixed bottom-[5.5rem] right-2 z-[75] max-h-[55vh] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <SketchMenuRow label="Shapes">
              {TOOLS.filter((t) => isShapeTool(t.id)).map((t) => (
                <SketchToolButton
                  key={t.id}
                  label={t.label}
                  icon={<t.Icon className="h-4 w-4" />}
                  active={tool === t.id}
                  onActivate={() => { setTool(t.id); setWidthOverride(null); setOpenMenu(null); }}
                />
              ))}
            </SketchMenuRow>
          </div>
        )}

        {/* Eraser options — Pixel rubs out ink under the eraser
          * (paper / lined background stay intact, true pixel
          * erasing on the strokes layer), Object removes the whole
          * stroke on contact. The size tiers apply to Pixel mode. */}
        {(tool === 'eraser' || tool === 'obj-eraser') && (
          <div className="inline-flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
              <SketchOptionPill label="Pixel" active={tool === 'eraser'} onActivate={() => setTool('eraser')} />
              <SketchOptionPill label="Object" active={tool === 'obj-eraser'} onActivate={() => setTool('obj-eraser')} />
            </div>
            {tool === 'eraser' && (() => {
              const min = activeSpec.minWidth;
              const max = activeSpec.maxWidth;
              const TIERS = [min, min + (max - min) * 0.25, (min + max) / 2, min + (max - min) * 0.75, max];
              return (
                <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
                  {TIERS.map((w, i) => (
                    <SketchWidthButton
                      key={i}
                      width={w}
                      active={Math.abs(effectiveWidth - w) < 0.5}
                      onActivate={() => setWidthOverride(w)}
                    />
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {/* Colour — current swatch + up to 3 recents inline; the
          * Palette button (or tapping the current swatch) opens the
          * full picker. Hidden for the eraser modes (no colour). */}
        {tool !== 'eraser' && tool !== 'obj-eraser' && (
          <div className="inline-flex items-center gap-1.5">
            <SketchColorButton
              color={color}
              active
              onActivate={() => setOpenMenu((m) => (m === 'color' ? null : 'color'))}
            />
            {recentColors.filter((c) => c !== color).slice(0, 3).map((c) => (
              <SketchColorButton
                key={`recent-${c}`}
                color={c}
                active={false}
                onActivate={() => setColor(c)}
              />
            ))}
            <SketchIconButton
              label="More colours"
              icon={<Palette className="h-4 w-4" />}
              onActivate={() => setOpenMenu((m) => (m === 'color' ? null : 'color'))}
            />
          </div>
        )}
        {/* Full colour picker popover — palette + custom + recents */}
        {openMenu === 'color' && tool !== 'eraser' && tool !== 'obj-eraser' && (
          <div className="fixed bottom-[5.5rem] right-2 z-[75] max-h-[55vh] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <SketchMenuRow label="Palette">
              {PALETTE.map((c) => (
                <SketchColorButton
                  key={c}
                  color={c}
                  active={color === c}
                  onActivate={() => { setColor(c); pushRecentColor(c); setOpenMenu(null); }}
                />
              ))}
              <label className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-dashed border-zinc-300 text-[11px] text-zinc-500 dark:border-zinc-600" title="Custom colour">
                +
                <input
                  type="color"
                  value={color}
                  onChange={(e) => { setColor(e.target.value); pushRecentColor(e.target.value); }}
                  className="sr-only"
                />
              </label>
            </SketchMenuRow>
            {recentColors.length > 0 && (
              <SketchMenuRow label="Recent">
                {recentColors.map((c) => (
                  <SketchColorButton
                    key={`rc-${c}`}
                    color={c}
                    active={color === c}
                    onActivate={() => { setColor(c); setOpenMenu(null); }}
                  />
                ))}
              </SketchMenuRow>
            )}
          </div>
        )}
        {/* Pen options — Notes-style popover grouping width,
          * opacity and handwriting smoothing. Hidden for the
          * non-drawing tools (eraser / object-eraser / lasso),
          * which don't use any of these. Every control is a pill
          * through useDualActivate so Pencil + touch both fire —
          * the old native <select>/<input range> controls were
          * unresponsive to Apple Pencil taps. */}
        {tool !== 'eraser' && tool !== 'obj-eraser' && tool !== 'lasso' && tool !== 'text' && (() => {
          const min = activeSpec.minWidth;
          const max = activeSpec.maxWidth;
          const WIDTH_TIERS = [min, min + (max - min) * 0.25, (min + max) / 2, min + (max - min) * 0.75, max];
          const OPACITY_TIERS = [0.25, 0.5, 0.75, 1];
          const curOpacity = typeof opacity === 'number' ? opacity : activeSpec.alpha;
          return (
            <div className="relative">
              <SketchButton
                label="Pen"
                icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
                onActivate={() => setOpenMenu((m) => (m === 'pen' ? null : 'pen'))}
              />
              {openMenu === 'pen' && (
                <div className="fixed bottom-[5.5rem] right-2 z-[75] max-h-[55vh] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                  <SketchMenuRow label="Width">
                    {WIDTH_TIERS.map((w, i) => (
                      <SketchWidthButton
                        key={i}
                        width={w}
                        active={Math.abs(effectiveWidth - w) < 0.5}
                        onActivate={() => setWidthOverride(w)}
                      />
                    ))}
                  </SketchMenuRow>
                  <SketchMenuRow label="Opacity">
                    {OPACITY_TIERS.map((o) => (
                      <SketchOptionPill
                        key={o}
                        label={`${Math.round(o * 100)}%`}
                        active={opacity !== null && Math.abs(curOpacity - o) < 0.03}
                        onActivate={() => setOpacity(o)}
                      />
                    ))}
                    <SketchOptionPill
                      label="Auto"
                      active={opacity === null}
                      onActivate={() => setOpacity(null)}
                    />
                  </SketchMenuRow>
                  <SketchMenuRow label="Smooth">
                    {SMOOTH_LEVELS.map((s) => (
                      <SketchOptionPill
                        key={s.id}
                        label={s.label}
                        active={smoothing === s.id}
                        onActivate={() => setSmoothing(s.id)}
                      />
                    ))}
                  </SketchMenuRow>
                </div>
              )}
            </div>
          );
        })()}
        {/* Paper popover — size / style / surface / margins,
          * grouped so the toolbar stays uncluttered. Size affects
          * PDF/SVG export dimensions; style is the background
          * pattern; surface is the light/dark drawing colour;
          * margins draws a dashed 5% print guide. */}
        <div className="relative">
          <SketchButton
            label="Paper"
            icon={<FileText className="h-3.5 w-3.5" />}
            onActivate={() => setOpenMenu((m) => (m === 'paper' ? null : 'paper'))}
          />
          {openMenu === 'paper' && (
            <div className="fixed bottom-[5.5rem] right-2 z-[75] max-h-[55vh] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
              {/* Scope — does a change apply to the whole document
                * or just the current page? "All pages" also clears
                * any matching per-page override so it's truly all. */}
              <SketchMenuRow label="Apply to">
                <SketchOptionPill
                  label="All pages"
                  active={paperScope === 'all'}
                  onActivate={() => setPaperScope('all')}
                />
                <SketchOptionPill
                  label={`This page (${pageIndex + 1})`}
                  active={paperScope === 'page'}
                  onActivate={() => setPaperScope('page')}
                />
              </SketchMenuRow>
              {pageHasOverride && (
                <p className="px-1 pb-1 text-[10px] text-amber-600 dark:text-amber-400">
                  Page {pageIndex + 1} has its own paper settings.
                </p>
              )}
              <SketchMenuRow label="Size">
                {PAGE_FORMATS.map((f) => (
                  <SketchOptionPill
                    key={f.id}
                    label={f.label}
                    active={effPaper.size === f.id}
                    onActivate={() => setPaperProp('size', f.id)}
                  />
                ))}
              </SketchMenuRow>
              <SketchMenuRow label="Style">
                {(['blank', 'lined', 'grid', 'dotted', 'graph'] as PageBackground[]).map((id) => (
                  <SketchOptionPill
                    key={id}
                    label={id.charAt(0).toUpperCase() + id.slice(1)}
                    active={effPaper.background === id}
                    onActivate={() => setPaperProp('background', id)}
                  />
                ))}
              </SketchMenuRow>
              <SketchMenuRow label="Surface">
                {PAPER_COLORS.map((p) => (
                  <SketchOptionPill
                    key={p.id}
                    label={p.label}
                    swatch={p.fill}
                    active={effPaper.surface === p.id}
                    onActivate={() => setPaperProp('surface', p.id)}
                  />
                ))}
              </SketchMenuRow>
              {effPaper.size !== 'auto' && (
                <SketchMenuRow label="Margins">
                  <SketchOptionPill
                    label={effPaper.margins ? 'Shown' : 'Hidden'}
                    active={effPaper.margins}
                    onActivate={() => setPaperProp('margins', !effPaper.margins)}
                  />
                </SketchMenuRow>
              )}
            </div>
          )}
        </div>
      </footer>
    </div>,
    document.body,
  );
}

/* ------- Small button helpers ------- */
/* Every interactive control here has both onClick AND
 * onPointerUp wired, with a debounce ref to keep them from
 * firing twice. iPad Apple Pencil sometimes fails to synthesize
 * the click event from pointerup; onPointerUp guarantees a code
 * path that runs regardless. */

function useDualActivate(onActivate: () => void) {
  const lastFiredRef = useRef(0);
  return {
    onClick: () => {
      const now = Date.now();
      if (now - lastFiredRef.current < 250) return;
      lastFiredRef.current = now;
      onActivate();
    },
    onPointerUp: (e: React.PointerEvent) => {
      // Only fire on pen so we don't double-fire for mouse/touch
      // (where the click event is reliable).
      if (e.pointerType !== 'pen') return;
      const now = Date.now();
      if (now - lastFiredRef.current < 250) return;
      lastFiredRef.current = now;
      onActivate();
    },
  };
}

function SketchIconButton({ label, icon, disabled, onActivate }: {
  label: string; icon: React.ReactNode; disabled?: boolean; onActivate: () => void;
}) {
  const handlers = useDualActivate(onActivate);
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      {...handlers}
      style={{ cursor: 'pointer' }}
      className="inline-flex items-center gap-1 rounded-full px-2 py-1.5 text-xs hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
    >
      {icon}
    </button>
  );
}

function SketchButton({ label, icon, primary, disabled, onActivate }: {
  label: string; icon: React.ReactNode; primary?: boolean; disabled?: boolean; onActivate: () => void;
}) {
  const handlers = useDualActivate(onActivate);
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      {...handlers}
      style={{ cursor: 'pointer' }}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${
        primary
          ? 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200'
          : 'border border-zinc-200 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SketchToolButton({ label, icon, active, onActivate }: {
  label: string; icon: React.ReactNode; active: boolean; onActivate: () => void;
}) {
  const handlers = useDualActivate(onActivate);
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      {...handlers}
      style={{ cursor: 'pointer' }}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition ${
        active
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-white'
          : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SketchColorButton({ color, active, onActivate }: {
  color: string; active: boolean; onActivate: () => void;
}) {
  const handlers = useDualActivate(onActivate);
  return (
    <button
      type="button"
      title={color}
      aria-pressed={active}
      {...handlers}
      style={{
        backgroundColor: color,
        cursor: 'pointer',
        boxShadow: active ? '0 0 0 2px white, 0 0 0 4px #18181b' : 'none',
      }}
      className="h-9 w-9 rounded-full border border-zinc-200 dark:border-zinc-700"
    />
  );
}

/* Width-tier button — visually a circle whose diameter scales with
 * the stroke width it sets. Tapping it sets the effective stroke
 * width to that tier; reading the row left-to-right gives a sense
 * of thin → thick. Uses the same useDualActivate handler the rest
 * of the toolbar uses so Apple Pencil taps fire reliably. */
function SketchWidthButton({ width, active, onActivate }: {
  width: number; active: boolean; onActivate: () => void;
}) {
  const handlers = useDualActivate(onActivate);
  const dot = Math.max(4, Math.min(20, width * 1.4));
  return (
    <button
      type="button"
      title={`Width ${width.toFixed(1)}`}
      aria-pressed={active}
      {...handlers}
      style={{ cursor: 'pointer' }}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition ${
        active
          ? 'bg-white shadow-sm dark:bg-zinc-950'
          : 'hover:bg-white/60 dark:hover:bg-zinc-950/60'
      }`}
    >
      <span
        className="block rounded-full bg-zinc-900 dark:bg-white"
        style={{ width: dot, height: dot }}
      />
    </button>
  );
}

/* Generic option pill used inside the grouped settings popovers
 * (Pen / Paper). Goes through useDualActivate so a single Apple
 * Pencil tap reliably selects the option — the native <select>
 * controls these replaced were flaky under Pencil input. An
 * optional colour swatch renders before the label (Surface row). */
function SketchOptionPill({ label, active, onActivate, swatch }: {
  label: string; active: boolean; onActivate: () => void; swatch?: string;
}) {
  const handlers = useDualActivate(onActivate);
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      {...handlers}
      style={{ cursor: 'pointer' }}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition ${
        active
          ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
          : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'
      }`}
    >
      {swatch && (
        <span
          className="h-3 w-3 rounded-full border border-zinc-300 dark:border-zinc-600"
          style={{ backgroundColor: swatch }}
        />
      )}
      <span>{label}</span>
    </button>
  );
}

/* One labelled row inside a settings popover — a fixed-width
 * caption on the left, a wrapping cluster of option pills on the
 * right. Keeps the Pen / Paper menus visually aligned. */
function SketchMenuRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1.5 first:pt-0 last:pb-0">
      <span className="w-14 shrink-0 pt-1 text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}
