'use client';

/**
 * Shared chrome for every SVG-based chart in /lit. Renders a small
 * toolbar (summary on the left, Export dropdown on the right) and
 * passes an svg ref into the wrapped chart via a render prop. Every
 * chart that lives behind this shell gets the same export UX and
 * the same default-from-theme background — no per-chart copy of
 * the toolbar, no per-chart copy of the BG state.
 *
 * Usage:
 *
 *   <ChartShell filename="lit-timeline" summary="...">
 *     {(svgRef) => <svg ref={svgRef} viewBox={...}> ... </svg>}
 *   </ChartShell>
 */
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { GraphExportMenu, type ExportBg } from './graph-export-menu';

function detectInitialBg(): ExportBg {
  if (typeof document === 'undefined') return 'light';
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return 'dark';
  if (t === 'light' || t === 'sepia') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function ChartShell({
  filename,
  summary,
  children,
  className,
}: {
  filename: string;
  summary?: ReactNode;
  className?: string;
  children: (svgRef: RefObject<SVGSVGElement | null>) => ReactNode;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [bg, setBg] = useState<ExportBg>(() => detectInitialBg());
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {summary ?? <span />}
        </div>
        <GraphExportMenu
          filename={filename}
          source={{ svgEl: () => svgRef.current }}
          bg={bg}
          onBgChange={setBg}
        />
      </div>
      {children(svgRef)}
    </div>
  );
}
