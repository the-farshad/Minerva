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
import { GraphExportMenu, type ExportBg, type ExportFontSize, type ExportTextColor, type GraphExportSource } from './graph-export-menu';
import { FullscreenShell } from './fullscreen-shell';

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
  tableData,
  fullscreenable,
}: {
  filename: string;
  summary?: ReactNode;
  className?: string;
  /** Optional tabular data for the chart — papers / points / rows
   *  the SVG is plotting. When provided, the Export dropdown also
   *  surfaces JSON and CSV options for the raw data, in addition
   *  to PNG / SVG / PDF for the rendered image. */
  tableData?: GraphExportSource['tableData'];
  /** Wrap the chart body in <FullscreenShell> so the user can
   *  maximize it. The Export menu is rendered both in the inline
   *  toolbar AND inside the FullscreenShell extras slot (sharing
   *  state via the lifted bg/fontSize/textColor below), so it
   *  stays reachable while the chart is maximized. */
  fullscreenable?: boolean;
  children: (svgRef: RefObject<SVGSVGElement | null>) => ReactNode;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Lifted state so the toolbar + fullscreen instances of
  // GraphExportMenu share one source of truth — see
  // author-graph for the same pattern.
  const [bg, setBg] = useState<ExportBg>(() => detectInitialBg());
  const [fontSize, setFontSize] = useState<ExportFontSize>('M');
  const [textColor, setTextColor] = useState<ExportTextColor>('auto');
  const menu = (
    <GraphExportMenu
      filename={filename}
      source={{ svgEl: () => svgRef.current, tableData }}
      bg={bg}
      onBgChange={setBg}
      fontSize={fontSize}
      onFontSizeChange={setFontSize}
      textColor={textColor}
      onTextColorChange={setTextColor}
    />
  );
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {summary ?? <span />}
        </div>
        {menu}
      </div>
      {fullscreenable ? (
        <FullscreenShell extras={({ fullscreen }) => fullscreen ? menu : null}>
          {() => children(svgRef)}
        </FullscreenShell>
      ) : children(svgRef)}
    </div>
  );
}
