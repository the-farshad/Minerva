'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ExternalLink, Plus, Check, Loader2 } from 'lucide-react';
import type { ForceGraphMethods } from 'react-force-graph-2d';

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
};

type GraphNode = {
  id: string;
  label: string;
  paper?: Paper;
  isSeed?: boolean;
  refCount: number;
  // d3-force sets these post-mount; the lib mutates the original
  // object so we never read them, just declare for the types.
  x?: number; y?: number;
  // fy is honored by d3-force as a vertical anchor; we set it
  // when the user turns Year-axis layout on so nodes lay out
  // along a timeline.
  fy?: number;
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

  // Configure the d3-force collision radius explicitly so nodes
  // don't overlap with our custom canvas draw. We can't pass
  // this via the ForceGraph2D props (lib only exposes nodeRelSize
  // + nodeVal which produce a single uniform radius), so we
  // poke at the simulation through the imperative ref after
  // it's mounted. Re-runs on yearAxis since the key-bump
  // remounts the canvas.
  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      const g = graphRef.current as unknown as {
        d3Force?: (name: string) => { radius?: (fn: (n: GraphNode) => number) => unknown } | undefined;
        d3ReheatSimulation?: () => void;
      } | undefined;
      const collide = g?.d3Force?.('collide');
      if (!collide?.radius) {
        // Lib not mounted yet — try again on the next frame.
        requestAnimationFrame(apply);
        return;
      }
      collide.radius((n: GraphNode) => nodeRadius(n) + 6);
      g?.d3ReheatSimulation?.();
    };
    apply();
    return () => { cancelled = true; };
  }, [yearAxis, fullscreen]);

  /** Year axis: when enabled, fix each node's vertical position
   *  proportional to publication year — newest at the top, oldest
   *  at the bottom, seed pinned to the centre y. d3-force respects
   *  the `fy` field, so the simulation just lays out x freely and
   *  the graph reads as a timeline along y. */
  const yearBounds = useMemo(() => {
    const years = papers.map((p) => p.year || 0).filter((y) => y > 0);
    if (years.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...years), max: Math.max(...years) };
  }, [papers]);

  const graphData = useMemo(() => {
    // Vertical lane height per node — tuned to the current canvas
    // size so the timeline doesn't crash into the toolbar in
    // small layouts. When year-axis is off, no fy is set and
    // d3-force lays out freely.
    const laneH = Math.max(240, size.h - 40);
    const yFor = (year: number | undefined): number | undefined => {
      if (!yearAxis) return undefined;
      if (!year || yearBounds.max === yearBounds.min) return 0;
      const t = (year - yearBounds.min) / (yearBounds.max - yearBounds.min);
      // t = 0 → oldest → bottom; t = 1 → newest → top.
      return (0.5 - t) * laneH;
    };
    const nodes: GraphNode[] = [
      {
        id: '__seed__',
        label: seedTitle.length > 60 ? seedTitle.slice(0, 57) + '…' : seedTitle,
        isSeed: true,
        refCount: papers.length,
        ...(yearAxis ? { fy: yFor(Number(seedYear)) ?? 0 } : {}),
      },
    ];
    for (const p of papers) {
      const id = paperKey(p);
      if (!id) continue;
      const fy = yFor(p.year);
      nodes.push({
        id,
        label: (p.title || '').length > 50 ? (p.title || '').slice(0, 47) + '…' : (p.title || ''),
        paper: p,
        refCount: p.referencedWorks?.length || 0,
        ...(fy !== undefined ? { fy } : {}),
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
  }, [seedTitle, papers]);

  // Color palette — uses the same dark/blue accent the rest of
  // Minerva does so the graph reads as native.
  const colors = {
    seed: '#1e40af',
    paperFill: '#e4e4e7',
    paperFillDark: '#3f3f46',
    paperStroke: '#71717a',
    seedLink: 'rgba(113,113,122,0.3)',
    bcLink: 'rgba(30,64,175,0.55)',
    label: '#18181b',
    labelDark: '#fafafa',
  };
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  function nodeRadius(n: GraphNode): number {
    if (n.isSeed) return 14;
    // Bigger node = more references (proxy for paper substance).
    return 6 + Math.min(8, Math.log2(1 + n.refCount));
  }

  function drawNode(raw: unknown, ctx: CanvasRenderingContext2D, globalScale: number) {
    const node = raw as GraphNode;
    const r = nodeRadius(node);
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isAdded = node.paper ? added.has(paperKey(node.paper)) : false;
    const isFocused = focused && node.paper && paperKey(focused) === paperKey(node.paper);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.isSeed
      ? colors.seed
      : isAdded
        ? '#16a34a'
        : (isDark ? colors.paperFillDark : colors.paperFill);
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
          title="Lay out nodes vertically by publication year"
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
            return src?.isSeed ? colors.seedLink : colors.bcLink;
          }}
          linkWidth={(l) => {
            const w = (l as unknown as GraphLink).weight || 0;
            // Map BC overlap (0 .. N) onto a 0.5 .. 4 px range.
            return w === 0 ? 0.6 : Math.min(4, 0.8 + Math.log2(1 + w));
          }}
          onNodeClick={(node) => {
            const n = node as GraphNode;
            if (!n.isSeed && n.paper) setFocused(n.paper);
          }}
          cooldownTicks={120}
          enableNodeDrag={true}
          minZoom={0.4}
          maxZoom={6}
        />
      </div>

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
            <span className="block h-px w-6 bg-blue-600" />
            <span className="block h-0.5 w-6 bg-blue-600" />
          </span>
          Edge thickness = shared references with the linked paper (bibliographic coupling)
        </span>
      </div>
      <div className="mt-1 text-[10px] text-zinc-500">
        Drag to pan, scroll to zoom, click a node for details. {yearAxis ? 'Year axis: newest at the top, oldest at the bottom.' : ''}
      </div>
    </div>
  );
}
