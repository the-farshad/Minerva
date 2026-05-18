'use client';

/**
 * Shared export trigger for the /lit graph views.
 *
 * Replaces the row of per-format icon buttons each graph used to
 * grow on its own (PNG / SVG / PDF / JSON / GraphML). One Download
 * trigger, one menu with every format the source can produce,
 * plus an inline background selector so the chosen BG actually
 * lands in the saved file. Lives inside the per-graph toolbar so
 * it's reachable in fullscreen too (the FullscreenShell wraps the
 * whole component including the toolbar).
 */
import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Download, Sun, Moon } from 'lucide-react';
import {
  exportPNGFromCanvas,
  exportSVGFromCanvas,
  exportPDFFromCanvas,
  exportPNGFromSVG,
  exportSVGFromElement,
  exportPDFFromSVG,
  exportGraphJSON,
  exportGraphML,
  type ExportNode,
  type ExportLink,
} from './graph-export';

export type ExportBg = 'light' | 'dark';

const BG_HEX: Record<ExportBg, string> = {
  light: '#ffffff',
  dark: '#0b0d10',
};

export type GraphExportSource = {
  /** Returns the live canvas for raster export (PNG / SVG-wrapped /
   *  PDF-as-image). Return null when the active layout doesn't
   *  render to canvas. */
  canvasEl?: () => HTMLCanvasElement | null;
  /** Returns the live SVG element for vector export (SVG / PDF). */
  svgEl?: () => SVGSVGElement | null;
  /** Structural data — used for JSON / GraphML. */
  graphData?: { nodes: ExportNode[]; links: ExportLink[] };
};

export function GraphExportMenu({
  filename,
  source,
  bg,
  onBgChange,
}: {
  filename: string;
  source: GraphExportSource;
  bg: ExportBg;
  onBgChange: (next: ExportBg) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function doExport(format: 'png' | 'svg' | 'pdf' | 'json' | 'graphml') {
    if (busy) return;
    setBusy(true);
    try {
      const fn = `${filename}.${format}`;
      const canvas = source.canvasEl?.() ?? null;
      const svg = source.svgEl?.() ?? null;
      const bgHex = BG_HEX[bg];
      if (format === 'png') {
        if (canvas) exportPNGFromCanvas(canvas, fn, bgHex);
        else if (svg) await exportPNGFromSVG(svg, fn, bgHex);
      } else if (format === 'svg') {
        if (svg) exportSVGFromElement(svg, fn, bgHex);
        else if (canvas) exportSVGFromCanvas(canvas, fn, bgHex);
      } else if (format === 'pdf') {
        if (svg) await exportPDFFromSVG(svg, fn, bgHex);
        else if (canvas) await exportPDFFromCanvas(canvas, fn, bgHex);
      } else if (format === 'json' && source.graphData) {
        exportGraphJSON(source.graphData.nodes, source.graphData.links, fn);
      } else if (format === 'graphml' && source.graphData) {
        exportGraphML(source.graphData.nodes, source.graphData.links, fn);
      }
    } finally {
      setBusy(false);
    }
  }

  const itemCls = 'flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800';

  // canVector requires an SVG source today. canvas→vector via
  // node-position snapshot is queued as a follow-up (raster-wrapped
  // is the current fallback path on canvas-only graphs).
  const hasCanvas = !!source.canvasEl;
  const hasSvg = !!source.svgEl;
  const hasData = !!source.graphData;
  const canRaster = hasCanvas || hasSvg;
  const canVector = hasSvg;

  const bgChip = (id: ExportBg, label: string, Icon: typeof Sun) => (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onBgChange(id); }}
      title={`Export background: ${label}`}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full transition ${
        bg === id
          ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      <Icon className="h-3 w-3" />
    </button>
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Export this graph"
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Download className="h-3 w-3" />
          Export
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[60] min-w-[14rem] overflow-hidden rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          {canRaster && (
            <DropdownMenu.Item onSelect={() => void doExport('png')} className={itemCls}>
              <span className="flex-1">PNG</span>
              <span className="text-[10px] text-zinc-500">raster</span>
            </DropdownMenu.Item>
          )}
          {(canVector || canRaster) && (
            <DropdownMenu.Item onSelect={() => void doExport('svg')} className={itemCls}>
              <span className="flex-1">SVG</span>
              <span className="text-[10px] text-zinc-500">{canVector ? 'vector' : 'raster-wrapped'}</span>
            </DropdownMenu.Item>
          )}
          {(canVector || canRaster) && (
            <DropdownMenu.Item onSelect={() => void doExport('pdf')} className={itemCls}>
              <span className="flex-1">PDF</span>
              <span className="text-[10px] text-zinc-500">{canVector ? 'vector' : 'raster'}</span>
            </DropdownMenu.Item>
          )}
          {hasData && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
              <DropdownMenu.Item onSelect={() => void doExport('json')} className={itemCls}>
                <span className="flex-1">JSON</span>
                <span className="text-[10px] text-zinc-500">data</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void doExport('graphml')} className={itemCls}>
                <span className="flex-1">GraphML</span>
                <span className="text-[10px] text-zinc-500">data</span>
              </DropdownMenu.Item>
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
          <div
            className="flex items-center justify-between gap-2 px-2 py-1.5"
            // The chip row sits inside a DropdownMenu — without
            // stopping propagation a click closes the menu before
            // the selection registers. Stops on the wrapper, not on
            // each chip, so the buttons still receive their click.
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Background</span>
            <div className="flex items-center gap-0.5">
              {bgChip('light', 'light', Sun)}
              {bgChip('dark', 'dark', Moon)}
            </div>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
