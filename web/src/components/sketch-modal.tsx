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
  Brush, Save as SaveIcon, Loader2, Undo2, Redo2, FileDown,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { jsPDF } from 'jspdf';

type Tool = 'pen' | 'pencil' | 'marker' | 'highlighter' | 'eraser';

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

function getToolSpec(t: Tool): ToolSpec {
  return TOOLS.find((x) => x.id === t) ?? TOOLS[0];
}

export function SketchModal({
  open, onClose, onSaved, seed, saveMode = 'upload',
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (url: string, name: string) => void;
  /** Existing sketch URL or data-URL to preload as the canvas
   *  background. Erasable as a stroke layer like any other ink. */
  seed?: string;
  /** How `save()` produces the URL passed to onSaved:
   *   - 'upload' (default): upload the PNG to the user's Drive and
   *     emit `/api/drive/file?id=...`. Used by the notes-pane Sketch
   *     tile where the canvas becomes a Drive-backed attachment.
   *   - 'inline': skip the upload, emit a base64 PNG `data:` URL.
   *     Used by inline-cell sketch columns where the row's column
   *     stores the bytes directly and there's no separate file. */
  saveMode?: 'upload' | 'inline';
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
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

  /* Canvas size, DPR, redraw on open + seed image load. */
  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!c || !wrap) return;

    strokesRef.current = [];
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
          img.onload = () => { bgImageRef.current = img; redraw(); force((n) => n + 1); };
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
      // Drop noise: Pencil fires ~120 Hz so successive samples may
      // land sub-pixel apart. Skip points closer than 1.2 CSS px from
      // the previous one — keeps the path smooth and shrinks the
      // serialized point array by ~40%, which matters for SVG/PDF
      // export size and per-frame redraw cost on long strokes.
      const pts = drawingRef.current.points;
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
  }
  function redo() {
    const popped = redoRef.current.pop();
    if (popped) strokesRef.current.push(popped);
    redraw();
    force((n) => n + 1);
  }
  function clearAll() {
    strokesRef.current = [];
    redoRef.current = [];
    drawingRef.current = null;
    redraw();
    force((n) => n + 1);
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
      toast.success('Sketch saved.');
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
    if (strokesRef.current.length === 0 && !bgImageRef.current) {
      notify.error('Sketch is empty.'); return;
    }
    const { w, h } = canvasSizeCss();
    const pdf = new jsPDF({ orientation: w >= h ? 'l' : 'p', unit: 'px', format: [w, h], hotfixes: ['px_scaling'] });
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
          pdf.addImage(dataUrl, 'PNG', (w - iw * r) / 2, (h - ih * r) / 2, iw * r, ih * r);
        }
      } catch { /* skip */ }
    }
    pdf.setLineCap('round'); pdf.setLineJoin('round');
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      const avg = s.points.reduce((a, p) => a + p.w, 0) / s.points.length;
      const stroke = s.tool === 'eraser' ? '#ffffff' : s.color;
      pdf.setDrawColor(stroke);
      pdf.setLineWidth(avg);
      if (s.points.length === 1) {
        const p = s.points[0];
        pdf.setFillColor(stroke);
        pdf.circle(p.x, p.y, avg / 2, 'F');
        continue;
      }
      const lines: [number, number][] = [];
      for (let i = 1; i < s.points.length; i++) {
        lines.push([s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y]);
      }
      pdf.lines(lines, s.points[0].x, s.points[0].y, [1, 1], 'S');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    pdf.save(`sketch-${stamp}.pdf`);
    toast.success('PDF downloaded.');
  }

  if (!mounted || !open) return null;

  const activeSpec = getToolSpec(tool);
  const effectiveWidth = widthOverride ?? (activeSpec.minWidth + activeSpec.maxWidth) / 2;
  const hasContent = strokesRef.current.length > 0 || !!bgImageRef.current;

  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-[80] flex flex-col bg-zinc-50 dark:bg-zinc-950"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Top bar: title + Undo/Redo/Clear/Save/Export/Close ----- */}
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <strong className="text-sm">Sketch</strong>
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
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                disabled={!hasContent || uploading}
                title="Download a vector copy"
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
                style={{ cursor: 'pointer' }}
              >
                <FileDown className="h-3.5 w-3.5" /> Export
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end" sideOffset={4}
                className="z-[90] min-w-[8rem] rounded-md border border-zinc-200 bg-white p-1 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
              >
                <DropdownMenu.Item
                  onSelect={(e) => { e.preventDefault(); void exportSvg(); }}
                  className="cursor-pointer rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  SVG (vector)
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={(e) => { e.preventDefault(); void exportPdf(); }}
                  className="cursor-pointer rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  PDF (vector)
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
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

        {/* Width slider */}
        <label className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <span>Width</span>
          <input
            type="range"
            min={activeSpec.minWidth}
            max={activeSpec.maxWidth}
            step={0.5}
            value={effectiveWidth}
            onChange={(e) => setWidthOverride(Number(e.target.value))}
            className="w-32 cursor-pointer accent-zinc-900 dark:accent-white"
          />
          <span className="w-7 font-mono text-[10px] text-zinc-500">{effectiveWidth.toFixed(1)}</span>
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
      className="h-7 w-7 rounded-full border border-zinc-200 dark:border-zinc-700"
    />
  );
}
