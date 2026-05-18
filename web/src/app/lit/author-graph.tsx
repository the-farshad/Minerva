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
import { useMemo, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { FullscreenShell } from './fullscreen-shell';
import { GraphExportMenu } from './graph-export-menu';

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
  const [layout, setLayout] = useState<'force' | 'circular'>('force');
  // bgMode independent of the page theme so an export looks the
  // same regardless of whether the user is browsing in light or
  // dark mode. Defaults to 'light' because the most common export
  // target (print, slides, papers) is a white background. The
  // user can flip to dark for in-app review.
  const [bgMode, setBgMode] = useState<'light' | 'dark'>('light');
  const isDarkBg = bgMode === 'dark';
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
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
  function onSvgWheel(e: React.WheelEvent<SVGSVGElement>) {
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
    if (e.button !== 0) return;
    dragRef.current = {
      startClientX: e.clientX, startClientY: e.clientY,
      startTx: view.tx, startTy: view.ty,
    };
  }
  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
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
  // the saved output.

  return (
    <div ref={containerRef} className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Co-author network — {nodes.length} authors, {links.length} edges</span>
        <span className="text-zinc-300 dark:text-zinc-700">|</span>
        <GraphExportMenu
          filename="lit-coauthors"
          source={{
            canvasEl: () => layout === 'force' ? canvasEl() : null,
            svgEl: () => layout === 'circular' ? svgRef.current : null,
            graphData: {
              // Carry x/y/size so the exporter can rebuild a true-
              // vector SVG of the force layout via nodesToSVG.
              // react-force-graph-2d mutates x/y onto each node
              // after the simulation runs, so reading them off the
              // same array we passed in is correct here.
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
        />
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
        </div>
      </div>

      {layout === 'force' ? (
        <FullscreenShell>
          {({ width, height }) => (
            <div
              className="h-full w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
            >
              <ForceGraph2D
                key={`bg-${bgMode}`}
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
                  const w = (l as unknown as CoAuthorLink).weight || 1;
                  return Math.min(4, 0.6 + Math.log2(1 + w));
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
        <FullscreenShell>
          {() => (
            <div
              className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
              style={{ backgroundColor: isDarkBg ? '#0b0d10' : '#fafafa' }}
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
                  // look of D3's chord layout. Stroke width grows
                  // log-scaled with the co-authorship weight so a
                  // single shared paper stays visible while many
                  // shared papers read as a heavy band.
                  const widthScale = Math.min(8, 1.6 + Math.log2(1 + l.weight) * 1.8);
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
            </div>
          )}
        </FullscreenShell>
      )}
    </div>
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
