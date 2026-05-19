'use client';

/**
 * Shared fullscreen wrapper for the chart views. Click the button
 * to pin the wrapped chart to the viewport; press Escape (or click
 * again) to exit. The render-prop signature passes the current
 * fullscreen state and the live container size into the child so a
 * pixel-sized chart (e.g. a canvas-based force graph) can recompute
 * its dimensions; SVG-only children that scale via viewBox can
 * simply ignore those.
 */
import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

export function FullscreenShell({
  children,
  extras,
}: {
  children: (ctx: { fullscreen: boolean; width: number; height: number }) => React.ReactNode;
  /** Optional toolbar slot rendered next to the maximize button —
   *  receives the live fullscreen flag so the chart can render a
   *  more compact UI when maximized. Used by ChartShell to keep
   *  the Export menu reachable while the chart is fullscreen
   *  (where the outer toolbar is covered by the inset-0 overlay). */
  extras?: (ctx: { fullscreen: boolean }) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [size, setSize] = useState({ width: 760, height: 480 });

  useEffect(() => {
    function measure() {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      // Floor so pixel-perfect children don't fight subpixel rounding.
      setSize({ width: Math.max(320, Math.floor(rect.width)), height: Math.max(240, Math.floor(rect.height)) });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const outer = fullscreen
    ? 'fixed inset-0 z-50 flex flex-col bg-white p-3 dark:bg-zinc-950'
    : 'relative';
  // Default body height when not fullscreen — matches the previous
  // hard-coded chart heights so the layout doesn't jump.
  const bodyStyle: React.CSSProperties = fullscreen
    ? { flex: 1, minHeight: 0 }
    : { height: 480 };

  return (
    <div ref={ref} className={outer}>
      <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
        {/* Caller-supplied toolbar (e.g. an Export menu) so the
          *  user can still reach those actions when the chart is
          *  maximised — the regular toolbar lives outside this
          *  shell and gets covered by the inset-0 overlay. */}
        {extras?.({ fullscreen })}
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {fullscreen ? <><Minimize2 className="h-3 w-3" /> Exit</> : <><Maximize2 className="h-3 w-3" /> Fullscreen</>}
        </button>
      </div>
      <div style={bodyStyle} className="relative">
        {children({ fullscreen, width: size.width, height: size.height })}
      </div>
    </div>
  );
}
