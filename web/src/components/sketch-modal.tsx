'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Trash2, Eraser, Pen, Save as SaveIcon, Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

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
  // appear blurry on hi-DPI displays. Re-fires on every open.
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
    window.addEventListener('resize', sync);
    if (seed) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { bgImageRef.current = img; redraw(); force((n) => n + 1); };
      img.src = seed;
    }
    return () => window.removeEventListener('resize', sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

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
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1];
      const b = s.points[i];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = (a.w + b.w) / 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function widthFromPointer(e: React.PointerEvent): number {
    if (e.pointerType === 'pen') {
      // Pressure 0–1 → 1–10 px width.
      return 1 + e.pressure * 9;
    }
    if (e.pointerType === 'touch') return 4;
    return 2.5;
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
        <Dialog.Content className="fixed inset-2 z-[55] flex flex-col rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
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
              <button
                type="button"
                onClick={save}
                disabled={uploading || strokesRef.current.length === 0}
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
              onPointerLeave={end}
              className="block h-full w-full touch-none"
              style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
