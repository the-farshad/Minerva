'use client';

import { useState } from 'react';
import { SketchModal } from './sketch-modal';

/**
 * Sketch cell editor for the grid's inline-cell renderer. The
 * column stores the canvas bytes directly as a base64 PNG data
 * URL — no Drive round-trip — so the rest of the schema-driven UI
 * can render it with a plain `<img src={value}>`.
 *
 * This used to be its own ~140-line freehand canvas with React
 * synthetic onPointerDown — the exact pattern that broke Apple
 * Pencil drawing on iPad. It now thin-wraps the full SketchModal
 * (native event listeners, dual touch/pointer handling, palette,
 * tool selector, pressure, undo/redo, diagnostic strip) running in
 * 'inline' saveMode so the modal emits a data-URL to `onCommit`
 * instead of uploading to Drive.
 */
export function SketchEditor({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const empty = !value;
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        title={empty ? 'Tap to draw' : 'Tap to edit sketch'}
      >
        {empty ? (
          <span className="px-1 text-zinc-400">— sketch —</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="sketch" className="h-10 w-auto" />
        )}
      </button>

      <SketchModal
        open={open}
        onClose={() => setOpen(false)}
        seed={value || undefined}
        saveMode="inline"
        onSaved={(url) => { void onCommit(url); }}
      />
    </>
  );
}
