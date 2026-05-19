'use client';

/**
 * Co-author network for the author hub. Aggregates the visible
 * paper set into authors-as-nodes and co-authorship-as-edges, then
 * renders in one of two layouts:
 *
 *   force    — force-directed (react-force-graph-2d). Reveals
 *              tightly-collaborating clusters and isolated authors.
 *   circular — every author placed evenly on a ring, edges drawn
 *              as straight segments across. Pure SVG. More legible
 *              than force for small N; reveals all edges at once.
 *
 * Capped at the top 40 authors by paper count so the layout stays
 * readable on the lit-explorer column. Click an author to chain
 * into a new author-hub search.
 */
import { useMemo, useState, useRef, useEffect } from 'react';
import dynamic from 'next/dynamic';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { FullscreenShell } from './fullscreen-shell';
import { GraphExportMenu, type ExportFontSize, type ExportTextColor } from './graph-export-menu';
import { useCropRegion } from './use-crop-region';

/** Three.js / react-force-graph-3d for the 3D layout. Loaded
 *  dynamically (ssr:false) so the ~400KB-gz WebGL stack stays
 *  out of the initial /lit bundle for users who never open this
 *  view. */
const ForceGraph3D = dynamic(() => import('react-force-graph-3d'), { ssr: false });
type ForceGraph3DMethodsLike = { scene: () => unknown; renderer: () => { domElement: HTMLCanvasElement } };

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

type Paper = {
  authors?: string | { name?: string }[];
};

const MAX_AUTHORS = 40;

type CoAuthorNode = {
  id: string;
  label: string;
  papers: number;
  isFocal: boolean;
  /** d3-force mutates these; declared so the canvas drawer can read them. */
  x?: number; y?: number;
};

type CoAuthorLink = { source: string; target: string; weight: number };

