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
  /** Mutated in place by force-simulation libraries (react-force-
   *  graph-2d in particular). Carrying them here lets the exporter
   *  rebuild a true-vector SVG of a canvas-rendered force graph
   *  without an extra round-trip through the canvas. */
  x?: number;
  y?: number;
  /** Optional radius hint for the rendered circle. */
  size?: number;
  /** Optional fill colour; falls back to a neutral default. */
  color?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
};

export type ExportLink = {
  source: string;
  target: string;
  weight?: number;
};

/** Per-export style overrides applied at serialise time. */
export type ExportStyle = {
  /** Background colour for raster outputs and the SVG bg-rect.
   *  Pass 'transparent' to skip painting one (SVG only). */
  bg?: string;
  /** If set, every <text> in the exported SVG is forced to this
   *  font size. Lets the user bump up labels for slide use. */
  fontSize?: number;
  /** If set, every <text>'s fill is forced to this colour. */
  textColor?: string;
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

function applyTextStyle(clone: SVGSVGElement, style?: Pick<ExportStyle, 'fontSize' | 'textColor'>) {
  if (!style || (style.fontSize == null && !style.textColor)) return;
  clone.querySelectorAll<SVGTextElement>('text').forEach((t) => {
    // Belt + suspenders: write the override to every signal a
    // downstream consumer might read.
    //   - inline t.style.* — beats Tailwind utility class CSS
    //     (e.g. fill-zinc-500), beats the inline styles
    //     inlineComputedStyles wrote earlier.
    //   - SVG attribute setAttribute('fill', …) — what svg2pdf
    //     actually reads on text elements; ignores style.fill on
    //     <text> in older builds of the library.
    //   - t.style.color — for elements rendering text via
    //     `fill: currentColor`, the color cascade is what matters.
    // Strip any inherited fill-* class so a class-driven rule can't
    // re-paint the text after we set the explicit color.
    if (style.fontSize != null) {
      t.style.fontSize = `${style.fontSize}px`;
      t.setAttribute('font-size', String(style.fontSize));
    }
    if (style.textColor) {
      t.style.fill = style.textColor;
      t.setAttribute('fill', style.textColor);
      t.style.color = style.textColor;
      // Remove every fill-* class so Tailwind's CSS rule can't win
      // the cascade in environments (svg2pdf, off-screen
      // rasterise) where class selectors still match.
      const cls = (t.getAttribute('class') || '').split(/\s+/).filter((c) => c && !/^fill-/.test(c));
      if (cls.length > 0) t.setAttribute('class', cls.join(' '));
      else t.removeAttribute('class');
    }
  });
}

function serializeSVG(svg: SVGSVGElement, bg: string = '#ffffff', style?: Pick<ExportStyle, 'fontSize' | 'textColor'>): string {
  const clone = inlineComputedStyles(svg);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  // Strip elements tagged data-export-hide — these are in-chart UI
  // controls (zoom-reset button, hover legends, etc.) that aren't
  // part of the chart proper and shouldn't bleed into the saved
  // file. Cleaner than threading an "exporting" state into every
  // component and conditioning render on it.
  clone.querySelectorAll('[data-export-hide]').forEach((el) => el.remove());
  applyTextStyle(clone, style);
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

export function exportSVGFromElement(svg: SVGSVGElement | null, filename: string, bg: string = '#ffffff', style?: Pick<ExportStyle, 'fontSize' | 'textColor'>) {
  if (!svg) return;
  downloadBlob(serializeSVG(svg, bg, style), filename, 'image/svg+xml;charset=utf-8');
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
function svgToRasterDataURL(svg: SVGSVGElement, bg: string = '#ffffff', scale: number = EXPORT_RASTER_SCALE, style?: Pick<ExportStyle, 'fontSize' | 'textColor'>): Promise<{ dataUrl: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const { width, height } = getSVGSize(svg);
    const svgStr = serializeSVG(svg, bg, style);
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

export async function exportPNGFromSVG(svg: SVGSVGElement | null, filename: string, bg: string = '#ffffff', style?: Pick<ExportStyle, 'fontSize' | 'textColor'>) {
  if (!svg) return;
  const raster = await svgToRasterDataURL(svg, bg, EXPORT_RASTER_SCALE, style);
  if (!raster) return;
  const a = document.createElement('a');
  a.href = raster.dataUrl; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function exportPDFFromSVG(svg: SVGSVGElement | null, filename: string, bg: string = '#ffffff', style?: Pick<ExportStyle, 'fontSize' | 'textColor'>) {
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
  // Strip in-chart UI controls (zoom-reset etc.) before they
  // leak into the PDF — same rule serializeSVG applies.
  clone.querySelectorAll('[data-export-hide]').forEach((el) => el.remove());
  applyTextStyle(clone, style);
  // svg2pdf needs the clone attached to the DOM to measure text;
  // park it off-screen during the conversion.
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  // Background rect — without this svg2pdf leaves the page
  // transparent, which prints as whatever the PDF viewer's
  // theme defaults to (usually black on dark mode readers).
  if (bg !== 'transparent') {
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('x', '0');
    bgRect.setAttribute('y', '0');
    bgRect.setAttribute('width', String(width));
    bgRect.setAttribute('height', String(height));
    bgRect.setAttribute('fill', bg);
    clone.insertBefore(bgRect, clone.firstChild);
  }
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
    const raster = await svgToRasterDataURL(svg, bg, EXPORT_RASTER_SCALE, style);
    if (raster) {
      pdf.addImage(raster.dataUrl, 'PNG', 0, 0, width, height);
      pdf.save(filename);
    }
  } finally {
    document.body.removeChild(host);
  }
}

/** Build a true-vector SVG from force-graph node positions. The
 *  positions are mutated onto the node objects by react-force-
 *  graph-2d after the simulation runs; the caller is expected to
 *  pass that same array. Returns null when fewer than two nodes
 *  have positions (nothing useful to plot). */
export function nodesToSVG(
  nodes: ExportNode[],
  links: ExportLink[],
  opts: { bg?: string; fontSize?: number; textColor?: string; nodeFill?: (n: ExportNode) => string } = {},
): SVGSVGElement | null {
  const placed = nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (placed.length < 2) return null;
  const xs = placed.map((n) => n.x!) as number[];
  const ys = placed.map((n) => n.y!) as number[];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const PAD = 60;
  const W = Math.max(320, Math.ceil(maxX - minX + PAD * 2));
  const H = Math.max(240, Math.ceil(maxY - minY + PAD * 2));
  const tx = (x: number) => x - minX + PAD;
  const ty = (y: number) => y - minY + PAD;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg') as SVGSVGElement;
  svg.setAttribute('xmlns', svgNS);
  svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));

  if (opts.bg && opts.bg !== 'transparent') {
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', String(W)); bg.setAttribute('height', String(H));
    bg.setAttribute('fill', opts.bg);
    svg.appendChild(bg);
  }

  // Quick lookup for source/target → node so we can rebuild edges
  // even when the link records carry only string ids.
  const byId = new Map<string, ExportNode>();
  for (const n of placed) byId.set(n.id, n);

  // Edges first so node circles sit on top.
  for (const l of links) {
    const s = byId.get(l.source);
    const t = byId.get(l.target);
    if (!s || !t) continue;
    if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(tx(s.x)));
    line.setAttribute('y1', String(ty(s.y)));
    line.setAttribute('x2', String(tx(t.x)));
    line.setAttribute('y2', String(ty(t.y)));
    line.setAttribute('stroke', opts.bg === '#0b0d10' ? '#a1a1aa' : '#52525b');
    line.setAttribute('stroke-opacity', '0.45');
    line.setAttribute('stroke-width', String(0.6 + Math.min(2.4, ((l.weight ?? 1)) * 0.4)));
    svg.appendChild(line);
  }

  const textFill = opts.textColor || (opts.bg === '#0b0d10' ? '#e4e4e7' : '#27272a');
  const fontSize = opts.fontSize ?? 11;

  for (const n of placed) {
    const r = Math.max(3, n.size ?? 6);
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(tx(n.x!)));
    circle.setAttribute('cy', String(ty(n.y!)));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', opts.nodeFill?.(n) ?? n.color ?? '#3b82f6');
    circle.setAttribute('stroke', opts.bg === '#0b0d10' ? '#18181b' : '#ffffff');
    circle.setAttribute('stroke-width', '0.6');
    svg.appendChild(circle);

    if (n.label) {
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', String(tx(n.x!)));
      text.setAttribute('y', String(ty(n.y!) - r - 4));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      text.setAttribute('font-size', String(fontSize));
      // Both attribute + inline style so svg2pdf and the off-screen
      // rasteriser see the same colour regardless of which signal
      // each one prefers to read.
      text.setAttribute('fill', textFill);
      text.style.fill = textFill;
      // Truncate long labels — a force graph with 80+ authors
      // makes the page unreadable if every label runs full.
      text.textContent = n.label.length > 32 ? n.label.slice(0, 31) + '…' : n.label;
      svg.appendChild(text);
    }
  }

  return svg;
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
