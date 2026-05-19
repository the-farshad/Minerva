'use client';

/**
 * Reusable region-select crop for any SVG chart. Lives outside
 * ChartShell so author-graph / keyword-graph / future charts that
 * roll their own toolbar can drop in the same UX without copying
 * the marquee + viewBox-mutation plumbing.
 *
 * Usage:
 *
 *   const crop = useCropRegion(svgRef);
 *   return (
 *     <>
 *       <div className="toolbar">
 *         {crop.cropButton}
 *         <GraphExportMenu source={{ svgEl: crop.getSvgForExport }} … />
 *       </div>
 *       <div
 *         ref={crop.bodyRef}
 *         onMouseDown={crop.onMouseDown}
 *         onMouseMove={crop.onMouseMove}
 *         onMouseUp={crop.onMouseUp}
 *         onMouseLeave={crop.onMouseUp}
 *         className={crop.cropping ? 'cursor-crosshair select-none' : ''}
 *       >
 *         <svg ref={svgRef}>…</svg>
 *         {crop.decorations}
 *       </div>
 *     </>
 *   );
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Crop, X } from 'lucide-react';

export type CropRect = { x: number; y: number; w: number; h: number };

export function useCropRegion(svgRef?: RefObject<SVGSVGElement | null>) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [cropping, setCropping] = useState(false);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<CropRect | null>(null);

  useEffect(() => {
    if (!cropping) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setCropping(false);
        setDragRect(null);
        dragStartRef.current = null;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cropping]);

  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!cropping || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    dragStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragRect({ x: dragStartRef.current.x, y: dragStartRef.current.y, w: 0, h: 0 });
  }
  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    if (!cropping || !start || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setDragRect({
      x: Math.min(start.x, cx),
      y: Math.min(start.y, cy),
      w: Math.abs(cx - start.x),
      h: Math.abs(cy - start.y),
    });
  }
  function onMouseUp() {
    if (!cropping) return;
    const r = dragRect;
    dragStartRef.current = null;
    setDragRect(null);
    setCropping(false);
    if (r && r.w >= 10 && r.h >= 10) setCropRect(r);
  }

  /** Map the container-pixel crop rect to viewBox space and
   *  temporarily mutate the live SVG's viewBox so every export
   *  path captures the cropped region. Revert via setTimeout(0)
   *  — by that point each export has read viewBox synchronously
   *  into its serialised output, so the live view returns to its
   *  original state without affecting the in-flight export. */
  function getSvgForExport(): SVGSVGElement | null {
    const live = svgRef?.current;
    if (!live) return null;
    if (!cropRect || !bodyRef.current) return live;
    const bodyRect = bodyRef.current.getBoundingClientRect();
    const svgRect = live.getBoundingClientRect();
    const vb = live.viewBox.baseVal;
    if (!vb || vb.width === 0 || vb.height === 0) return live;
    const svgLeft = svgRect.left - bodyRect.left;
    const svgTop = svgRect.top - bodyRect.top;
    const sx = vb.width / svgRect.width;
    const sy = vb.height / svgRect.height;
    const vbCrop = {
      x: vb.x + Math.max(0, (cropRect.x - svgLeft)) * sx,
      y: vb.y + Math.max(0, (cropRect.y - svgTop)) * sy,
      w: cropRect.w * sx,
      h: cropRect.h * sy,
    };
    const orig = live.getAttribute('viewBox');
    live.setAttribute('viewBox', `${vbCrop.x} ${vbCrop.y} ${vbCrop.w} ${vbCrop.h}`);
    setTimeout(() => {
      if (orig) live.setAttribute('viewBox', orig);
      else live.removeAttribute('viewBox');
    }, 0);
    return live;
  }

  const cropButton = (
    <div className="flex items-center gap-1">
      {cropRect && (
        <button
          type="button"
          onClick={() => setCropRect(null)}
          title="Clear crop"
          className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <X className="h-3 w-3" /> Crop
        </button>
      )}
      <button
        type="button"
        onClick={() => setCropping((v) => !v)}
        title={cropping ? 'Cancel crop selection' : cropRect ? 'Re-select crop region' : 'Drag a rectangle on the chart to crop exports to it'}
        aria-pressed={cropping}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition ${
          cropping
            ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
            : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
        }`}
      >
        <Crop className="h-3 w-3" />
        {cropping ? 'Cancel' : 'Crop'}
      </button>
    </div>
  );

  const decorations = (
    <>
      {cropRect && !cropping && (
        <div className="pointer-events-none absolute inset-0">
          <div
            className="absolute border-2 border-amber-500 bg-amber-500/5"
            style={{ left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }}
          />
          <div className="absolute bg-zinc-900/30 dark:bg-zinc-950/55" style={{ left: 0, top: 0, right: 0, height: cropRect.y }} />
          <div className="absolute bg-zinc-900/30 dark:bg-zinc-950/55" style={{ left: 0, top: cropRect.y + cropRect.h, right: 0, bottom: 0 }} />
          <div className="absolute bg-zinc-900/30 dark:bg-zinc-950/55" style={{ left: 0, top: cropRect.y, width: cropRect.x, height: cropRect.h }} />
          <div className="absolute bg-zinc-900/30 dark:bg-zinc-950/55" style={{ left: cropRect.x + cropRect.w, top: cropRect.y, right: 0, height: cropRect.h }} />
        </div>
      )}
      {cropping && dragRect && dragRect.w > 2 && dragRect.h > 2 && (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-zinc-900 bg-zinc-900/10 dark:border-white dark:bg-white/10"
          style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }}
        />
      )}
      {cropping && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-zinc-900/90 px-3 py-1 text-[11px] text-white shadow-md dark:bg-white/90 dark:text-zinc-900">
          Drag to select crop region · Esc to cancel
        </div>
      )}
    </>
  );

  /** Bitmap-crop counterpart for canvas-rendered charts (force-
   *  graph-2D / -3D). Reads the current cropRect, maps container
   *  pixels into the source canvas's pixel buffer, and returns a
   *  fresh canvas containing only the cropped region. Null source
   *  → null. No crop selected → the source canvas, untouched. */
  function getCanvasForExport(src: HTMLCanvasElement | null): HTMLCanvasElement | null {
    if (!src) return null;
    if (!cropRect || !bodyRef.current) return src;
    const bodyRect = bodyRef.current.getBoundingClientRect();
    const canvasRect = src.getBoundingClientRect();
    const canvasLeft = canvasRect.left - bodyRect.left;
    const canvasTop = canvasRect.top - bodyRect.top;
    const dispToBufX = src.width / canvasRect.width;
    const dispToBufY = src.height / canvasRect.height;
    const cropDispX = Math.max(0, cropRect.x - canvasLeft);
    const cropDispY = Math.max(0, cropRect.y - canvasTop);
    const cropDispW = Math.max(0, Math.min(cropRect.w, canvasRect.width - cropDispX));
    const cropDispH = Math.max(0, Math.min(cropRect.h, canvasRect.height - cropDispY));
    const sx = cropDispX * dispToBufX;
    const sy = cropDispY * dispToBufY;
    const sw = cropDispW * dispToBufX;
    const sh = cropDispH * dispToBufY;
    if (sw < 4 || sh < 4) return src;
    const out = document.createElement('canvas');
    out.width = Math.round(sw);
    out.height = Math.round(sh);
    const ctx = out.getContext('2d');
    if (!ctx) return src;
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  }

  /** Vector-crop counterpart: filter a force-graph graphData down
   *  to nodes whose positions land inside the cropRect, and drop
   *  any link that loses an endpoint. `screen2World` translates
   *  the cropRect (container pixels) into the same coordinate
   *  space the nodes live in. Omit `screen2World` when graphData
   *  already carries screen-pixel coords (e.g. the 3D camera-
   *  projected getter in author-graph). */
  function getCroppedGraphData<N extends { id: string; x?: number; y?: number }, L extends { source: string; target: string }>(
    gd: { nodes: N[]; links: L[] } | null,
    screen2World?: (x: number, y: number) => { x: number; y: number },
  ): { nodes: N[]; links: L[] } | null {
    if (!gd) return null;
    if (!cropRect || !bodyRef.current) return gd;
    let minX: number, minY: number, maxX: number, maxY: number;
    if (screen2World) {
      const a = screen2World(cropRect.x, cropRect.y);
      const b = screen2World(cropRect.x + cropRect.w, cropRect.y + cropRect.h);
      minX = Math.min(a.x, b.x); minY = Math.min(a.y, b.y);
      maxX = Math.max(a.x, b.x); maxY = Math.max(a.y, b.y);
    } else {
      minX = cropRect.x; minY = cropRect.y;
      maxX = cropRect.x + cropRect.w; maxY = cropRect.y + cropRect.h;
    }
    const inside = (n: N) => n.x != null && n.y != null
      && n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY;
    const filteredNodes = gd.nodes.filter(inside);
    const ids = new Set(filteredNodes.map((n) => n.id));
    const filteredLinks = gd.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    return { nodes: filteredNodes, links: filteredLinks };
  }

  return {
    bodyRef,
    cropping,
    cropRect,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    cropButton,
    decorations,
    getSvgForExport,
    getCanvasForExport,
    getCroppedGraphData,
  };
}
