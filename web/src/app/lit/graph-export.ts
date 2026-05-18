/**
 * Tiny helpers for exporting force-graph contents. Shared by the
 * RelatedGraph, AuthorGraph, and KeywordGraph components so they
 * all produce identically-shaped JSON / GraphML files.
 *
 * PNG export is canvas-specific (rasterise the currently rendered
 * canvas) and lives in each component since the canvas ref it
 * needs is per-component state. Only the structure exports live
 * here.
 */

export type ExportNode = {
  id: string;
  label?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
};

export type ExportLink = {
  source: string;
  target: string;
  weight?: number;
};

export function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Composite the canvas onto a solid background, optionally
 *  upscaling for a high-resolution export. The source canvas is
 *  already at the renderer's pixel ratio (usually 2× on retina);
 *  doubling that gives ~4× display-pixel resolution which prints
 *  cleanly. Without this, a dark-theme export renders as
 *  light-text-on-black, which prints unreadably and looks broken
 *  in most image viewers. Returns a data URL the PNG / SVG / PDF
 *  exports all build from. */
function canvasOnBackground(canvas: HTMLCanvasElement, bg: string = '#ffffff', scale: number = 2): {
  dataUrl: string;
  width: number;
  height: number;
} {
  const W = Math.round(canvas.width * scale);
  const H = Math.round(canvas.height * scale);
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const ctx = tmp.getContext('2d');
  if (ctx) {
    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, W, H);
  }
  return { dataUrl: tmp.toDataURL('image/png'), width: W, height: H };
}

