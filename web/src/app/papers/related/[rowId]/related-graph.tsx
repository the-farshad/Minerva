'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ExternalLink, Plus, Check, Loader2 } from 'lucide-react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
// d3-force-3d is what react-force-graph-2d uses under the hood for
// its simulation, so importing forceCollide / forceY from the same
// package guarantees the force objects match the shape the lib's
// `d3Force(name, force)` setter expects. Declared as a direct dep so
// a clean install can't hoist it away.
import { forceCollide, forceX } from 'd3-force-3d';

/** react-force-graph-2d is a 100% client / canvas component —
 *  importing it server-side throws (no `document`). Dynamic-
 *  import with ssr:false also keeps the ~150 KB d3-force +
 *  renderer bundle out of the initial page load until the user
 *  flips to graph view. */
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

type Paper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  authors?: { name?: string }[];
  year?: number;
  abstract?: string;
  openAccessPdf?: { url?: string };
  venue?: string;
  referencedWorks?: string[];
  citationCount?: number;
};

/** VOSviewer-style qualitative palette for cluster coloring. Top-N
 *  largest clusters get distinct colors; anything beyond falls back
 *  to a muted gray so the legend stays legible. */
const CLUSTER_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];
const CLUSTER_TAIL_LIGHT = '#d4d4d8'; // zinc-300
const CLUSTER_TAIL_DARK = '#52525b';  // zinc-600

type GraphNode = {
  id: string;
  label: string;
  paper?: Paper;
  isSeed?: boolean;
  refCount: number;
  // d3-force sets these post-mount; the lib mutates the original
  // object so we never read them, just declare for the types.
  x?: number; y?: number;
  // fx is honored by d3-force as a horizontal anchor; we set it
  // when the user turns Year-axis layout on so nodes lay out
  // along a horizontal timeline (oldest left → newest right).
  fx?: number;
};

type GraphLink = { source: string; target: string; weight: number };

function paperKey(p: Paper): string {
  return p.paperId || p.externalIds?.DOI || p.externalIds?.ArXiv || p.title || '';
}

function paperUrl(p: Paper): string | null {
  if (p.openAccessPdf?.url) return p.openAccessPdf.url;
  if (p.externalIds?.ArXiv) return `https://arxiv.org/abs/${p.externalIds.ArXiv}`;
  if (p.externalIds?.DOI) return `https://doi.org/${p.externalIds.DOI}`;
  return null;
}