function namesOf(p: Paper): string[] {
  if (typeof p.authors === 'string') {
    return p.authors.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return (p.authors || []).map((a) => (a.name || '').trim()).filter(Boolean);
}

export function AuthorGraph({
  papers,
  focalAuthor,
  onAuthorClick,
}: {
  papers: Paper[];
  focalAuthor?: string;
  onAuthorClick?: (name: string) => void;
}) {
  const [layout, setLayout] = useState<'force' | 'circular' | 'arc' | 'bundled' | '3d'>('force');
  /** Read the active page theme so the graph background matches
   *  by default instead of always starting on light. The user can
   *  still override via the BG toggle; this only sets the initial
   *  value. Sepia is treated as a light variant. Falls back to
   *  prefers-color-scheme when the theme is set to system. */
  const detectInitialBg = (): 'light' | 'dark' => {
    if (typeof document === 'undefined') return 'light';
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return 'dark';
    if (t === 'light' || t === 'sepia') return 'light';
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  };
  // bgMode independent of the page theme so an export looks the
  // same regardless of whether the user is browsing in light or
  // dark mode. Defaults to 'light' because the most common export
  // target (print, slides, papers) is a white background. The
  // user can flip to dark for in-app review.
  const [bgMode, setBgMode] = useState<'light' | 'dark'>(() => detectInitialBg());
  // Node-spacing preset for the force / 3d layouts. Threads
  // through linkDistance + d3 charge strength so the user can
  // spread crowded clusters out. SVG-positioned layouts
  // (circular / arc / bundled) compute their own positions and
  // ignore this.
  const [spacing, setSpacing] = useState<'tight' | 'normal' | 'loose'>('normal');
  const linkDistanceFor = (kind: 'tight' | 'normal' | 'loose') =>
    kind === 'tight' ? 18 : kind === 'loose' ? 80 : 36;
  const isForceLayout = layout === 'force' || layout === '3d';

  // react-force-graph-2d / -3d don't expose linkDistance as a
  // direct prop — push the value into the underlying d3 force
  // via the imperative API whenever the spacing preset changes
  // and reheat so the new distance actually applies.
  useEffect(() => {
    if (layout !== 'force') return;
    const ref = graphRef.current as unknown as { d3Force?: (name: string) => { distance?: (n: number) => unknown } | undefined; d3ReheatSimulation?: () => void } | undefined;
    const link = ref?.d3Force?.('link');
    if (link && typeof link.distance === 'function') {
      link.distance(linkDistanceFor(spacing));
      ref?.d3ReheatSimulation?.();
    }
  }, [spacing, layout]);
  useEffect(() => {
    if (layout !== '3d') return;
    const ref = fg3dRef.current as unknown as { d3Force?: (name: string) => { distance?: (n: number) => unknown } | undefined; d3ReheatSimulation?: () => void } | null;
    const link = ref?.d3Force?.('link');
    if (link && typeof link.distance === 'function') {
      link.distance(linkDistanceFor(spacing));
      ref?.d3ReheatSimulation?.();
    }
  }, [spacing, layout]);
  // Export font / text-colour state lifted up so the toolbar
  // instance and the fullscreen-extras instance of the Export
  // menu share a single source of truth instead of each tracking
  // its own selection.
  const [exportFontSize, setExportFontSize] = useState<ExportFontSize>('M');
  const [exportTextColor, setExportTextColor] = useState<ExportTextColor>('auto');
  const isDarkBg = bgMode === 'dark';
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  const fg3dRef = useRef<ForceGraph3DMethodsLike | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Region-select crop. Only meaningful when the active layout
  // renders to an SVG (circular / arc / bundled); the force and
  // 3d layouts paint to a canvas / WebGL context where this
  // viewBox-mutation approach doesn't apply, so the crop button
  // hides for those.
  const crop = useCropRegion(svgRef);
  const isSvgLayout = layout === 'circular' || layout === 'arc' || layout === 'bundled';
  // Zoom + pan state for the circular SVG. Force layout already
  // has react-force-graph-2d's built-in wheel zoom; SVG needs its
  // own. tx/ty are in viewBox units, scale is multiplicative.
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  // Chord-diagram selection: click a chord ribbon or a node circle
  // to highlight it (and dim everything else). null clears the
  // highlight; clicking the same target again toggles it off.
  type ChordSel =
    | { kind: 'link'; sId: string; tId: string; weight: number }
    | { kind: 'node'; id: string };
  const [chordSel, setChordSel] = useState<ChordSel | null>(null);
  const dragRef = useRef<{ startClientX: number; startClientY: number; startTx: number; startTy: number } | null>(null);
  function resetView() { setView({ scale: 1, tx: 0, ty: 0 }); }
  // Pan / zoom / wheel handlers below short-circuit when the
  // user is in crop-selection mode so the marquee drag doesn't
  // race the chart-drag.
  function onSvgWheel(e: React.WheelEvent<SVGSVGElement>) {
    if (crop.cropping) return;
    e.preventDefault();
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    // Convert pointer pixel coords to viewBox coords.
    const vb = svg.viewBox.baseVal;
    const px = ((e.clientX - rect.left) / rect.width) * vb.width;
    const py = ((e.clientY - rect.top) / rect.height) * vb.height;
    setView((v) => {
      const factor = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      const nextScale = Math.max(0.5, Math.min(6, v.scale * factor));
      // Keep the point under the cursor invariant during zoom.
      const k = nextScale / v.scale;
      const tx = px - (px - v.tx) * k;
      const ty = py - (py - v.ty) * k;
      return { scale: nextScale, tx, ty };
    });
  }
  function onSvgMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    if (crop.cropping) return;
    if (e.button !== 0) return;
    dragRef.current = {
      startClientX: e.clientX, startClientY: e.clientY,
      startTx: view.tx, startTy: view.ty,
    };
  }
  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (crop.cropping) return;
    const d = dragRef.current;
    if (!d) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const dx = ((e.clientX - d.startClientX) / rect.width) * vb.width;
    const dy = ((e.clientY - d.startClientY) / rect.height) * vb.height;
    setView((v) => ({ scale: v.scale, tx: d.startTx + dx, ty: d.startTy + dy }));
  }
  function onSvgMouseUp() { dragRef.current = null; }

  const { nodes, links } = useMemo(() => {
    // Tally paper counts per author + pairwise co-paper counts.
    const paperCount = new Map<string, number>();
    const edgeWeight = new Map<string, number>();
    for (const p of papers) {
      const names = namesOf(p);
      for (const n of names) paperCount.set(n, (paperCount.get(n) ?? 0) + 1);
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const [a, b] = names[i] < names[j] ? [names[i], names[j]] : [names[j], names[i]];
          const k = `${a}||${b}`;
          edgeWeight.set(k, (edgeWeight.get(k) ?? 0) + 1);
        }
      }
    }
    // Keep top N + always-include the focal author if present.
    const sorted = [...paperCount.entries()].sort((a, b) => b[1] - a[1]);
    const kept = new Set<string>();
    for (let i = 0; i < Math.min(MAX_AUTHORS, sorted.length); i++) kept.add(sorted[i][0]);
    if (focalAuthor && paperCount.has(focalAuthor)) kept.add(focalAuthor);
    const orderedNames = [...kept].sort((a, b) => (paperCount.get(b) ?? 0) - (paperCount.get(a) ?? 0));
    const ns: CoAuthorNode[] = orderedNames.map((name) => ({
      id: name,
      label: name,
      papers: paperCount.get(name) ?? 0,
      isFocal: focalAuthor === name,
    }));
    const ls: CoAuthorLink[] = [];
    for (const [k, w] of edgeWeight) {
      const [a, b] = k.split('||');
      if (kept.has(a) && kept.has(b)) ls.push({ source: a, target: b, weight: w });
    }
    return { nodes: ns, links: ls };
  }, [papers, focalAuthor]);

  if (nodes.length === 0) {
    return (
      <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
        No author data on the loaded papers.
      </p>
    );
  }

  // Was tied to the page theme; now driven by the bgMode toggle so
  // export and in-graph rendering stay in sync regardless of theme.
  const isDark = isDarkBg;
  function nodeRadius(n: CoAuthorNode): number {
    if (n.isFocal) return 12;
    return 4 + Math.min(10, Math.log2(1 + n.papers) * 2);
  }
  function nodeFill(n: CoAuthorNode): string {
    if (n.isFocal) return '#1e40af';
    return isDark ? '#a1a1aa' : '#52525b';
  }

  // Circular layout: deterministic, hand-positioned. Sorted by
  // paper count desc so the heaviest contributor sits at the top of
  // the ring; the focal author is always pinned there if present.
  const circular = useMemo(() => {
    const W = 760, H = 520;
    const cx = W / 2, cy = H / 2;
    const radius = Math.min(W, H) / 2 - 80;
    const ordered = [...nodes].sort((a, b) => {
      if (a.isFocal) return -1;
      if (b.isFocal) return 1;
      return b.papers - a.papers;
    });
    const positions = new Map<string, { x: number; y: number }>();
    ordered.forEach((n, i) => {
      const angle = (i / ordered.length) * 2 * Math.PI - Math.PI / 2;
      positions.set(n.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    });
    return { W, H, positions, ordered };
  }, [nodes]);

  function canvasEl(): HTMLCanvasElement | null {
    return (containerRef.current?.querySelector('canvas') as HTMLCanvasElement | null) ?? null;
  }
  // Exports branch on the active layout. Force renders to a canvas
  // Export negotiation moved into <GraphExportMenu />. The menu
  // reads the active layout each click via the source factories,
  // picks the right canvas / svg path, and passes the current
  // bgMode through to the file so the BG choice actually lands in
  // the saved output. Renders both in the inline toolbar and (via
  // a shared element) as a FullscreenShell extras slot, so the
  // user can still trigger an export while the chart is maximised.
  const exportMenuEl = (
    <GraphExportMenu
      filename="lit-coauthors"
      source={{
        // 3D shares the canvas path (PNG only — WebGL has no
        // vector equivalent, so SVG / PDF fall back to PNG-
        // wrapped via the canvas helpers).
        canvasEl: () => {
          if (layout === 'force') return canvasEl();
          if (layout === '3d') return fg3dRef.current?.renderer().domElement ?? null;
          return null;
        },
        // Route through the crop hook so any saved crop region
        // applies at export time. When no region is selected this
        // returns the live SVG unchanged.
        svgEl: () => isSvgLayout ? crop.getSvgForExport() : null,
        graphData: {
          // Carry x/y/size so the exporter can rebuild a true-
          // vector SVG of the force layout via nodesToSVG.
          nodes: nodes.map((n) => ({
            id: n.id,
            label: n.label,
            x: n.x,
            y: n.y,
            size: nodeRadius(n),
            color: nodeFill(n),
            attrs: { papers: n.papers, isFocal: n.isFocal },
          })),
          links: links.map((l) => ({
            source: typeof l.source === 'object' && l.source !== null ? (l.source as { id: string }).id : (l.source as string),
            target: typeof l.target === 'object' && l.target !== null ? (l.target as { id: string }).id : (l.target as string),
            weight: l.weight,
          })),
        },
      }}
      bg={bgMode}
      onBgChange={setBgMode}
      fontSize={exportFontSize}
      onFontSizeChange={setExportFontSize}
      textColor={exportTextColor}
      onTextColorChange={setExportTextColor}
    />
  );

  return (
    <div ref={containerRef} className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Co-author network — {nodes.length} authors, {links.length} edges</span>
        <span className="text-zinc-300 dark:text-zinc-700">|</span>
        {isSvgLayout && crop.cropButton}
        {exportMenuEl}
        <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => setBgMode('light')}
            title="Light background — for exports targeting white pages"
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              bgMode === 'light'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            BG ☀
          </button>
          <button
            type="button"
            onClick={() => setBgMode('dark')}
            title="Dark background — for slides / dark presentations"
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              bgMode === 'dark'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            BG ☾
          </button>
        </div>
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => setLayout('force')}
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              layout === 'force'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            Force
          </button>
          <button
            type="button"
            onClick={() => setLayout('circular')}
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              layout === 'circular'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            Circular
          </button>
          <button
            type="button"
            onClick={() => setLayout('arc')}
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              layout === 'arc'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            Arc
          </button>
          <button
            type="button"
            onClick={() => setLayout('bundled')}
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              layout === 'bundled'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            Bundled
          </button>
          <button
            type="button"
            onClick={() => setLayout('3d')}
            title="WebGL 3D force-directed view — orbit by drag, zoom by wheel"
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              layout === '3d'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            3D
          </button>
        </div>
        {isForceLayout && (
          <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-900" title="Spread nodes further apart (force-layout only).">
            {(['tight', 'normal', 'loose'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpacing(s)}
                className={`rounded-full px-2 py-0.5 transition ${
                  spacing === s
                    ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {layout === 'arc' ? (
        <FullscreenShell extras={({ fullscreen }) => fullscreen ? exportMenuEl : null}>
          {() => (
            <div
              ref={crop.bodyRef}
              className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 ${crop.cropping ? 'cursor-crosshair select-none' : ''}`}
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
              onMouseDown={crop.onMouseDown}
              onMouseMove={crop.onMouseMove}
              onMouseUp={crop.onMouseUp}
              onMouseLeave={crop.onMouseUp}
            >
              <ArcDiagram
                nodes={circular.ordered}
                links={links}
                isDark={isDark}
                onAuthorClick={onAuthorClick}
                svgRef={svgRef}
              />
              {crop.decorations}
            </div>
          )}
        </FullscreenShell>
      ) : layout === 'bundled' ? (
        <FullscreenShell extras={({ fullscreen }) => fullscreen ? exportMenuEl : null}>
          {() => (
            <div
              ref={crop.bodyRef}
              className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 ${crop.cropping ? 'cursor-crosshair select-none' : ''}`}
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
              onMouseDown={crop.onMouseDown}
              onMouseMove={crop.onMouseMove}
              onMouseUp={crop.onMouseUp}
              onMouseLeave={crop.onMouseUp}
            >
              <BundledDiagram
                nodes={circular.ordered}
                links={links}
                isDark={isDark}
                onAuthorClick={onAuthorClick}
                svgRef={svgRef}
              />
              {crop.decorations}
            </div>
          )}
        </FullscreenShell>
      ) : layout === '3d' ? (
        <FullscreenShell extras={({ fullscreen }) => fullscreen ? exportMenuEl : null}>
          {({ width, height }) => (
            <div
              className="h-full w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
            >
              {/* preserveDrawingBuffer:true so canvas.toDataURL()
                * (the path GraphExportMenu's PNG export uses) gets
                * back actual pixels instead of black on WebGL.
                * Always-visible name labels via three-spritetext —
                * react-force-graph-3d's built-in nodeLabel is
                * hover-only, which made the 3D layout effectively
                * unidentifiable without a tooltip pass. */}
              {(() => {
                const FG = ForceGraph3D as unknown as React.ComponentType<Record<string, unknown>>;
                return (
                  <FG
                    key={`3d-${spacing}`}
                    ref={((inst: unknown) => { fg3dRef.current = inst as ForceGraph3DMethodsLike | null; })}
                    width={width}
                    height={height}
                    graphData={{ nodes, links }}
                    backgroundColor={isDarkBg ? '#0b0d10' : '#fafafa'}
                    nodeRelSize={6}
                    nodeColor={(n: unknown) => (n as CoAuthorNode).isFocal ? '#1e40af' : (isDark ? '#a1a1aa' : '#52525b')}
                    nodeVal={(n: unknown) => Math.max(1, (n as CoAuthorNode).papers)}
                    nodeLabel={(n: unknown) => `${(n as CoAuthorNode).label} · ${(n as CoAuthorNode).papers} paper${(n as CoAuthorNode).papers === 1 ? '' : 's'}`}
                    // Always-visible sprite labels next to each node.
                    nodeThreeObjectExtend
                    nodeThreeObject={(node: unknown) => {
                      const n = node as CoAuthorNode;
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const SpriteText = require('three-spritetext').default;
                      const sprite = new SpriteText(n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label);
                      sprite.color = isDark ? '#e4e4e7' : '#27272a';
                      sprite.textHeight = 4;
                      // Offset above the node so the sphere stays
                      // clear of the text glyph.
                      sprite.position.set(0, 6 + Math.log2(1 + n.papers) * 1.5, 0);
                      return sprite;
                    }}
                    linkColor={() => isDark ? 'rgba(161,161,170,0.5)' : 'rgba(82,82,91,0.55)'}
                    linkWidth={(l: unknown) => {
                      const w = (l as CoAuthorLink).weight || 1;
                      return Math.max(0.6, Math.min(6, 0.6 + w * 0.6));
                    }}
                    onNodeClick={(n: unknown) => onAuthorClick?.((n as CoAuthorNode).id)}
                    rendererConfig={{ preserveDrawingBuffer: true, antialias: true }}
                    cooldownTicks={120}
                    showNavInfo={false}
                  />
                );
              })()}
            </div>
          )}
        </FullscreenShell>
      ) : layout === 'force' ? (
        <FullscreenShell extras={({ fullscreen }) => fullscreen ? exportMenuEl : null}>
          {({ width, height }) => (
            <div
              className="h-full w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
            >
              <ForceGraph2D
                key={`bg-${bgMode}-${spacing}`}
                ref={graphRef as unknown as React.RefObject<ForceGraphMethods>}
                width={width}
                height={height}
                graphData={{ nodes, links }}
                backgroundColor={isDarkBg ? '#0b0d10' : '#fafafa'}
                nodeRelSize={6}
                nodeCanvasObject={(raw, ctx, globalScale) => {
                  const n = raw as CoAuthorNode;
                  const r = nodeRadius(n);
                  const x = n.x ?? 0; const y = n.y ?? 0;
                  ctx.beginPath();
                  ctx.arc(x, y, r, 0, Math.PI * 2);
                  ctx.fillStyle = nodeFill(n);
                  ctx.fill();
                  if (n.isFocal) {
                    ctx.strokeStyle = isDark ? '#fafafa' : '#18181b';
                    ctx.lineWidth = 2 / globalScale;
                    ctx.stroke();
                  }
                  if (globalScale > 0.8) {
                    ctx.fillStyle = isDark ? '#fafafa' : '#18181b';
                    ctx.font = `${(n.isFocal ? 11 : 9) / globalScale}px ui-sans-serif, system-ui`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(n.label, x, y + r + 2 / globalScale);
                  }
                }}
                linkColor={() => isDark ? 'rgba(161,161,170,0.35)' : 'rgba(82,82,91,0.4)'}
                linkWidth={(l) => {
                  // Linear scaling — one collaboration is ~1 px,
                  // ten is ~8 px. Direct mapping reads as the
                  // actual collaboration count instead of the
                  // gentler log-scaled variant we had before.
                  const w = (l as unknown as CoAuthorLink).weight || 1;
                  return Math.max(0.8, Math.min(8, 0.6 + w * 0.7));
                }}
                onNodeClick={(node) => {
                  const n = node as CoAuthorNode;
                  if (onAuthorClick) onAuthorClick(n.id);
                }}
                cooldownTicks={100}
                minZoom={0.4}
                maxZoom={6}
              />
            </div>
          )}
        </FullscreenShell>
      ) : (
        <FullscreenShell extras={({ fullscreen }) => fullscreen ? exportMenuEl : null}>
          {() => (
            <div
              ref={crop.bodyRef}
              className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 ${crop.cropping ? 'cursor-crosshair select-none' : ''}`}
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
              onMouseDown={crop.onMouseDown}
              onMouseMove={crop.onMouseMove}
              onMouseUp={crop.onMouseUp}
              onMouseLeave={crop.onMouseUp}
            >
              {/* Chord-selection readout floats over the chart so
                * it stays visible when the user maximises into
                * fullscreen (the shell is fixed inset-0; anything
                * rendered outside it would be covered). z-10
                * stays well below the maximise button (z-10 too,
                * but positioned right while we're top-left). */}
              <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-[calc(100%-3rem)]">
                <div className="pointer-events-auto">
                  <ChordInfoBar
                    sel={chordSel}
                    nodes={nodes}
                    links={links}
                    onClear={() => setChordSel(null)}
                  />
                </div>
              </div>
              <svg
                ref={svgRef}
                viewBox={`0 0 ${circular.W} ${circular.H}`}
                preserveAspectRatio="xMidYMid meet"
                className={`block h-full w-full ${dragRef.current ? 'cursor-grabbing' : 'cursor-grab'}`}
                onWheel={onSvgWheel}
                onMouseDown={onSvgMouseDown}
                onMouseMove={onSvgMouseMove}
                onMouseUp={onSvgMouseUp}
                onMouseLeave={onSvgMouseUp}
                onClick={(e) => {
                  // Click on bare SVG (not on a chord ribbon or
                  // node circle, which both stopPropagation)
                  // clears any active selection.
                  if (e.target === e.currentTarget) setChordSel(null);
                }}
              >
                <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
                {/* Edges first so nodes sit on top. Explicit colour
                  *  (no currentColor) so the edges remain visible
                  *  regardless of which Tailwind text-* class might
                  *  cascade down from a fullscreen wrapper.
                  *  Stroke + opacity tuned so a single co-paper
                  *  edge is still legible against the panel bg; in
                  *  practice the user couldn't see the previous
                  *  zinc-500/0.55 setup. */}
                {links.map((l, i) => {
                  // react-force-graph-2d mutates link.source /
                  // link.target into resolved node objects after
                  // the force simulation runs; resolve to id
                  // either way for the Map lookup.
                  const sId = typeof l.source === 'object' && l.source !== null
                    ? (l.source as { id: string }).id : l.source;
                  const tId = typeof l.target === 'object' && l.target !== null
                    ? (l.target as { id: string }).id : l.target;
                  const a = circular.positions.get(sId);
                  const b = circular.positions.get(tId);
                  if (!a || !b) return null;
                  // Chord-style: a quadratic Bezier whose control
                  // point sits at the centre of the ring pulls every
                  // arc through the middle, producing the bundled
                  // look of D3's chord layout. Width scales linearly
                  // with the co-authorship count so a 5-paper chord
                  // is visibly ~5× a 1-paper chord. Capped at 12
                  // px so a single very heavy collaborator pair
                  // doesn't crowd the rest off the canvas.
                  const widthScale = Math.max(1.2, Math.min(12, 1.4 + l.weight * 0.8));
                  const baseOpacity = Math.min(0.95, 0.65 + Math.log2(1 + l.weight) * 0.1);
                  const cx = circular.W / 2;
                  const cy = circular.H / 2;
                  const path = `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`;
                  const isSelected = chordSel?.kind === 'link' && chordSel.sId === sId && chordSel.tId === tId;
                  const touchesSelectedNode = chordSel?.kind === 'node' && (chordSel.id === sId || chordSel.id === tId);
                  const dim = chordSel != null && !isSelected && !touchesSelectedNode;
                  const opacity = isSelected ? 1 : dim ? baseOpacity * 0.18 : baseOpacity;
                  const stroke = isSelected
                    ? '#2563eb'
                    : isDark ? '#e4e4e7' : '#27272a';
                  return (
                    <path
                      key={`e-${i}`}
                      d={path}
                      fill="none"
                      stroke={stroke}
                      strokeOpacity={opacity}
                      strokeWidth={isSelected ? widthScale + 1.5 : widthScale}
                      strokeLinecap="round"
                      className="cursor-pointer transition-[stroke-opacity,stroke-width] duration-150"
                      onClick={(e) => {
                        e.stopPropagation();
                        setChordSel((prev) =>
                          prev?.kind === 'link' && prev.sId === sId && prev.tId === tId
                            ? null
                            : { kind: 'link', sId, tId, weight: l.weight },
                        );
                      }}
                    >
                      <title>{`${sId} ↔ ${tId} · ${l.weight} shared paper${l.weight === 1 ? '' : 's'}`}</title>
                    </path>
                  );
                })}
                {links.length === 0 && (
                  <text
                    x={circular.W / 2} y={circular.H / 2}
                    textAnchor="middle" dominantBaseline="middle"
                    fill={isDark ? '#a1a1aa' : '#52525b'}
                    className="text-[12px]"
                  >
                    No co-authorship edges in this set.
                  </text>
                )}
            {circular.ordered.map((n) => {
              const pos = circular.positions.get(n.id)!;
              const r = nodeRadius(n);
              const angle = Math.atan2(pos.y - circular.H / 2, pos.x - circular.W / 2);
              // Label sits outward from the node, rotated tangentially
              // so it reads horizontally along the ring.
              const lx = pos.x + (r + 8) * Math.cos(angle);
              const ly = pos.y + (r + 8) * Math.sin(angle);
              const rotate = (angle * 180) / Math.PI;
              const flip = rotate > 90 || rotate < -90;
              const nodeSelected = chordSel?.kind === 'node' && chordSel.id === n.id;
              const linkTouches = chordSel?.kind === 'link' && (chordSel.sId === n.id || chordSel.tId === n.id);
              const focused = nodeSelected || linkTouches || n.isFocal;
              const dim = chordSel != null && !nodeSelected && !linkTouches && !n.isFocal;
              return (
                <g key={`n-${n.id}`} opacity={dim ? 0.35 : 1}>
                  <circle
                    cx={pos.x} cy={pos.y} r={nodeSelected ? r + 2 : r}
                    fill={nodeSelected ? '#2563eb' : nodeFill(n)}
                    stroke={focused ? (isDark ? '#fafafa' : '#18181b') : 'none'}
                    strokeWidth={focused ? 2 : 0}
                    className="cursor-pointer transition-[r,fill] duration-150"
                    // Single-tap toggles chord-selection so the user
                    // can drill into one author's connections. The
                    // navigate-to-profile action stays on the label
                    // text below so a quick click doesn't whisk the
                    // user off the page.
                    onClick={(e) => {
                      e.stopPropagation();
                      setChordSel((prev) =>
                        prev?.kind === 'node' && prev.id === n.id
                          ? null
                          : { kind: 'node', id: n.id },
                      );
                    }}
                  >
                    <title>{`${n.label} · ${n.papers} paper${n.papers === 1 ? '' : 's'} — click to highlight`}</title>
                  </circle>
                  <text
                    x={lx} y={ly}
                    transform={`rotate(${flip ? rotate + 180 : rotate} ${lx} ${ly})`}
                    textAnchor={flip ? 'end' : 'start'}
                    dominantBaseline="middle"
                    className="cursor-pointer fill-zinc-700 text-[10px] hover:underline dark:fill-zinc-300"
                    onClick={(e) => { e.stopPropagation(); onAuthorClick?.(n.id); }}
                  >
                    <title>Open author profile</title>
                    {n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}
                  </text>
                </g>
              );
            })}
                </g>
                {(view.scale !== 1 || view.tx !== 0 || view.ty !== 0) && (
                  <g
                    transform={`translate(${circular.W - 18} 18)`}
                    onClick={resetView}
                    className="cursor-pointer"
                    /* In-graph UI control — strip from exports so
                     * the saved file is the chart, not the chart
                     * plus a stray reset arrow in the corner. */
                    data-export-hide="true"
                  >
                    <circle r="12" fill={isDark ? '#27272a' : '#ffffff'} stroke={isDark ? '#52525b' : '#d4d4d8'} strokeWidth="1" />
                    <text textAnchor="middle" dominantBaseline="central" fill={isDark ? '#d4d4d8' : '#52525b'} className="text-[10px]">
                      ⤺
                    </text>
                  </g>
                )}
              </svg>
              {crop.decorations}
            </div>
          )}
        </FullscreenShell>
      )}
    </div>
  );
}

