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

/** Composite the canvas onto a solid background. Without this, a
 *  dark-theme export renders as light-text-on-black, which prints
 *  unreadably and looks broken in most image viewers. Returns a
 *  data URL the PNG / SVG / PDF exports all build from. */
function canvasOnBackground(canvas: HTMLCanvasElement, bg: string = '#ffffff'): {
  dataUrl: string;
  width: number;
  height: number;
} {
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext('2d');
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(canvas, 0, 0);
  }
  return { dataUrl: tmp.toDataURL('image/png'), width: tmp.width, height: tmp.height };
}

export function exportPNGFromCanvas(canvas: HTMLCanvasElement | null, filename: string) {
  if (!canvas) return;
  const { dataUrl } = canvasOnBackground(canvas);
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
export function exportSVGFromCanvas(canvas: HTMLCanvasElement | null, filename: string) {
  if (!canvas) return;
  const { dataUrl, width, height } = canvasOnBackground(canvas);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image xlink:href="${dataUrl}" width="${width}" height="${height}"/>
</svg>`;
  downloadBlob(svg, filename, 'image/svg+xml;charset=utf-8');
}

/** PDF export via jsPDF. One page sized to the canvas; lazy-import
 *  so the ~250 KB jsPDF bundle stays out of the initial /lit
 *  payload. */
export async function exportPDFFromCanvas(canvas: HTMLCanvasElement | null, filename: string) {
  if (!canvas) return;
  const { dataUrl, width, height } = canvasOnBackground(canvas);
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({
    orientation: width >= height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [width, height],
  });
  pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
  pdf.save(filename);
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
