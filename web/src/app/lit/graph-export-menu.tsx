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
import { Download, Sun, Moon, Type } from 'lucide-react';
import {
  exportPNGFromCanvas,
  exportSVGFromCanvas,
  exportPDFFromCanvas,
  exportPNGFromSVG,
  exportSVGFromElement,
  exportPDFFromSVG,
  exportGraphJSON,
  exportGraphML,
  nodesToSVG,
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

export type ExportFontSize = 'S' | 'M' | 'L' | 'XL';
const FONT_PX: Record<ExportFontSize, number> = { S: 9, M: 11, L: 14, XL: 18 };

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
  const [fontSize, setFontSize] = useState<ExportFontSize>('M');
  // Text colour: 'auto' leaves the chart's own colours alone;
  // every other value forces every <text> fill to that colour
  // at serialise time so labels read the way the user wants.
  const [textColor, setTextColor] = useState<'auto' | 'black' | 'white' | 'invert-bg'>('auto');

  async function doExport(format: 'png' | 'svg' | 'pdf' | 'json' | 'graphml') {
    if (busy) return;
    setBusy(true);
    try {
      const fn = `${filename}.${format}`;
      const canvas = source.canvasEl?.() ?? null;
      const liveSvg = source.svgEl?.() ?? null;
      const bgHex = BG_HEX[bg];
      // Resolve text colour. 'invert-bg' produces white-on-dark
      // and black-on-light without the user picking explicitly.
      const resolvedTextColor =
        textColor === 'auto' ? undefined
        : textColor === 'invert-bg' ? (bg === 'dark' ? '#fafafa' : '#0b0d10')
        : textColor === 'white' ? '#fafafa'
        : '#0b0d10';
      const styleOpts = { fontSize: FONT_PX[fontSize], textColor: resolvedTextColor };

      // For vector output (SVG / PDF) on a canvas-only graph that
      // carries node positions in graphData, build a fresh SVG
      // from those positions and route through the vector path.
      // That replaces the old "PNG embedded inside an <svg>"
      // raster-wrapped output with a true scalable vector.
      let svgForVector: SVGSVGElement | null = liveSvg;
      if (!svgForVector && (format === 'svg' || format === 'pdf') && source.graphData) {
        svgForVector = nodesToSVG(source.graphData.nodes, source.graphData.links, {
          bg: bgHex,
          fontSize: FONT_PX[fontSize],
          textColor: resolvedTextColor,
        });
      }

      if (format === 'png') {
        if (canvas) exportPNGFromCanvas(canvas, fn, bgHex);
        else if (liveSvg) await exportPNGFromSVG(liveSvg, fn, bgHex, styleOpts);
      } else if (format === 'svg') {
        if (svgForVector) exportSVGFromElement(svgForVector, fn, bgHex, styleOpts);
        else if (canvas) exportSVGFromCanvas(canvas, fn, bgHex);
      } else if (format === 'pdf') {
        if (svgForVector) await exportPDFFromSVG(svgForVector, fn, bgHex, styleOpts);
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

  const hasCanvas = !!source.canvasEl;
  const hasSvg = !!source.svgEl;
  const hasData = !!source.graphData;
  const canRaster = hasCanvas || hasSvg;
  // True-vector output is available when a live SVG element
  // exists OR when the source carries node positions we can
  // rebuild an SVG from (nodesToSVG handles force-layout graphs).
  const canVector = hasSvg || (hasData
    && (source.graphData!.nodes.some((n) => Number.isFinite(n.x) && Number.isFinite(n.y))));

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
            className="space-y-1.5 px-2 py-1.5"
            // The control rows sit inside a DropdownMenu — without
            // stopping propagation a click closes the menu before
            // the selection registers. Stops on the wrapper, not on
            // each chip, so the buttons still receive their click.
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Background</span>
              <div className="flex items-center gap-0.5">
                {bgChip('light', 'light', Sun)}
                {bgChip('dark', 'dark', Moon)}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Text size</span>
              <div className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                {(['S', 'M', 'L', 'XL'] as ExportFontSize[]).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => setFontSize(sz)}
                    className={`rounded-full px-2 py-0.5 text-[10px] transition ${
                      fontSize === sz
                        ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                        : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                    }`}
                  >
                    {sz}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Text colour</span>
              <div className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                {(['auto', 'invert-bg', 'black', 'white'] as const).map((tc) => (
                  <button
                    key={tc}
                    type="button"
                    onClick={() => setTextColor(tc)}
                    title={
                      tc === 'auto' ? 'Auto — keep the chart\'s colours'
                      : tc === 'invert-bg' ? 'Auto-invert against the background'
                      : tc === 'black' ? 'Force black'
                      : 'Force white'
                    }
                    className={`rounded-full px-2 py-0.5 text-[10px] transition ${
                      textColor === tc
                        ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                        : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                    }`}
                  >
                    {tc === 'auto' ? 'auto' : tc === 'invert-bg' ? <Type className="inline h-3 w-3" /> : tc === 'black' ? '●' : '○'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
