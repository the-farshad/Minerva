'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Trash2, Eraser, Pen, Save as SaveIcon, Loader2, Undo2, FileDown } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { jsPDF } from 'jspdf';

/**
 * Pen-pressure-aware sketching canvas backed by Pointer Events.
 * On Save → exports the canvas to a PNG, uploads to the user's
 * Drive via the existing /api/drive/upload route, and resolves with
 * `{ url, name }` so callers can splice an attachment link into
 * whatever markdown surface is hosting them.
 *
 * Apple Pencil / Wacom / Surface Pen all report `pressure` on
 * `PointerEvent`; mice report 0.5 (the default). When `pointerType
 * === 'pen'`, we use pressure to modulate stroke width
 * (1px–10px range); for mouse/touch we fall back to a flat width.
 *
 * Stroke storage is per-stroke point arrays so we can implement
 * undo (one stroke at a time) without redrawing pixel-by-pixel.
 */

type Point = { x: number; y: number; w: number };
type Stroke = { color: string; points: Point[]; eraser: boolean };

const PALETTE = ['#1f1f1f', '#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0284c7', '#7c3aed'];

export function SketchModal({
  open, onClose, onSaved, seed,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (url: string, name: string) => void;
  /** When set, the canvas opens with this image painted as a
   * non-erasable background layer. Used by the Notes preset to
   * "Edit sketch" — the previous PNG is loaded so the user can
   * keep refining instead of starting from scratch. */
  seed?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawing = useRef<Stroke | null>(null);
  const [color, setColor] = useState(PALETTE[0]);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [, force] = useState(0);
  const [uploading, setUploading] = useState(false);

  // Resize the backing canvas to match its CSS box so strokes don't
  // appear blurry on hi-DPI displays. The window-resize listener
  // alone wasn't enough — Radix Dialog animates its content in,
  // and the first effect-tick frequently catches a 0×0 wrap which
  // left the canvas un-clickable until you resized the window.
  // ResizeObserver watches the wrap itself and re-syncs the moment
  // it grows from 0 to its real size.
  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!c || !wrap) return;
    // Fresh open → drop any prior strokes / bg so re-opening doesn't
    // stack last session's drawing under the new one.
    strokesRef.current = [];
    bgImageRef.current = null;
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
    const ro = new ResizeObserver(() => sync());
    ro.observe(wrap);
    window.addEventListener('resize', sync);
    let blobUrl: string | null = null;
    if (seed) {
      // Drive URLs (/api/drive/file?id=...) sometimes 302 to
      // googleusercontent.com which doesn't honour our Origin
      // header on a cross-origin Image load — the canvas then
      // becomes "tainted" and toBlob() returns null on Save, so
      // the next Save silently fails. Fetch the bytes through
      // our same-origin /api proxy and hand the image element a
      // Blob URL: the canvas stays clean and export works.
      const useBlobLoad = seed.startsWith('/');
      const loadVia = async () => {
        if (useBlobLoad) {
          const r = await fetch(seed);
          if (!r.ok) throw new Error(`seed: ${r.status}`);
          const blob = await r.blob();
          return URL.createObjectURL(blob);
        }
        return seed;
      };
      (async () => {
        try {
          const src = await loadVia();
          if (useBlobLoad) blobUrl = src;
          const img = new Image();
          img.onload = () => { bgImageRef.current = img; redraw(); force((n) => n + 1); };
          img.onerror = () => {
            bgImageRef.current = null;
            force((n) => n + 1);
          };
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

  // iPad Safari occasionally drops the first PointerDown for
  // Apple Pencil unless a native non-passive touchstart listener
  // on the same element calls preventDefault. React's synthetic
  // onPointerDown listener registers as passive by default which
  // is too late to suppress the default touch handling. Wire a
  // direct addEventListener with passive:false alongside the
  // React handler — they coexist fine; the React one still
  // updates state, the native one just blocks the browser from
  // intercepting the gesture.
  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;
    const block = (e: TouchEvent) => { e.preventDefault(); };
    c.addEventListener('touchstart', block, { passive: false });
    c.addEventListener('touchmove', block, { passive: false });
    return () => {
      c.removeEventListener('touchstart', block);
      c.removeEventListener('touchmove', block);
    };
  }, [open]);

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
      // Paint the seed image fit-to-canvas, preserving aspect ratio,
      // centered. The CSS box is what the user sees so we draw in
      // CSS pixels (the ctx.scale above already maps to DPR).
      const cw = c.clientWidth || c.width / dpr;
      const ch = c.clientHeight || c.height / dpr;
      const iw = bgImageRef.current.naturalWidth;
      const ih = bgImageRef.current.naturalHeight;
      const r = Math.min(cw / iw, ch / ih);
      const w = iw * r;
      const h = ih * r;
      ctx.drawImage(bgImageRef.current, (cw - w) / 2, (ch - h) / 2, w, h);
    }
    for (const s of strokesRef.current) {
      drawStroke(ctx, s);
    }
    if (drawing.current) drawStroke(ctx, drawing.current);
    ctx.restore();
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    if (s.points.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = s.eraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color;
    if (s.points.length === 1) {
      const p = s.points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
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
    // Quadratic-curve smoothing through midpoints — the same
    // technique iOS Notes uses for clean pen ink. Each
    // pair of consecutive samples becomes a Bezier segment with
    // the original sample as the control point, so the strokes
    // read as smooth curves rather than jagged polyline.
    // Width is interpolated per-segment to preserve pen pressure
    // variation without exploding the path count.
    const pts = s.points;
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const next = pts[i + 1];
      const startX = (prev.x + cur.x) / 2;
      const startY = (prev.y + cur.y) / 2;
      const endX = (cur.x + next.x) / 2;
      const endY = (cur.y + next.y) / 2;
      ctx.lineWidth = (prev.w + cur.w + next.w) / 3;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(cur.x, cur.y, endX, endY);
      ctx.stroke();
    }
    // Tail segment from last midpoint to last point so the stroke
    // ends where the user actually lifted the pen.
    const second = pts[pts.length - 2];
    const last = pts[pts.length - 1];
    ctx.lineWidth = (second.w + last.w) / 2;
    ctx.beginPath();
    ctx.moveTo((second.x + last.x) / 2, (second.y + last.y) / 2);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
  }

  function widthFromPointer(e: React.PointerEvent): number {
    if (e.pointerType === 'pen') {
      // Pressure 0–1 → 2.5–10 px width. Floor at 2.5 because
      // browser drivers regularly under-report pressure (e.g.
      // some Apple Pencil paths report 0 mid-stroke) which
      // otherwise renders an invisible ~1 px line.
      return 2.5 + e.pressure * 7.5;
    }
    if (e.pointerType === 'touch') return 6;
    return 4.5;
  }

  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent) {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    drawing.current = {
      color,
      eraser: tool === 'eraser',
      points: [{ x: p.x, y: p.y, w: widthFromPointer(e) }],
    };
    redraw();
  }

  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const p = localPoint(e);
    drawing.current.points.push({ x: p.x, y: p.y, w: widthFromPointer(e) });
    redraw();
  }

  function end(e: React.PointerEvent) {
    if (!drawing.current) return;
    canvasRef.current?.releasePointerCapture(e.pointerId);
    strokesRef.current.push(drawing.current);
    drawing.current = null;
    redraw();
    force((n) => n + 1);
  }

  function undo() {
    strokesRef.current.pop();
    redraw();
    force((n) => n + 1);
  }
  function clear() {
    strokesRef.current = [];
    drawing.current = null;
    redraw();
    force((n) => n + 1);
  }

  /** Trigger a browser download for a blob. Used by SVG / PDF
   *  export so users get a file on disk, not just a Drive URL. */
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

  /** Average the per-point widths inside a stroke and emit one
   *  SVG polyline / PDF path. Width-varying strokes would need
   *  per-segment elements (or `<path>` with stroke-width gradient
   *  via SVG 2 — not implementable cross-browser); the averaged
   *  width is close enough for ink that lives on a 2D page and
   *  matches the canvas render at typical zoom levels. */
  function strokeAvgWidth(s: Stroke): number {
    if (s.points.length === 0) return 2;
    let sum = 0;
    for (const p of s.points) sum += p.w;
    return sum / s.points.length;
  }

  function canvasSizeCss(): { w: number; h: number } {
    const c = canvasRef.current;
    if (!c) return { w: 800, h: 600 };
    return {
      w: c.clientWidth || c.width / (window.devicePixelRatio || 1),
      h: c.clientHeight || c.height / (window.devicePixelRatio || 1),
    };
  }

  /** Build an SVG snapshot of the current sketch. Seed image (if
   *  any) goes in as a base64 data URL behind the strokes so the
   *  exported file stays self-contained. */
  async function buildSvg(): Promise<string> {
    const { w, h } = canvasSizeCss();
    const parts: string[] = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`);
    // White paper background for legibility outside dark UIs.
    parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
    // Seed image as base64. The image was loaded via HTMLImageElement
    // earlier; convert it to a data URL via an offscreen canvas so
    // the result embeds without re-fetching.
    const bg = bgImageRef.current;
    if (bg) {
      try {
        const off = document.createElement('canvas');
        off.width = bg.naturalWidth;
        off.height = bg.naturalHeight;
        const octx = off.getContext('2d');
        if (octx) {
          octx.drawImage(bg, 0, 0);
          const dataUrl = off.toDataURL('image/png');
          const iw = bg.naturalWidth;
          const ih = bg.naturalHeight;
          const r = Math.min(w / iw, h / ih);
          const dw = iw * r;
          const dh = ih * r;
          parts.push(`<image href="${dataUrl}" x="${(w - dw) / 2}" y="${(h - dh) / 2}" width="${dw}" height="${dh}"/>`);
        }
      } catch { /* tainted canvas or out of memory — skip the bg */ }
    }
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      const width = strokeAvgWidth(s);
      const color = s.eraser ? '#ffffff' : s.color;
      if (s.points.length === 1) {
        const p = s.points[0];
        parts.push(`<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(width / 2).toFixed(2)}" fill="${color}"/>`);
        continue;
      }
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    parts.push('</svg>');
    return parts.join('');
  }

  async function exportSvg() {
    if (strokesRef.current.length === 0 && !bgImageRef.current) {
      notify.error('Sketch is empty — draw something first.');
      return;
    }
    const svg = await buildSvg();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `sketch-${stamp}.svg`);
    toast.success('SVG downloaded.');
  }

  async function exportPdf() {
    if (strokesRef.current.length === 0 && !bgImageRef.current) {
      notify.error('Sketch is empty — draw something first.');
      return;
    }
    const { w, h } = canvasSizeCss();
    // jsPDF expects user units; default unit is 'pt'. We feed it CSS
    // pixels directly (since the canvas units are CSS px) and let
    // the orientation match the natural canvas aspect.
    const orientation = w >= h ? 'l' : 'p';
    const pdf = new jsPDF({ orientation, unit: 'px', format: [w, h], hotfixes: ['px_scaling'] });
    // Background image first so strokes land on top.
    const bg = bgImageRef.current;
    if (bg) {
      try {
        const off = document.createElement('canvas');
        off.width = bg.naturalWidth;
        off.height = bg.naturalHeight;
        const octx = off.getContext('2d');
        if (octx) {
          octx.drawImage(bg, 0, 0);
          const dataUrl = off.toDataURL('image/png');
          const iw = bg.naturalWidth;
          const ih = bg.naturalHeight;
          const r = Math.min(w / iw, h / ih);
          const dw = iw * r;
          const dh = ih * r;
          pdf.addImage(dataUrl, 'PNG', (w - dw) / 2, (h - dh) / 2, dw, dh);
        }
      } catch { /* skip bg if tainted */ }
    }
    pdf.setLineCap('round');
    pdf.setLineJoin('round');
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      const width = strokeAvgWidth(s);
      const color = s.eraser ? '#ffffff' : s.color;
      pdf.setDrawColor(color);
      pdf.setLineWidth(width);
      if (s.points.length === 1) {
        const p = s.points[0];
        pdf.setFillColor(color);
        pdf.circle(p.x, p.y, width / 2, 'F');
        continue;
      }
      // Multi-point: stitch consecutive segments with lines().
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

  async function save() {
    const c = canvasRef.current;
    if (!c) return;
    if (strokesRef.current.length === 0 && !bgImageRef.current) {
      notify.error('Sketch is empty — draw something first.');
      return;
    }
    setUploading(true);
    try {
      const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Canvas export failed.');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `sketch-${stamp}.png`;
      const fd = new FormData();
      fd.append('file', blob, name);
      fd.append('name', name);
      fd.append('kind', 'misc');
      const r = await fetch('/api/drive/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { fileId?: string; error?: string };
      if (!r.ok || !j.fileId) throw new Error(j.error || `upload: ${r.status}`);
      const url = `/api/drive/file?id=${encodeURIComponent(j.fileId)}`;
      onSaved(url, name);
      toast.success('Sketch saved.');
      clear();
      onClose();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 z-[55] flex flex-col border-0 bg-white shadow-xl dark:bg-zinc-950 sm:inset-2 sm:rounded-xl sm:border sm:border-zinc-200 sm:dark:border-zinc-800">
          <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <Dialog.Title className="text-sm font-medium">Sketch</Dialog.Title>
            <div className="ml-3 inline-flex items-center rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
              <button
                type="button"
                onClick={() => setTool('pen')}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${tool === 'pen' ? 'bg-white shadow-sm dark:bg-zinc-950' : 'opacity-60 hover:opacity-100'}`}
                title="Pen"
              >
                <Pen className="h-3.5 w-3.5" /> Pen
              </button>
              <button
                type="button"
                onClick={() => setTool('eraser')}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${tool === 'eraser' ? 'bg-white shadow-sm dark:bg-zinc-950' : 'opacity-60 hover:opacity-100'}`}
                title="Eraser"
              >
                <Eraser className="h-3.5 w-3.5" /> Eraser
              </button>
            </div>
            <div className="ml-2 flex items-center gap-1">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setColor(c); setTool('pen'); }}
                  className={`h-5 w-5 rounded-full border ${color === c && tool === 'pen' ? 'border-zinc-900 dark:border-white' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={undo}
                disabled={strokesRef.current.length === 0 || uploading}
                title="Undo last stroke"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <Undo2 className="h-3.5 w-3.5" /> Undo
              </button>
              <button
                type="button"
                onClick={clear}
                disabled={strokesRef.current.length === 0 || uploading}
                title="Clear the canvas"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </button>
              {/* Download exports — SVG (true vector) and PDF (vector
                * via jsPDF). Both land on the user's machine; the
                * primary Save still goes to Drive as a PNG. */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    disabled={uploading || (strokesRef.current.length === 0 && !bgImageRef.current)}
                    title="Download a vector copy"
                    className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
                  >
                    <FileDown className="h-3.5 w-3.5" /> Export
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end" sideOffset={4}
                    className="z-[60] min-w-[8rem] rounded-md border border-zinc-200 bg-white p-1 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
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
              <button
                type="button"
                onClick={save}
                disabled={uploading || (strokesRef.current.length === 0 && !bgImageRef.current)}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
              >
                {uploading
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>
                  : <><SaveIcon className="h-3.5 w-3.5" /> Save</>}
              </button>
              <Dialog.Close
                aria-label="Close"
                className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
          </header>
          <div ref={wrapRef} className="flex-1 touch-none bg-white dark:bg-zinc-900">
            <canvas
              ref={canvasRef}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              // Deliberately NOT wiring onPointerLeave={end}:
              // pointer capture should keep events flowing to the
              // canvas even when the pointer geometrically leaves
              // its bounding box, but onPointerLeave still fires
              // on some browsers (Safari iOS, Firefox) and would
              // prematurely commit the in-progress stroke when
              // the pen briefly crosses the toolbar / drifts to
              // the edge.
              className="block h-full w-full"
              style={{
                cursor: tool === 'eraser' ? 'cell' : 'crosshair',
                // Inline touch-action wins over any cascade —
                // iPad Safari needs `none` to deliver continuous
                // pointer events instead of scrolling the page
                // out from under the stroke.
                touchAction: 'none',
                // Belt-and-suspenders against the Pencil callout
                // bubble that iPad sometimes pops when the user
                // long-presses on a canvas thinking it's text.
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none',
              }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