/** Hierarchical edge-bundling layout. Authors are clustered by the
 *  first letter of their last name, clusters are placed around a
 *  ring, authors are positioned in a small arc near their cluster
 *  centroid, and every edge is a cubic Bezier that passes through
 *  both endpoints' cluster centroids — so edges between the same
 *  letter cluster fan out from one point, and cross-cluster edges
 *  produce the bundled-tree look from the Holten 2006 paper.
 *  Vector-native, so PDF / SVG export is clean. */
function BundledDiagram({
  nodes,
  links,
  isDark,
  onAuthorClick,
  svgRef,
}: {
  nodes: CoAuthorNode[];
  links: CoAuthorLink[];
  isDark: boolean;
  onAuthorClick?: (id: string) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const W = 760;
  const H = 520;
  const cx = W / 2;
  const cy = H / 2;
  const ringR = Math.min(W, H) / 2 - 60;
  // Bezier control points sit at a fraction of the ring radius
  // toward the center — this is the "bundling tightness". 0.55
  // hits the sweet spot for ~30 authors: cross-cluster edges
  // visibly bundle without merging into a black mass.
  const TIGHTNESS = 0.55;

  // Cluster by first letter of the part after the last space (the
  // last-name surname for "First Last" forms; for "Last, First"
  // forms it still picks a sensible cluster). Fall back to '?'.
  const clusterKey = (name: string): string => {
    const trimmed = (name || '').trim();
    if (!trimmed) return '?';
    if (trimmed.includes(',')) return trimmed[0].toUpperCase();
    const parts = trimmed.split(/\s+/);
    return (parts[parts.length - 1][0] || '?').toUpperCase();
  };

  // Group nodes by cluster, sort cluster keys alphabetically.
  const buckets = new Map<string, CoAuthorNode[]>();
  for (const n of nodes) {
    const k = clusterKey(n.label);
    const arr = buckets.get(k) ?? [];
    arr.push(n);
    buckets.set(k, arr);
  }
  const clusterKeys = [...buckets.keys()].sort();
  const clusterCount = clusterKeys.length || 1;

  // Cluster centroids around the ring.
  const clusterAngle = new Map<string, number>();
  clusterKeys.forEach((k, i) => {
    const a = (i / clusterCount) * 2 * Math.PI - Math.PI / 2;
    clusterAngle.set(k, a);
  });

  // Per-author positions: spread within a small arc around the
  // cluster centroid. Arc width scales with the cluster's size so
  // a 10-author cluster doesn't crowd a 2-author one off the ring.
  const positions = new Map<string, { x: number; y: number; ang: number }>();
  for (const k of clusterKeys) {
    const members = buckets.get(k)!;
    const baseAng = clusterAngle.get(k)!;
    const spread = Math.min(0.6, 0.1 + members.length * 0.04);
    members.forEach((n, i) => {
      const t = members.length === 1 ? 0 : (i / (members.length - 1) - 0.5);
      const a = baseAng + t * spread;
      positions.set(n.id, {
        x: cx + ringR * Math.cos(a),
        y: cy + ringR * Math.sin(a),
        ang: a,
      });
    });
  }

  // Control point for a cluster — sits on the line from origin to
  // cluster centroid at TIGHTNESS scale.
  const controlFor = (key: string) => {
    const a = clusterAngle.get(key)!;
    return { x: cx + ringR * TIGHTNESS * Math.cos(a), y: cy + ringR * TIGHTNESS * Math.sin(a) };
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="block h-full w-full"
    >
      {/* edges first (under nodes) */}
      {links.map((l, i) => {
        const sId = typeof l.source === 'object' && l.source !== null
          ? (l.source as { id: string }).id : l.source;
        const tId = typeof l.target === 'object' && l.target !== null
          ? (l.target as { id: string }).id : l.target;
        const sNode = nodes.find((n) => n.id === sId);
        const tNode = nodes.find((n) => n.id === tId);
        if (!sNode || !tNode) return null;
        const a = positions.get(sId);
        const b = positions.get(tId);
        if (!a || !b) return null;
        const c1 = controlFor(clusterKey(sNode.label));
        const c2 = controlFor(clusterKey(tNode.label));
        const path = `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
        const sw = Math.max(0.6, Math.min(5, 0.6 + l.weight * 0.5));
        const op = Math.min(0.85, 0.35 + Math.log2(1 + l.weight) * 0.1);
        return (
          <path
            key={`b-${i}`}
            d={path}
            fill="none"
            stroke={isDark ? '#e4e4e7' : '#27272a'}
            strokeOpacity={op}
            strokeWidth={sw}
            strokeLinecap="round"
          >
            <title>{`${sId} ↔ ${tId} · ${l.weight} shared paper${l.weight === 1 ? '' : 's'}`}</title>
          </path>
        );
      })}
      {/* cluster letter labels — sit just outside the ring at each
        * centroid angle. Gives the bundled view a tree-of-letters
        * anchor without needing per-author tags everywhere. */}
      {clusterKeys.map((k) => {
        const a = clusterAngle.get(k)!;
        const lx = cx + (ringR + 22) * Math.cos(a);
        const ly = cy + (ringR + 22) * Math.sin(a);
        return (
          <text
            key={`cl-${k}`}
            x={lx} y={ly}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-zinc-400 text-[14px] font-semibold dark:fill-zinc-500"
          >
            {k}
          </text>
        );
      })}
      {/* nodes + outward-radiating labels */}
      {nodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return null;
        const r = 3 + Math.min(8, Math.log2(1 + n.papers) * 1.5);
        // Label sits just outside the node along the radial
        // direction so dense clusters don't pile their text on
        // top of each other.
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const lx = p.x + (dx / dist) * (r + 4);
        const ly = p.y + (dy / dist) * (r + 4);
        const angDeg = (p.ang * 180) / Math.PI;
        const flip = angDeg > 90 || angDeg < -90;
        return (
          <g key={`bn-${n.id}`} className="cursor-pointer" onClick={() => onAuthorClick?.(n.id)}>
            <circle
              cx={p.x} cy={p.y} r={r}
              fill={n.isFocal ? '#1e40af' : (isDark ? '#a1a1aa' : '#52525b')}
              stroke={n.isFocal ? (isDark ? '#fafafa' : '#18181b') : 'none'}
              strokeWidth={n.isFocal ? 1.5 : 0}
            >
              <title>{`${n.label} · ${n.papers} paper${n.papers === 1 ? '' : 's'}`}</title>
            </circle>
            <text
              x={lx} y={ly}
              transform={`rotate(${flip ? angDeg + 180 : angDeg} ${lx} ${ly})`}
              textAnchor={flip ? 'end' : 'start'}
              dominantBaseline="middle"
              className="pointer-events-none fill-zinc-700 text-[9px] dark:fill-zinc-300"
            >
              {n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Arc-diagram layout: authors on a horizontal line, semicircular
 *  arcs above the line connecting collaborators. Width = weight,
 *  vector-native (it's pure SVG paths) so PDF / SVG export is
 *  always clean. Skips force-layout entirely — useful when the
 *  user wants to see which authors form the densest collaboration
 *  cluster without the spaghetti of a force graph. */
function ArcDiagram({
  nodes,
  links,
  isDark,
  onAuthorClick,
  svgRef,
}: {
  nodes: CoAuthorNode[];
  links: CoAuthorLink[];
  isDark: boolean;
  onAuthorClick?: (id: string) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const W = 920;
  const H = 360;
  const PAD = { l: 40, r: 40, top: 40, baseline: 280 };
  const positions = new Map<string, number>();
  const usable = nodes.length > 0 ? nodes : [];
  const step = usable.length > 1 ? (W - PAD.l - PAD.r) / (usable.length - 1) : 0;
  usable.forEach((n, i) => positions.set(n.id, PAD.l + i * step));

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="block h-full w-full"
    >
      {/* baseline */}
      <line
        x1={PAD.l - 8} x2={W - PAD.r + 8}
        y1={PAD.baseline} y2={PAD.baseline}
        stroke={isDark ? '#3f3f46' : '#d4d4d8'} strokeWidth={0.8}
      />
      {/* arcs */}
      {links.map((l, i) => {
        const sId = typeof l.source === 'object' && l.source !== null
          ? (l.source as { id: string }).id : l.source;
        const tId = typeof l.target === 'object' && l.target !== null
          ? (l.target as { id: string }).id : l.target;
        const a = positions.get(sId);
        const b = positions.get(tId);
        if (a == null || b == null) return null;
        const x1 = Math.min(a, b);
        const x2 = Math.max(a, b);
        const cx = (x1 + x2) / 2;
        const radius = (x2 - x1) / 2;
        // Half-ellipse arc above the baseline. Height scales with
        // arc width so a long-distance collab doesn't push past
        // the top viewBox, and a short-distance one stays visibly
        // arched. Stroke width = weight.
        const archHeight = Math.min(radius * 0.85, PAD.baseline - PAD.top);
        const path = `M${x1},${PAD.baseline} A${radius},${archHeight} 0 0 1 ${x2},${PAD.baseline}`;
        const sw = Math.max(0.8, Math.min(6, 0.6 + l.weight * 0.6));
        const op = Math.min(0.9, 0.45 + Math.log2(1 + l.weight) * 0.1);
        return (
          <path
            key={`a-${i}`}
            d={path}
            fill="none"
            stroke={isDark ? '#e4e4e7' : '#27272a'}
            strokeOpacity={op}
            strokeWidth={sw}
            strokeLinecap="round"
          >
            <title>{`${sId} ↔ ${tId} · ${l.weight} shared paper${l.weight === 1 ? '' : 's'}`}</title>
            {void cx /* cx is intentionally unused after path construction */}
          </path>
        );
      })}
      {/* nodes + rotated labels */}
      {usable.map((n) => {
        const x = positions.get(n.id)!;
        const r = 3 + Math.min(8, Math.log2(1 + n.papers) * 1.5);
        return (
          <g key={`n-${n.id}`} className="cursor-pointer" onClick={() => onAuthorClick?.(n.id)}>
            <circle
              cx={x} cy={PAD.baseline} r={r}
              fill={n.isFocal ? '#1e40af' : (isDark ? '#a1a1aa' : '#52525b')}
              stroke={n.isFocal ? (isDark ? '#fafafa' : '#18181b') : 'none'}
              strokeWidth={n.isFocal ? 1.5 : 0}
            />
            <text
              x={x} y={PAD.baseline + r + 6}
              textAnchor="end"
              transform={`rotate(-45 ${x} ${PAD.baseline + r + 6})`}
              className="fill-zinc-700 text-[10px] dark:fill-zinc-300"
            >
              {n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}
              <title>{`${n.label} · ${n.papers} paper${n.papers === 1 ? '' : 's'}`}</title>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Selected-chord / selected-node info bar. Sits above the SVG
 *  when something is highlighted in circular mode; lists the two
 *  authors and the shared-paper count for a chord, or the author's
 *  total + co-author count for a node. */
function ChordInfoBar({
  sel,
  nodes,
  links,
  onClear,
}: {
  sel:
    | { kind: 'link'; sId: string; tId: string; weight: number }
    | { kind: 'node'; id: string }
    | null;
  nodes: CoAuthorNode[];
  links: CoAuthorLink[];
  onClear: () => void;
}) {
  if (!sel) {
    // No selection: keep the bar tiny + unobtrusive — a one-line
    // hint at the top-left of the chart area.
    return (
      <div className="rounded-md border border-dashed border-zinc-200 bg-white/80 px-2 py-1 text-[10px] text-zinc-500 backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/70">
        Click an arc or an author dot to drill in
      </div>
    );
  }
  if (sel.kind === 'link') {
    const s = nodes.find((n) => n.id === sel.sId);
    const t = nodes.find((n) => n.id === sel.tId);
    return (
      <div className="flex items-center gap-2 rounded-md border border-blue-300 bg-blue-50/90 px-3 py-1.5 text-xs text-blue-900 backdrop-blur dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-100">
        <span className="truncate">
          <strong>{s?.label || sel.sId}</strong>
          {' ↔ '}
          <strong>{t?.label || sel.tId}</strong>
        </span>
        <span className="shrink-0 text-blue-700 dark:text-blue-300">
          · {sel.weight} shared paper{sel.weight === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded-full px-2 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
        >
          Clear
        </button>
      </div>
    );
  }
  // node
  const n = nodes.find((x) => x.id === sel.id);
  let coauthors = 0;
  for (const l of links) {
    const sId = typeof l.source === 'object' && l.source !== null
      ? (l.source as { id: string }).id : l.source;
    const tId = typeof l.target === 'object' && l.target !== null
      ? (l.target as { id: string }).id : l.target;
    if (sId === sel.id || tId === sel.id) coauthors++;
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-blue-300 bg-blue-50/90 px-3 py-1.5 text-xs text-blue-900 backdrop-blur dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-100">
      <span className="truncate"><strong>{n?.label || sel.id}</strong></span>
      <span className="shrink-0 text-blue-700 dark:text-blue-300">
        · {n?.papers ?? 0} paper{n?.papers === 1 ? '' : 's'} · {coauthors} co-author{coauthors === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded-full px-2 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
      >
        Clear
      </button>
    </div>
  );
}