export function RelatedGraph({
  seedTitle, seedYear, seedAuthors, papers,
  added, adding, onAdd,
}: {
  seedTitle: string;
  seedYear: string;
  seedAuthors: string;
  papers: Paper[];
  added: Set<string>;
  adding: Set<string>;
  onAdd: (p: Paper) => Promise<boolean>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ w: 800, h: 540 });
  const [focused, setFocused] = useState<Paper | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [yearAxis, setYearAxis] = useState(false);
  /** Extra padding (CSS px) added to each node's collision radius.
   *  User-controllable via a slider so layouts can be tightened or
   *  spread out without remounting the simulation. */
  const [spacing, setSpacing] = useState(10);

  // Resize the canvas to the container so the layout fills its
  // wrapper and stays sharp across reflows. Fullscreen mode uses
  // the entire viewport.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  // Escape exits fullscreen mode for keyboard users.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Configure the simulation forces directly. react-force-graph-2d
  // does NOT install a collide force by default — it only uses
  // forceLink, forceManyBody and forceCenter — which is why nodes
  // overlap until we install one. Also install a vertical pin force
  // when year-axis is on, complementing the per-node `fy` we set in
  // graphData (belt-and-suspenders against re-mount races where the
  // fy field is read before the simulation accepts it).
  //
  // Re-applies when:
  //   - yearAxis toggles  (key bumps below, lib remounts, the prior
  //     simulation is gone — we need to re-configure the new one).
  //   - fullscreen toggles (container resize remounts the same way).
  //   - graphData changes  (new node set, sim instance is new).
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const apply = () => {
      if (cancelled) return;
      const g = graphRef.current as unknown as {
        d3Force?: ((name: string, force?: unknown) => unknown) | undefined;
        d3ReheatSimulation?: () => void;
      } | undefined;
      if (!g?.d3Force) {
        // Lib not mounted yet. Cap retries so we don't leak rAFs
        // if the user navigates away mid-init.
        if (tries++ > 60) return;
        requestAnimationFrame(apply);
        return;
      }
      // Collide: full strength, two iterations, padded by the
      // user's spacing slider so labels (drawn below each node)
      // don't visually crash.
      g.d3Force(
        'collide',
        forceCollide((n: unknown) => nodeRadius(n as GraphNode) + spacing)
          .strength(1)
          .iterations(2),
      );
      // Year axis: a forceX that pulls each node to its target X
      // (computed from publication year in graphData below). The
      // fx field on each node acts as the hard anchor; this force
      // is belt-and-suspenders against remount races where the
      // simulation samples nodes before fx is in place.
      if (yearAxis) {
        g.d3Force(
          'yearX',
          forceX((n: unknown) => (n as GraphNode).fx ?? 0).strength(
            (n: unknown) => ((n as GraphNode).fx != null ? 0.9 : 0),
          ),
        );
      } else {
        g.d3Force('yearX', null);
      }
      g.d3ReheatSimulation?.();
    };
    apply();
    return () => { cancelled = true; };
  }, [yearAxis, fullscreen, spacing]);

  /** Year axis: when enabled, fix each node's horizontal position
   *  proportional to publication year — oldest left, newest right,
   *  seed pinned to its own publication year. d3-force respects the
   *  `fx` field so the simulation lays out y freely and the graph
   *  reads as a timeline along x. */
  const yearBounds = useMemo(() => {
    const years = papers.map((p) => p.year || 0).filter((y) => y > 0);
    if (years.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...years), max: Math.max(...years) };
  }, [papers]);

  const graphData = useMemo(() => {
    // Horizontal lane width per node — tuned to the current canvas
    // size so the timeline doesn't crash into the side gutters in
    // narrow layouts. When year-axis is off, no fx is set and
    // d3-force lays out freely.
    const laneW = Math.max(400, size.w - 80);
    const xFor = (year: number | undefined): number | undefined => {
      if (!yearAxis) return undefined;
      if (!year || yearBounds.max === yearBounds.min) return 0;
      const t = (year - yearBounds.min) / (yearBounds.max - yearBounds.min);
      // t = 0 → oldest → left; t = 1 → newest → right.
      return (t - 0.5) * laneW;
    };
    const nodes: GraphNode[] = [
      {
        id: '__seed__',
        label: seedTitle.length > 60 ? seedTitle.slice(0, 57) + '…' : seedTitle,
        isSeed: true,
        refCount: papers.length,
        ...(yearAxis ? { fx: xFor(Number(seedYear)) ?? 0 } : {}),
      },
    ];
    for (const p of papers) {
      const id = paperKey(p);
      if (!id) continue;
      const fx = xFor(p.year);
      nodes.push({
        id,
        label: (p.title || '').length > 50 ? (p.title || '').slice(0, 47) + '…' : (p.title || ''),
        paper: p,
        refCount: p.referencedWorks?.length || 0,
        ...(fx !== undefined ? { fx } : {}),
      });
    }
    const links: GraphLink[] = [];
    // Bibliographic coupling: two papers that share references
    // are connected with weight = shared count. The set
    // intersection is O(n*m) per pair but with ≤10 papers and
    // ≤200 refs each it's trivial.
    for (let i = 0; i < papers.length; i++) {
      const a = papers[i];
      const aId = paperKey(a);
      if (!aId) continue;
      const aRefs = new Set(a.referencedWorks || []);
      if (aRefs.size === 0) continue;
      for (let j = i + 1; j < papers.length; j++) {
        const b = papers[j];
        const bId = paperKey(b);
        if (!bId) continue;
        let shared = 0;
        for (const r of b.referencedWorks || []) if (aRefs.has(r)) shared++;
        if (shared > 0) links.push({ source: aId, target: bId, weight: shared });
      }
    }
    // Always wire each paper to the seed too — even when there's
    // no shared-references signal the user expects a radial layout
    // around the seed rather than a floating cloud.
    for (const p of papers) {
      const id = paperKey(p);
      if (!id) continue;
      links.push({ source: '__seed__', target: id, weight: 0 });
    }
    return { nodes, links };
    // yearAxis / seedYear / yearBounds / size.w all participate in
    // the layout — without them the toggle never recomputed and the
    // year axis was a silent no-op.
  }, [seedTitle, papers, yearAxis, seedYear, yearBounds, size.w]);

  // Color palette — seed (deep blue) and bibliographic-coupling
  // edges (amber) are deliberately different families so the seed
  // node stands out from its connections instead of dissolving into
  // them as it did when both were the same blue.
  const colors = {
    seed: '#1e40af',
    paperFill: '#e4e4e7',
    paperFillDark: '#3f3f46',
    paperStroke: '#71717a',
    seedLink: 'rgba(113,113,122,0.3)',
    bcLink: 'rgba(234,88,12,0.65)',
    label: '#18181b',
    labelDark: '#fafafa',
    dim: 'rgba(180,180,180,0.06)',
  };
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  /** Compute paper clusters via label propagation on the
   *  bibliographic-coupling subgraph. Two papers are in the same
   *  cluster when they share enough referenced works that the
   *  algorithm propagates the same label to both. Runs in ~O(n * k)
   *  for k iterations on the small (~50-paper) sets the explorer
   *  shows; deterministic for a fixed input ordering. */
  const clusters = useMemo<Map<string, number>>(() => {
    const adj = new Map<string, Set<string>>();
    for (const link of graphData.links) {
      if (link.weight <= 0) continue; // skip seed-spokes
      const s = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id;
      const t = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id;
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
    }
    const label = new Map<string, number>();
    const ids = [...adj.keys()];
    ids.forEach((id, idx) => label.set(id, idx));
    for (let iter = 0; iter < 5; iter++) {
      let changed = false;
      for (const nid of ids) {
        const neighbours = adj.get(nid)!;
        if (neighbours.size === 0) continue;
        const counts = new Map<number, number>();
        for (const nb of neighbours) {
          const lbl = label.get(nb);
          if (lbl == null) continue;
          counts.set(lbl, (counts.get(lbl) ?? 0) + 1);
        }
        let bestLbl = label.get(nid)!;
        let bestCount = -1;
        for (const [lbl, c] of counts) {
          if (c > bestCount || (c === bestCount && lbl < bestLbl)) {
            bestLbl = lbl; bestCount = c;
          }
        }
        if (bestLbl !== label.get(nid)) {
          label.set(nid, bestLbl);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return label;
  }, [graphData.links]);

  /** Map cluster ID → display color. The N largest clusters take
   *  distinct palette colors; everything in the long tail collapses
   *  to a muted gray so the visual hierarchy stays clean. */
  const clusterColor = useMemo<Map<number, string>>(() => {
    const sizes = new Map<number, number>();
    for (const id of clusters.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    const sorted = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
    const out = new Map<number, string>();
    sorted.forEach(([id, _size], rank) => {
      out.set(id, rank < CLUSTER_PALETTE.length ? CLUSTER_PALETTE[rank] : (isDark ? CLUSTER_TAIL_DARK : CLUSTER_TAIL_LIGHT));
    });
    return out;
  }, [clusters, isDark]);

  /** Legend rows for the top clusters, in size-descending order.
   *  Up to CLUSTER_PALETTE.length entries are coloured; everything
   *  else is collapsed into a single "Other" row. */
  const clusterLegend = useMemo<{ color: string; count: number; label: string }[]>(() => {
    const sizes = new Map<number, number>();
    for (const id of clusters.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    const sorted = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, CLUSTER_PALETTE.length).map(([id, count], i) => ({
      color: CLUSTER_PALETTE[i],
      count,
      label: `Cluster ${i + 1}`,
    }));
    const tail = sorted.slice(CLUSTER_PALETTE.length).reduce((sum, [, c]) => sum + c, 0);
    if (tail > 0) top.push({ color: isDark ? CLUSTER_TAIL_DARK : CLUSTER_TAIL_LIGHT, count: tail, label: 'Other' });
    return top;
  }, [clusters, isDark]);

  function nodeRadius(n: GraphNode): number {
    if (n.isSeed) return 14;
    // VOSviewer-style: scale node size by citation count when
    // available; fall back to reference count (paper substance
    // proxy) when not. Log-scaled so a 10 000-cite landmark stays
    // legible without dwarfing 0-cite preprints.
    const cites = n.paper?.citationCount;
    const w = typeof cites === 'number' && cites > 0 ? cites : n.refCount;
    return 6 + Math.min(10, Math.log2(1 + w));
  }

  /** When a node is focused, every other node fades out unless it
   *  shares an edge with the focused one. Set contains the focused
   *  node id plus the ids of every direct neighbour. null when
   *  nothing is focused (no dimming). */
  const focusedAdjacency = useMemo<Set<string> | null>(() => {
    if (!focused) return null;
    const fk = paperKey(focused);
    const adj = new Set<string>([fk]);
    for (const link of graphData.links) {
      const s = typeof link.source === 'string'
        ? link.source
        : (link.source as unknown as GraphNode).id;
      const t = typeof link.target === 'string'
        ? link.target
        : (link.target as unknown as GraphNode).id;
      if (s === fk) adj.add(t);
      if (t === fk) adj.add(s);
    }
    return adj;
  }, [focused, graphData.links]);

  function drawNode(raw: unknown, ctx: CanvasRenderingContext2D, globalScale: number) {
    const node = raw as GraphNode;
    const r = nodeRadius(node);
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isAdded = node.paper ? added.has(paperKey(node.paper)) : false;
    const isFocused = focused && node.paper && paperKey(focused) === paperKey(node.paper);
    // Dim non-incident nodes when something is focused so the
    // focused subgraph reads cleanly. Seed is exempt — it always
    // stays visible so the user keeps their point of reference.
    const dim = focusedAdjacency != null && !node.isSeed && !focusedAdjacency.has(node.id);
    ctx.save();
    if (dim) ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const clusterFill = clusterColor.get(clusters.get(node.id) ?? -1);
    ctx.fillStyle = node.isSeed
      ? colors.seed
      : isAdded
        ? '#16a34a'
        : (clusterFill ?? (isDark ? colors.paperFillDark : colors.paperFill));
    ctx.fill();
    if (isFocused) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2.5 / globalScale;
      ctx.stroke();
    } else if (!node.isSeed) {
      ctx.strokeStyle = colors.paperStroke;
      ctx.lineWidth = 1 / globalScale;
      ctx.stroke();
    }
    // Labels — only render at zoom levels where they don't crowd.
    // Below 0.7× scale the canvas is zoomed-out enough that
    // overlapping labels are inevitable, so skip them.
    if (globalScale > 0.7) {
      const fontSize = node.isSeed ? 12 / globalScale : 10 / globalScale;
      ctx.font = `${node.isSeed ? 'bold ' : ''}${fontSize}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = node.isSeed ? '#fff' : (isDark ? colors.labelDark : colors.label);
      const yOffset = r + 4 / globalScale;
      const text = node.label;
      // Word-wrap onto two lines for paper nodes — keeps labels
      // readable without sprawling horizontally.
      if (node.isSeed) {
        ctx.fillText(text, x, y + yOffset);
      } else {
        const words = text.split(' ');
        let line = '';
        let lineCount = 0;
        for (const word of words) {
          const test = line ? line + ' ' + word : word;
          if (ctx.measureText(test).width > 120 / globalScale && line) {
            ctx.fillText(line, x, y + yOffset + lineCount * fontSize * 1.15);
            line = word;
            lineCount++;
            if (lineCount >= 2) { ctx.fillText(line + '…', x, y + yOffset + lineCount * fontSize * 1.15); line = ''; break; }
          } else {
            line = test;
          }
        }
        if (line) ctx.fillText(line, x, y + yOffset + lineCount * fontSize * 1.15);
      }
    }
    ctx.restore();
  }

  const focusedKey = focused ? paperKey(focused) : null;
  const isFocusedBusy = focusedKey ? adding.has(focusedKey) : false;
  const isFocusedAdded = focusedKey ? added.has(focusedKey) : false;
  const focusedUrl = focused ? paperUrl(focused) : null;
  const focusedAuthors = (focused?.authors || []).map((a) => a.name || '').filter(Boolean).join(', ');

  if (papers.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Nothing to graph — apply fewer filters or wait for the recommendations to load.
      </p>
    );
  }

  // Layout — fullscreen mode pins to the viewport, otherwise the
  // canvas occupies a fixed-ratio strip in the page flow.
  const outerClass = fullscreen
    ? 'fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950'
    : 'relative';
  const containerStyle = fullscreen
    ? { height: 'calc(100vh - 3rem)' }
    : { height: Math.max(360, size.w * 0.6) };

  return (
    <div className={outerClass}>
      {/* Tool strip — fullscreen toggle + year-axis toggle. In
        * fullscreen we add a small header strip so the user has
        * a clear "exit" affordance. */}
      <div className={`mb-2 flex flex-wrap items-center gap-2 ${fullscreen ? 'border-b border-zinc-200 px-4 py-2 dark:border-zinc-800' : ''}`}>
        <button
          type="button"
          onClick={() => setYearAxis((v) => !v)}
          aria-pressed={yearAxis}
          title="Lay out nodes horizontally by publication year (oldest left → newest right)"
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
            yearAxis
              ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
              : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
          }`}
        >
          {yearAxis ? '🗓 Year axis on' : '🗓 Year axis'}
        </button>
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
        {/* Node-spacing slider. Padding added to every node's
          * collision radius — small values = cosy layout, large
          * values = airy. Live-updates the simulation. */}
        <label className="inline-flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400" title="Padding added to every node's collision radius">
          <span>Spacing</span>
          <input
            type="range"
            min={4}
            max={36}
            step={2}
            value={spacing}
            onChange={(e) => setSpacing(Number(e.target.value))}
            className="w-28 cursor-pointer accent-zinc-900 dark:accent-white"
          />
          <span className="w-6 font-mono text-[10px]">{spacing}</span>
        </label>
        {fullscreen && (
          <span className="ml-auto text-[10px] text-zinc-500">Press Esc to exit</span>
        )}
      </div>
      <div
        ref={containerRef}
        className={fullscreen
          ? 'flex-1 overflow-hidden bg-zinc-50 dark:bg-zinc-900'
          : 'overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900'}
        style={containerStyle}
      >
        <ForceGraph2D
          /* Key bumps on yearAxis so the simulation actually
             re-runs with the new fy values. react-force-graph
             persists the d3 simulation across graphData updates,
             which meant toggling year-axis previously stamped
             new fy onto nodes but the live simulation ignored
             them. Remounting forces a fresh init. */
          key={yearAxis ? 'year' : 'force'}
          ref={graphRef as unknown as React.RefObject<ForceGraphMethods>}
          width={size.w}
          height={size.h}
          graphData={graphData}
          backgroundColor={isDark ? '#18181b' : '#fafafa'}
          nodeRelSize={6}
          // nodeVal feeds d3-force's default collide-radius
          // calculation; align it with our drawn node radii so
          // even if the explicit forceCollide config above
          // hasn't applied yet, the lib doesn't overlap things
          // by default.
          nodeVal={(n) => {
            const r = nodeRadius(n as GraphNode);
            return (r * r) / 36; // sqrt(val) * nodeRelSize(6) ≈ r
          }}
          /* Year axis tick labels — drawn under each unique year
             present in the result set when year-axis is on. Years
             with zero papers are skipped so the axis isn't padded
             with empty space; the simulation-coord laneW we use to
             pin nodes is the same one we use to position the tick
             labels, so they line up with the node columns. */
          onRenderFramePre={!yearAxis ? undefined : (ctx, globalScale) => {
            const years = new Set<number>();
            for (const p of papers) if (p.year && p.year > 0) years.add(p.year);
            if (yearBounds.min > 0) years.add(yearBounds.min);
            if (yearBounds.max > 0) years.add(yearBounds.max);
            if (years.size === 0) return;
            const laneW = Math.max(400, size.w - 80);
            const ymin = yearBounds.min;
            const ymax = yearBounds.max;
            const sorted = Array.from(years).sort((a, b) => a - b);
            // Find the lowest node Y in the current frame so the
            // labels sit below the cloud instead of crashing into it.
            // Falls back to size.h/2 - 30 in simulation coords if
            // nothing's been laid out yet.
            let maxY = -Infinity;
            for (const n of graphData.nodes) {
              const ny = (n as { y?: number }).y;
              if (typeof ny === 'number' && ny > maxY) maxY = ny;
            }
            const labelY = (Number.isFinite(maxY) ? maxY : 0) + 30;
            ctx.save();
            ctx.font = `${10 / globalScale}px ui-sans-serif, system-ui`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = isDark ? '#a1a1aa' : '#52525b';
            ctx.strokeStyle = isDark ? 'rgba(161,161,170,0.25)' : 'rgba(82,82,91,0.25)';
            ctx.lineWidth = 1 / globalScale;
            for (const yr of sorted) {
              const t = ymax === ymin ? 0 : (yr - ymin) / (ymax - ymin);
              const cx = (t - 0.5) * laneW;
              ctx.beginPath();
              ctx.moveTo(cx, labelY - 6 / globalScale);
              ctx.lineTo(cx, labelY);
              ctx.stroke();
              ctx.fillText(String(yr), cx, labelY + 2 / globalScale);
            }
            ctx.restore();
          }}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(node, color, ctx) => {
            const r = nodeRadius(node as GraphNode) + 4;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc((node as GraphNode).x ?? 0, (node as GraphNode).y ?? 0, r, 0, Math.PI * 2);
            ctx.fill();
          }}
          linkColor={(l) => {
            const src = (l.source as unknown as GraphNode);
            const tgt = (l.target as unknown as GraphNode);
            const base = src?.isSeed ? colors.seedLink : colors.bcLink;
            if (!focusedAdjacency) return base;
            // An edge is "incident" if both endpoints are in the
            // focused-adjacency set (the focused node itself or one
            // of its direct neighbours). Non-incident edges fade out
            // so the focused subgraph reads cleanly.
            const sId = src?.id;
            const tId = tgt?.id;
            const incident =
              !!sId && !!tId && focusedAdjacency.has(sId) && focusedAdjacency.has(tId);
            return incident ? base : colors.dim;
          }}
          linkWidth={(l) => {
            const w = (l as unknown as GraphLink).weight || 0;
            // Map BC overlap (0 .. N) onto a 0.5 .. 4 px range.
            return w === 0 ? 0.6 : Math.min(4, 0.8 + Math.log2(1 + w));
          }}
          onNodeClick={(node) => {
            const n = node as GraphNode;
            if (n.isSeed) { setFocused(null); return; }
            if (!n.paper) return;
            // Toggle: clicking the focused node again clears focus
            // so the user can "step out" without finding empty space.
            if (focused && paperKey(focused) === paperKey(n.paper)) {
              setFocused(null);
            } else {
              setFocused(n.paper);
            }
          }}
          onBackgroundClick={() => setFocused(null)}
          cooldownTicks={120}
          enableNodeDrag={true}
          minZoom={0.4}
          maxZoom={6}
        />
      </div>

      {/* Cluster legend — only renders when clustering actually
       *  produced more than one group. Single-cluster graphs (every
       *  paper bibliographically isolated) look the same as before. */}
      {clusterLegend.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="text-zinc-400">Clusters:</span>
          {clusterLegend.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
              {c.label} <span className="text-zinc-400">({c.count})</span>
            </span>
          ))}
        </div>
      )}

      {focused && (
        <aside className="absolute right-3 top-3 w-[22rem] max-w-[calc(100%-1.5rem)] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {focusedUrl ? (
                <a href={focusedUrl} target="_blank" rel="noopener" className="text-sm font-medium hover:underline">
                  {focused.title || '(untitled)'}
                </a>
              ) : (
                <span className="text-sm font-medium">{focused.title || '(untitled)'}</span>
              )}
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {focusedAuthors}
                {focused.year && <span> · {focused.year}</span>}
                {focused.venue && <span> · {focused.venue}</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setFocused(null)}
              className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label="Close"
            >
              ×
            </button>
          </header>
          {focused.abstract && (
            <p className="mt-2 max-h-32 overflow-y-auto text-xs text-zinc-600 dark:text-zinc-400">
              {focused.abstract}
            </p>
          )}
          <div className="mt-3 flex items-center gap-1.5">
            {focusedUrl && (
              <a
                href={focusedUrl}
                target="_blank"
                rel="noopener"
                title="Open externally"
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-1 text-[11px] hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <ExternalLink className="h-3 w-3" /> Open
              </a>
            )}
            <button
              type="button"
              onClick={() => void onAdd(focused)}
              disabled={isFocusedAdded || isFocusedBusy || !focusedUrl}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition ${
                isFocusedAdded
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200'
              }`}
            >
              {isFocusedBusy
                ? <><Loader2 className="h-3 w-3 animate-spin" /></>
                : isFocusedAdded
                  ? <><Check className="h-3 w-3" /> Added</>
                  : <><Plus className="h-3 w-3" /> Add to library</>}
            </button>
          </div>
        </aside>
      )}

      {/* Compact legend explaining how the visualization
        * encodes data — so users aren't left guessing what
        * size / colour / edge thickness mean. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-blue-700" />
          Seed paper
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-zinc-400" />
          <span className="inline-block h-3 w-3 rounded-full bg-zinc-400" />
          Size = number of references this paper cites
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-emerald-500" />
          Already added to your library
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex flex-col items-center justify-center gap-0.5">
            <span className="block h-px w-6 bg-orange-500" />
            <span className="block h-0.5 w-6 bg-orange-500" />
          </span>
          Edge thickness = shared references (bibliographic coupling)
        </span>
      </div>
      <div className="mt-1 text-[10px] text-zinc-500">
        Click a node to focus it (incident edges stay lit, the rest dim).
        Click empty space or the seed to clear.
        {yearAxis && yearBounds.min > 0 && (
          <> Year axis: <span className="font-mono">{yearBounds.min}</span> ← oldest · newest → <span className="font-mono">{yearBounds.max}</span>.</>
        )}
      </div>
    </div>
  );
}