export function exportPNGFromCanvas(canvas: HTMLCanvasElement | null, filename: string, bg: string = '#ffffff') {
  if (!canvas) return;
  const { dataUrl } = canvasOnBackground(canvas, bg);
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** SVG-wrapped raster export. True vector-from-canvas isn't
 *  feasible — the force-directed layout is canvas-only — so we
 *  embed the PNG in a minimal SVG envelope. Editable in Inkscape /
 *  Illustrator, scales without quality loss as a single image. */
export function exportSVGFromCanvas(canvas: HTMLCanvasElement | null, filename: string, bg: string = '#ffffff') {
  if (!canvas) return;
  const { dataUrl, width, height } = canvasOnBackground(canvas, bg);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image xlink:href="${dataUrl}" width="${width}" height="${height}"/>
</svg>`;
  downloadBlob(svg, filename, 'image/svg+xml;charset=utf-8');
}

/** PDF export via jsPDF. One page sized to the canvas; lazy-import
 *  so the ~250 KB jsPDF bundle stays out of the initial /lit
 *  payload. */
export async function exportPDFFromCanvas(canvas: HTMLCanvasElement | null, filename: string, bg: string = '#ffffff') {
  if (!canvas) return;
  const { dataUrl, width, height } = canvasOnBackground(canvas, bg);
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({
    orientation: width >= height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [width, height],
  });
  pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
  pdf.save(filename);
}

// ---------------------------------------------------------------
// SVG-source exports — for charts (circular AuthorGraph) where the
// rendered output is already SVG. The canvas-source helpers above
// fail silently on SVG charts (no canvas to grab), so we mirror
// the API with SVG variants. Direct SVG export is a one-line
// serialise; raster (PNG / PDF) goes through an off-screen
// <img> + canvas because browsers don't let you toDataURL an SVG
// element directly.
// ---------------------------------------------------------------

function getSVGSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  const r = svg.getBoundingClientRect();
  return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
}

/** Inline the computed text/fill/stroke colors onto a clone of
 *  the SVG so the exported file renders the same outside the
 *  page's CSS context. Without this, every Tailwind class-driven
 *  color resolves to the document's default. */
function inlineComputedStyles(src: SVGSVGElement): SVGSVGElement {
  const clone = src.cloneNode(true) as SVGSVGElement;
  const srcEls = src.querySelectorAll<SVGElement>('*');
  const cloneEls = clone.querySelectorAll<SVGElement>('*');
  for (let i = 0; i < srcEls.length; i++) {
    const cs = window.getComputedStyle(srcEls[i]);
    const target = cloneEls[i];
    if (!target) continue;
    // Only the colour-ish properties matter for export fidelity;
    // copying everything bloats the file.
    target.style.color = cs.color;
    target.style.fill = cs.fill;
    target.style.stroke = cs.stroke;
    target.style.fontFamily = cs.fontFamily;
    target.style.fontSize = cs.fontSize;
    target.style.opacity = cs.opacity;
  }
  return clone;
}

function serializeSVG(svg: SVGSVGElement, bg: string = '#ffffff'): string {
  const clone = inlineComputedStyles(svg);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  // Strip elements tagged data-export-hide — these are in-chart UI
  // controls (zoom-reset button, hover legends, etc.) that aren't
  // part of the chart proper and shouldn't bleed into the saved
  // file. Cleaner than threading an "exporting" state into every
  // component and conditioning render on it.
  clone.querySelectorAll('[data-export-hide]').forEach((el) => el.remove());
  const { width, height } = getSVGSize(svg);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  // Prepend a background rect so the export reads on light or dark
  // viewers regardless of where it lands. Skipped for transparent.
  if (bg !== 'transparent') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
    rect.setAttribute('width', String(width)); rect.setAttribute('height', String(height));
    rect.setAttribute('fill', bg);
    clone.insertBefore(rect, clone.firstChild);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

export function exportSVGFromElement(svg: SVGSVGElement | null, filename: string, bg: string = '#ffffff') {
  if (!svg) return;
  downloadBlob(serializeSVG(svg, bg), filename, 'image/svg+xml;charset=utf-8');
}

/** Resolution multiplier for SVG→PNG rasterisation. Vector paths
 *  scale losslessly into the larger bitmap, so 3× gives a sharp
 *  result on retina displays and 300-DPI-ish print without any
 *  source-side change. Bumping past 4× starts producing files
 *  large enough to time out the download anchor. */
const EXPORT_RASTER_SCALE = 3;

/** Rasterise an SVG to a data URL via an off-screen <img>. Returns
 *  null when the load fails (some SVG features — foreignObject
 *  with non-same-origin content — get refused by the browser).
 *  Optional `scale` overrides the default high-res multiplier when
 *  a caller wants a 1× preview-sized output. */
function svgToRasterDataURL(svg: SVGSVGElement, bg: string = '#ffffff', scale: number = EXPORT_RASTER_SCALE): Promise<{ dataUrl: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const { width, height } = getSVGSize(svg);
    const svgStr = serializeSVG(svg, bg);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const W = Math.round(width * scale);
      const H = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
      if (bg !== 'transparent') {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: canvas.toDataURL('image/png'), width: W, height: H });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export async function exportPNGFromSVG(svg: SVGSVGElement | null, filename: string, bg: string = '#ffffff') {
  if (!svg) return;
  const raster = await svgToRasterDataURL(svg, bg);
  if (!raster) return;
  const a = document.createElement('a');
  a.href = raster.dataUrl; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function exportPDFFromSVG(svg: SVGSVGElement | null, filename: string, bg: string = '#ffffff') {
  if (!svg) return;
  // Vector PDF via svg2pdf.js — converts SVG paths / text / shapes
  // into native PDF drawing operations rather than rasterising
  // through a canvas. The output is a true vector document that
  // scales cleanly in print + page-zoom.
  //
  // svg2pdf.js needs a clone with inlined computed styles for the
  // same reason direct SVG export does — Tailwind class-driven
  // colours don't resolve outside the page's CSS context.
  const { width, height } = getSVGSize(svg);
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
  ]);
  const pdf = new jsPDF({
    orientation: width >= height ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [width, height],
  });
  const clone = inlineComputedStyles(svg);
  // svg2pdf needs the clone attached to the DOM to measure text;
  // park it off-screen during the conversion.
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  // Background rect — without this svg2pdf leaves the page
  // transparent, which prints as whatever the PDF viewer's
  // theme defaults to (usually black on dark mode readers).
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('x', '0');
  bgRect.setAttribute('y', '0');
  bgRect.setAttribute('width', String(width));
  bgRect.setAttribute('height', String(height));
  bgRect.setAttribute('fill', bg);
  clone.insertBefore(bgRect, clone.firstChild);
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-99999px';
  host.style.top = '0';
  host.style.pointerEvents = 'none';
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    await svg2pdf(clone, pdf, { width, height });
    pdf.save(filename);
  } catch (e) {
    // Fall back to the raster path if svg2pdf trips on something
    // (e.g. an exotic SVG feature it can't translate).
    console.warn('[graph-export] svg2pdf failed, falling back to raster PDF', e);
    const raster = await svgToRasterDataURL(svg, bg);
    if (raster) {
      pdf.addImage(raster.dataUrl, 'PNG', 0, 0, width, height);
      pdf.save(filename);
    }
  } finally {
    document.body.removeChild(host);
  }
}

export function exportGraphJSON(nodes: ExportNode[], links: ExportLink[], filename: string) {
  const out = {
    nodes: nodes.map((n) => ({ id: n.id, label: n.label ?? n.id, ...(n.attrs || {}) })),
    links: links.map((l) => ({ source: l.source, target: l.target, weight: l.weight ?? 1 })),
  };
  downloadBlob(JSON.stringify(out, null, 2), filename, 'application/json;charset=utf-8');
}

export function exportGraphML(nodes: ExportNode[], links: ExportLink[], filename: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Collect every distinct attribute key across nodes for the
  // <key> declarations. GraphML requires keys to be declared
  // up-front; readers like Gephi tolerate extras but emit warnings.
  const attrKeys = new Set<string>();
  for (const n of nodes) for (const k of Object.keys(n.attrs || {})) attrKeys.add(k);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
  lines.push('<key id="label" for="node" attr.name="label" attr.type="string"/>');
  for (const k of attrKeys) {
    lines.push(`<key id="${esc(k)}" for="node" attr.name="${esc(k)}" attr.type="string"/>`);
  }
  lines.push('<key id="weight" for="edge" attr.name="weight" attr.type="double"/>');
  lines.push('<graph id="G" edgedefault="undirected">');
  for (const n of nodes) {
    lines.push(`  <node id="${esc(n.id)}">`);
    lines.push(`    <data key="label">${esc(n.label ?? n.id)}</data>`);
    for (const [k, v] of Object.entries(n.attrs || {})) {
      if (v == null) continue;
      lines.push(`    <data key="${esc(k)}">${esc(String(v))}</data>`);
    }
    lines.push(`  </node>`);
  }
  let i = 0;
  for (const l of links) {
    lines.push(`  <edge id="e${i++}" source="${esc(l.source)}" target="${esc(l.target)}">`);
    lines.push(`    <data key="weight">${l.weight ?? 1}</data>`);
    lines.push(`  </edge>`);
  }
  lines.push('</graph>');
  lines.push('</graphml>');
  downloadBlob(lines.join('\n'), filename, 'application/xml;charset=utf-8');
}
