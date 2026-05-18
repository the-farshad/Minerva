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
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);

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

  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
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

  return (
    <div ref={containerRef} className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Co-author network — {nodes.length} authors, {links.length} edges</span>
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
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
          style={{ height: 480 }}
        >
          <ForceGraph2D
            ref={graphRef as unknown as React.RefObject<ForceGraphMethods>}
            width={760}
            height={480}
            graphData={{ nodes, links }}
            backgroundColor={isDark ? '#18181b' : '#fafafa'}
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
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
          <svg viewBox={`0 0 ${circular.W} ${circular.H}`} className="block w-full">
            {/* Edges first so nodes sit on top. */}
            {links.map((l, i) => {
              const a = circular.positions.get(l.source);
              const b = circular.positions.get(l.target);
              if (!a || !b) return null;
              const widthScale = Math.min(3, 0.4 + Math.log2(1 + l.weight));
              return (
                <line
                  key={`e-${i}`}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeWidth={widthScale}
                  className="text-zinc-500 dark:text-zinc-400"
                />
              );
            })}
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
              return (
                <g key={`n-${n.id}`}>
                  <circle
                    cx={pos.x} cy={pos.y} r={r}
                    fill={nodeFill(n)}
                    stroke={n.isFocal ? (isDark ? '#fafafa' : '#18181b') : 'none'}
                    strokeWidth={n.isFocal ? 2 : 0}
                    className="cursor-pointer"
                    onClick={() => onAuthorClick?.(n.id)}
                  >
                    <title>{`${n.label} · ${n.papers} paper${n.papers === 1 ? '' : 's'}`}</title>
                  </circle>
                  <text
                    x={lx} y={ly}
                    transform={`rotate(${flip ? rotate + 180 : rotate} ${lx} ${ly})`}
                    textAnchor={flip ? 'end' : 'start'}
                    dominantBaseline="middle"
                    className="pointer-events-none fill-zinc-700 text-[10px] dark:fill-zinc-300"
                  >
                    {n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
