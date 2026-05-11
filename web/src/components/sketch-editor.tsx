'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Eraser, Save, RotateCcw } from 'lucide-react';

/**
 * Tiny freehand canvas. Stores its bytes as a base64 PNG data URL in
 * the row's column, so the rest of the schema-driven UI can render it
 * with an <img> with no extra plumbing.
 */
export function SketchEditor({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;
    c.width = 600;
    c.height = 360;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = value;
    }
  }, [open, value]);

  function startStroke(x: number, y: number) {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function moveStroke(x: number, y: number) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  function endStroke() { drawing.current = false; }

  function localXY(e: React.PointerEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  }
  function clear() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  async function save() {
    const c = canvasRef.current;
    if (!c) return;
    const url = c.toDataURL('image/png');
    await onCommit(url);
    setOpen(false);
  }

  const empty = !value;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        title="Open sketch"
      >
        {empty ? (
          <span className="px-1 text-zinc-400">— sketch —</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="sketch" className="h-10 w-auto" />
        )}
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-4 shadow-2xl dark:bg-zinc-900">
            <header className="mb-3 flex items-center gap-2">
              <Dialog.Title className="flex-1 text-sm font-medium">Sketch</Dialog.Title>
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <Eraser className="h-3 w-3" /> Clear
              </button>
              <button
                type="button"
                onClick={save}
                className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
              >
                <Save className="h-3 w-3" /> Save
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <RotateCcw className="h-3 w-3" /> Discard
              </button>
              <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </header>
            <canvas
              ref={canvasRef}
              onPointerDown={(e) => { const [x, y] = localXY(e); startStroke(x, y); }}
              onPointerMove={(e) => { const [x, y] = localXY(e); moveStroke(x, y); }}
              onPointerUp={endStroke}
              onPointerLeave={endStroke}
              className="touch-none rounded-md border border-zinc-200 dark:border-zinc-800"
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
