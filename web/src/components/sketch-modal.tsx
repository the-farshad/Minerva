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
import { createPortal } from 'react-dom';
import {
  X, Trash2, Eraser, Pen, Pencil as PencilIcon, Highlighter,
  Brush, Save as SaveIcon, Loader2, Undo2, Redo2, FileDown, Slash,
  ChevronLeft, ChevronRight, Plus as PlusIcon, FileX,
} from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { jsPDF } from 'jspdf';
import type { SketchDoc, SketchDocStroke, SketchDocPage, SketchDocPaperSize } from '@/lib/sketch-doc';
import { newSketchId } from '@/lib/sketch-doc';

type Tool = 'pen' | 'pencil' | 'marker' | 'highlighter' | 'eraser' | 'line';

type ToolSpec = {
  id: Tool;
  label: string;
  Icon: typeof Pen;
  minWidth: number;
  maxWidth: number;
  alpha: number;
};

const TOOLS: ToolSpec[] = [
  { id: 'pen',         label: 'Pen',         Icon: Pen,         minWidth: 2,  maxWidth: 8,  alpha: 1    },
  { id: 'pencil',      label: 'Pencil',      Icon: PencilIcon,  minWidth: 1,  maxWidth: 4,  alpha: 0.85 },
  { id: 'marker',      label: 'Marker',      Icon: Brush,       minWidth: 6,  maxWidth: 16, alpha: 0.6  },
  { id: 'highlighter', label: 'Highlighter', Icon: Highlighter, minWidth: 12, maxWidth: 28, alpha: 0.35 },
  { id: 'line',        label: 'Line',        Icon: Slash,       minWidth: 2,  maxWidth: 8,  alpha: 1    },
  { id: 'eraser',      label: 'Eraser',      Icon: Eraser,      minWidth: 8,  maxWidth: 32, alpha: 1    },
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

type Point = { x: number; y: number; w: number };
type Stroke = { tool: Tool; color: string; alpha: number; points: Point[] };

/** Multi-page document model. Each page holds its own stroke
 *  history + optional background image; the editor flips between
 *  pages by changing `pageIndex`, with `strokesRef` / `bgImageRef`
 *  aliased to the current page's slots. */
type SketchPage = { strokes: Stroke[]; bg: HTMLImageElement | null };

/** Paper format presets — affect the PDF export dimensions only.
 *  The on-screen canvas always fills the viewport regardless of
 *  format so the user gets maximum drawing area; `auto` exports
 *  at the actual canvas dimensions instead of forcing a standard
 *  paper aspect ratio. */
type PageFormat = 'auto' | 'a4-portrait' | 'a4-landscape' | 'letter-portrait' | 'letter-landscape' | 'square';

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
    tool: s.tool,
    points: s.points.map((p) => ({
      x: p.x,
      y: p.y,
      pressure: baseWidth > 0 ? p.w / baseWidth : 1,
    })),
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
    points: ds.points.map((p) => ({
      x: p.x,
      y: p.y,
      w: baseWidth * (p.pressure ?? 1),
    })),
  };
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
  /** Source of truth for the document. Each page owns its own stroke
   *  history; `strokesRef` and `bgImageRef` below are kept as aliases
   *  into the current page so the rest of the file (which already
   *  reads / mutates those refs in dozens of places) doesn't have to
   *  thread a page index through every callsite. */
  const pagesRef = useRef<SketchPage[]>([{ strokes: [], bg: null }]);
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
  const strokesRef = useRef<Stroke[]>(pagesRef.current[0].strokes);
  const redoRef = useRef<Stroke[]>([]);
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
    bgImageRef.current = page.bg;
    redoRef.current = [];
    drawingRef.current = null;
    activeInputRef.current = null;
    redraw();
    force((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, open]);

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
          .filter((o) => o.type === 'stroke')
          .map(docStrokeToStroke),
        bg: null,
      }));
      pageIdsRef.current = seedDoc.pages.map((p) => p.id);
      setPageCount(seedDoc.pages.length);
      setPageFormat(docSizeToPaper(seedDoc.paper?.size ?? 'auto'));
    } else {
      pagesRef.current = [{ strokes: [], bg: null }];
      pageIdsRef.current = [newSketchId('page')];
      setPageCount(1);
      setPageFormat('auto');
    }
    setPageIndex(0);
    strokesRef.current = pagesRef.current[0].strokes;
    redoRef.current = [];
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
    if (seed) {
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
      // Sensible default in the middle of the range for non-
      // pressure inputs (mouse, finger) and non-pen tools.
      return (spec.minWidth + spec.maxWidth) / 2;
    };

    const rectOf = () => c.getBoundingClientRect();

    const beginStroke = (clientX: number, clientY: number, pressure: number, ptype: string) => {
      const r = rectOf();
      const x = clientX - r.left;
      const y = clientY - r.top;
      const spec = getToolSpec(tool);
      drawingRef.current = {
        tool,
        color: tool === 'eraser' ? '#000' : color,
        alpha: spec.alpha,
        points: [{ x, y, w: widthFor(pressure, ptype) }],
      };
      redoRef.current = []; // any new stroke invalidates redo history
      setDebug(`down · ${ptype} · p=${pressure.toFixed(2)}`);
      redraw();
      force((n) => n + 1);
    };
    const continueStroke = (clientX: number, clientY: number, pressure: number, ptype: string) => {
      if (!drawingRef.current) return;
      const r = rectOf();
      const nx = clientX - r.left;
      const ny = clientY - r.top;
      const pts = drawingRef.current.points;
      // Line tool: replace the SECOND point on every move so the
      // stroke stays as a straight segment from down-point to current.
      // The user sees a live preview as they drag; release commits
      // exactly two points (anchor + tip) — perfect ruler-line.
      if (drawingRef.current.tool === 'line') {
        if (pts.length === 1) {
          pts.push({ x: nx, y: ny, w: widthFor(pressure, ptype) });
        } else {
          pts[1] = { x: nx, y: ny, w: widthFor(pressure, ptype) };
        }
        setDebug(`line · ${ptype} · pts=2`);
        redraw();
        return;
      }
      // Drop noise: Pencil fires ~120 Hz so successive samples may
      // land sub-pixel apart. Skip points closer than 1.2 CSS px from
      // the previous one — keeps the path smooth and shrinks the
      // serialized point array by ~40%, which matters for SVG/PDF
      // export size and per-frame redraw cost on long strokes.
      if (pts.length > 0) {
        const last = pts[pts.length - 1];
        const dx = nx - last.x;
        const dy = ny - last.y;
        if (dx * dx + dy * dy < 1.2 * 1.2) return;
      }
      pts.push({ x: nx, y: ny, w: widthFor(pressure, ptype) });
      setDebug(`move · ${ptype} · p=${pressure.toFixed(2)} · pts=${pts.length}`);
      redraw();
    };
    const endStroke = (ptype: string) => {
      if (!drawingRef.current) return;
      strokesRef.current.push(drawingRef.current);
      drawingRef.current = null;
      setDebug(`up · ${ptype} · strokes=${strokesRef.current.length}`);
      redraw();
      force((n) => n + 1);
      // Autosave hook — caller PATCHes the vector doc to PG. Fired
      // on every pointerup so a crash mid-session loses at most one
      // partial stroke. The caller is responsible for single-flight.
      if (onAutoSave) onAutoSave(buildDoc());
    };

    // --- Pointer Events (pen + mouse + most touch on modern browsers)
    const onPointerDown = (e: PointerEvent) => {
      if (activeInputRef.current === 'touch') return; // touch path already engaged
      activeInputRef.current = 'pointer';
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* old Safari */ }
      const p = e.pressure > 0 ? e.pressure : (e.pointerType === 'pen' ? 0.5 : 1);
      beginStroke(e.clientX, e.clientY, p, e.pointerType);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (activeInputRef.current !== 'pointer') return;
      if (!drawingRef.current) return;
      e.preventDefault();
      const p = e.pressure > 0 ? e.pressure : (e.pointerType === 'pen' ? 0.5 : 1);
      continueStroke(e.clientX, e.clientY, p, e.pointerType);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (activeInputRef.current !== 'pointer') return;
      try { c.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      endStroke(e.pointerType);
      activeInputRef.current = null;
    };

    // --- Touch Events fallback (iOS Safari < 13, and the cases
    // where pointer events mysteriously don't fire for the first
    // tap on a fresh canvas)
    const onTouchStart = (e: TouchEvent) => {
      if (activeInputRef.current === 'pointer') return;
      activeInputRef.current = 'touch';
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const pressure = typeof t.force === 'number' && t.force > 0 ? t.force : 0.5;
      beginStroke(t.clientX, t.clientY, pressure, 'touch');
    };
    const onTouchMove = (e: TouchEvent) => {
      if (activeInputRef.current !== 'touch') return;
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const pressure = typeof t.force === 'number' && t.force > 0 ? t.force : 0.5;
      continueStroke(t.clientX, t.clientY, pressure, 'touch');
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (activeInputRef.current !== 'touch') return;
      e.preventDefault();
      endStroke('touch');
      activeInputRef.current = null;
    };

    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerUp);
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove',  onTouchMove,  { passive: false });
    c.addEventListener('touchend',   onTouchEnd,   { passive: false });
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool, color, widthOverride]);

  function redraw() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale(dpr, dpr);
    if (bgImageRef.current) {
      const cw = c.clientWidth || c.width / dpr;
      const ch = c.clientHeight || c.height / dpr;
      const iw = bgImageRef.current.naturalWidth;
      const ih = bgImageRef.current.naturalHeight;
      const r = Math.min(cw / iw, ch / ih);
      const w = iw * r;
      const h = ih * r;
      ctx.drawImage(bgImageRef.current, (cw - w) / 2, (ch - h) / 2, w, h);
    }
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (drawingRef.current) drawStroke(ctx, drawingRef.current);
    ctx.restore();
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    if (s.points.length === 0) return;
    ctx.save();
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
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
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      return;
    }
    // Catmull-Rom-to-Bezier smoothing: walk every interior triplet
    // and emit a cubic bezier whose control points are derived from
    // a Catmull-Rom spline through the four-point window around the
    // segment. Visually rounder than quadratic-through-midpoints,
    // and the per-segment width is a 5-point moving average so the
    // line tapers smoothly with pressure instead of step-changing
    // at every sample.
    const widthAt = (i: number): number => {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(s.points.length - 1, i + 2); k++) {
        sum += s.points[k].w;
        count += 1;
      }
      return sum / count;
    };
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
    ctx.restore();
  }

  function undo() {
    const popped = strokesRef.current.pop();
    if (popped) redoRef.current.push(popped);
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  function redo() {
    const popped = redoRef.current.pop();
    if (popped) strokesRef.current.push(popped);
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
  }
  function clearAll() {
    // Mutate in place so the alias from pagesRef stays bound — a
    // fresh [] would orphan the page object's strokes array and
    // subsequent pushes would land in the alias-only array,
    // disappearing on the next page switch.
    strokesRef.current.length = 0;
    redoRef.current.length = 0;
    drawingRef.current = null;
    redraw();
    force((n) => n + 1);
    if (onAutoSave) onAutoSave(buildDoc());
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
  function addPage() {
    commitInFlight();
    pagesRef.current.push({ strokes: [], bg: null });
    pageIdsRef.current.push(newSketchId('page'));
    setPageCount(pagesRef.current.length);
    setPageIndex(pagesRef.current.length - 1);
    if (onAutoSave) onAutoSave(buildDoc());
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
    const pages: SketchDocPage[] = pagesRef.current.map((page, i) => ({
      id: pageIdsRef.current[i] || newSketchId('page'),
      objects: page.strokes.map((s) => strokeToDocStroke(s, idFor(s))),
    }));
    return {
      schemaVersion: 1,
      documentId: documentId || 'sketch',
      paper: { size: paperToDocSize(pageFormat) },
      pages,
    };
  }

  // Cmd-Z / Cmd-Shift-Z / Esc keyboard shortcuts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
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

  async function save() {
    const c = canvasRef.current;
    if (!c) return;
    if (strokesRef.current.length === 0 && !bgImageRef.current) {
      notify.error('Sketch is empty — draw something first.');
      return;
    }
    setUploading(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `sketch-${stamp}.png`;
      if (saveMode === 'inline') {
        // Caller stores bytes directly in row.data — no upload.
        const url = c.toDataURL('image/png');
        // Flush the vector doc alongside the thumbnail so the row's
        // _sketchDoc + content fields stay in step across the save.
        if (onAutoSave) onAutoSave(buildDoc());
        onSaved(url, name);
      } else {
        const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'));
        if (!blob) throw new Error('Canvas export failed.');
        const fd = new FormData();
        fd.append('file', blob, name);
        fd.append('name', name);
        fd.append('kind', 'misc');
        const r = await fetch('/api/drive/upload', { method: 'POST', body: fd });
        const j = (await r.json().catch(() => ({}))) as { fileId?: string; error?: string };
        if (!r.ok || !j.fileId) throw new Error(j.error || `upload: ${r.status}`);
        const url = `/api/drive/file?id=${encodeURIComponent(j.fileId)}`;
        onSaved(url, name);
      }
      // Save persists ONLY the visible canvas (current page) as a
      // PNG. If the user has drawn on other pages too, surface a
      // toast so they know to use Export → PDF for the multi-page
      // version. Single-page workflow (the common case) is
      // unaffected.
      const otherPagesWithContent = pagesRef.current.reduce(
        (n, p, i) => n + (i !== pageIndex && (p.strokes.length > 0 || !!p.bg) ? 1 : 0),
        0,
      );
      if (otherPagesWithContent > 0) {
        toast.success(`Sketch saved (current page only — ${otherPagesWithContent} other page${otherPagesWithContent === 1 ? '' : 's'} in this document; use Export → PDF for all).`);
      } else {
        toast.success('Sketch saved.');
      }
      clearAll();
      onClose();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function exportSvg() {
    if (strokesRef.current.length === 0 && !bgImageRef.current) {
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
    parts.push('</svg>');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(new Blob([parts.join('')], { type: 'image/svg+xml' }), `sketch-${stamp}.svg`);
    toast.success('SVG downloaded.');
  }

  async function exportPdf() {
    const totalPages = pagesRef.current.length;
    const hasAnything = pagesRef.current.some((p) => p.strokes.length > 0 || p.bg);
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
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    pdf.save(`sketch-${stamp}.pdf`);
    toast.success(`PDF downloaded (${totalPages} page${totalPages === 1 ? '' : 's'}, ${fmt.label}).`);
  }

  if (!mounted || !open) return null;

  const activeSpec = getToolSpec(tool);
  const effectiveWidth = widthOverride ?? (activeSpec.minWidth + activeSpec.maxWidth) / 2;
  // Save/Export are enabled when ANY page has content — multi-page
  // PDF export ships whatever pages have strokes or a background.
  const hasContent = pagesRef.current.some((p) => p.strokes.length > 0 || !!p.bg);

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
            label="Delete this page"
            icon={<FileX className="h-3.5 w-3.5" />}
            disabled={uploading}
            onActivate={deleteCurrentPage}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <SketchIconButton
            label="Undo (⌘Z)"
            icon={<Undo2 className="h-4 w-4" />}
            disabled={strokesRef.current.length === 0 || uploading}
            onActivate={undo}
          />
          <SketchIconButton
            label="Redo (⌘⇧Z)"
            icon={<Redo2 className="h-4 w-4" />}
            disabled={redoRef.current.length === 0 || uploading}
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
          <SketchButton
            label={uploading ? 'Saving…' : 'Save'}
            icon={uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SaveIcon className="h-3.5 w-3.5" />}
            primary
            disabled={!hasContent || uploading}
            onActivate={save}
          />
          <SketchIconButton
            label="Close (Esc)"
            icon={<X className="h-4 w-4" />}
            onActivate={onClose}
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
            cursor: tool === 'eraser' ? 'cell' : 'crosshair',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
        />
        {/* Live diagnostic — proves whether events are arriving
          * and which family. Includes body.pointer-events so a
          * stuck Radix lock is visible without devtools. Wider
          * so the whole event line is readable on iPad. */}
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
      </div>

      {/* Bottom toolbar — Apple-Notes feel: tools / colors /
        * width slider. Bottom placement so Pencil reach is short
        * on iPad. */}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Tool selector */}
        <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
          {TOOLS.map((t) => {
            const active = tool === t.id;
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
        </div>

        {/* Color palette (hidden when eraser is active) */}
        {tool !== 'eraser' && (
          <div className="flex items-center gap-1.5">
            {PALETTE.map((c) => (
              <SketchColorButton
                key={c}
                color={c}
                active={color === c}
                onActivate={() => setColor(c)}
              />
            ))}
            <label className="ml-1 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-zinc-300 text-[10px] text-zinc-500 dark:border-zinc-600">
              +
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="sr-only"
              />
            </label>
          </div>
        )}

        {/* Width: five tap-able tiers + a fine-tune slider beside.
          * Native range inputs were unresponsive to Apple Pencil
          * taps on iPad — the tier buttons are full SketchButton
          * pills that go through the same useDualActivate handler
          * the rest of the toolbar uses, so they fire reliably. The
          * slider is kept for users on a mouse who want continuous
          * control. */}
        <div className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <span>Width</span>
          {(() => {
            const min = activeSpec.minWidth;
            const max = activeSpec.maxWidth;
            const TIERS = [min, min + (max - min) * 0.25, (min + max) / 2, min + (max - min) * 0.75, max];
            return (
              <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
                {TIERS.map((w, i) => {
                  const active = Math.abs(effectiveWidth - w) < 0.5;
                  return (
                    <SketchWidthButton
                      key={i}
                      width={w}
                      active={active}
                      onActivate={() => setWidthOverride(w)}
                    />
                  );
                })}
              </div>
            );
          })()}
          <input
            type="range"
            min={activeSpec.minWidth}
            max={activeSpec.maxWidth}
            step={0.5}
            value={effectiveWidth}
            onChange={(e) => setWidthOverride(Number(e.target.value))}
            className="w-24 cursor-pointer accent-zinc-900 dark:accent-white"
            title="Fine-tune (drag, mouse-only)"
          />
          <span className="w-7 font-mono text-[10px] text-zinc-500">{effectiveWidth.toFixed(1)}</span>
        </div>
        {/* Paper format — affects PDF export dimensions only. The
          * canvas itself always fills the viewport so the user gets
          * max drawing room regardless of choice. `auto` exports at
          * the actual canvas size (back-compat with the single-page
          * default). */}
        <label className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400" title="Paper format used when exporting to PDF">
          <span>Paper</span>
          <select
            value={pageFormat}
            onChange={(e) => setPageFormat(e.target.value as PageFormat)}
            className="cursor-pointer rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900"
          >
            {PAGE_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
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
