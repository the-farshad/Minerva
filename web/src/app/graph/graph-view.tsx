'use client';

import { useMemo } from 'react';
import Link from 'next/link';

type Node = {
  id: string; title: string; sectionId: string; sectionSlug: string;
  /** Citations-of (when known). Drives the bubble radius — papers
   *  with no citation data render at the baseline so a missing
   *  fetch doesn't look like a zero-cited paper. */
  citationCount?: number;
};
type Edge = { from: string; to: string; via: string };
type Section = { id: string; title: string; slug: string };

const LANE_HEIGHT = 100;
const NODE_R_BASE = 6;
const NODE_R_MAX = 22;
// Bubble radius is base + log10(citations + 1) * step, so 0 → 6,
// 10 → ~10, 100 → ~14, 1000 → ~18, ≥10k → capped at 22. The log
// scale is necessary — citation counts span 0 to >10k and a
// linear scale would dwarf everything next to a single megapaper.
function radiusFor(citationCount: number | undefined): number {
  if (typeof citationCount !== 'number' || citationCount <= 0) return NODE_R_BASE;
  return Math.min(NODE_R_MAX, NODE_R_BASE + Math.log10(citationCount + 1) * 4);
}

export function GraphView({
  nodes, edges, sections,
}: {
  nodes: Node[]; edges: Edge[]; sections: Section[];
}) {
  // Lay nodes out: one horizontal lane per section, evenly spaced
  // within. Deterministic — no physics — so refresh doesn't shuffle.
  const layout = useMemo(() => {
    const laneFor: Record<string, number> = {};
    sections.forEach((s, i) => { laneFor[s.id] = i; });
    const bySection: Record<string, Node[]> = {};
    for (const n of nodes) (bySection[n.sectionId] ??= []).push(n);
    const positions: Record<string, { x: number; y: number }> = {};
    const width = 1000;
    for (const [sid, ns] of Object.entries(bySection)) {
      const y = (laneFor[sid] ?? 0) * LANE_HEIGHT + LANE_HEIGHT / 2 + 30;
      const slots = ns.length + 1;
      ns.forEach((n, i) => {
        positions[n.id] = { x: ((i + 1) / slots) * (width - 60) + 30, y };
      });
    }
    return { positions, width, height: sections.length * LANE_HEIGHT + 40 };
  }, [nodes, sections]);

  const totalEdges = edges.length;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Graph</h1>
        <p className="text-sm text-zinc-500">
          {nodes.length} nodes · {totalEdges} cross-references
        </p>
      </header>
      {nodes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No rows to graph yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="block w-full"
            style={{ minHeight: layout.height }}
          >
            {sections.map((s, i) => (
              <g key={s.id}>
                <text
                  x={10}
                  y={i * LANE_HEIGHT + 20}
                  className="fill-zinc-500 text-[10px] uppercase tracking-wide"
                >
                  {s.title}
                </text>
                <line
                  x1={0}
                  x2={layout.width}
                  y1={(i + 1) * LANE_HEIGHT + 30}
                  y2={(i + 1) * LANE_HEIGHT + 30}
                  stroke="currentColor"
                  className="text-zinc-200 dark:text-zinc-800"
                  strokeDasharray="2 4"
                />
              </g>
            ))}
            {edges.map((e, i) => {
              const a = layout.positions[e.from];
              const b = layout.positions[e.to];
              if (!a || !b) return null;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2 - Math.abs(b.y - a.y) * 0.3;
              return (
                <path
                  key={i}
                  d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-zinc-300 dark:text-zinc-700"
                />
              );
            })}
            {nodes.map((n) => {
              const p = layout.positions[n.id];
              if (!p) return null;
              const r = radiusFor(n.citationCount);
              const cc = n.citationCount;
              return (
                <g key={n.id}>
                  <Link href={`/s/${encodeURIComponent(n.sectionSlug)}`}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      className="fill-zinc-700 hover:fill-zinc-900 dark:fill-zinc-300 dark:hover:fill-white"
                    >
                      <title>{cc !== undefined ? `${n.title} — ${cc.toLocaleString()} citations` : n.title}</title>
                    </circle>
                  </Link>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Edges are drawn whenever one row&rsquo;s field value matches another row&rsquo;s URL.
        Bubble size scales (log) with citation count for paper rows that carry one.
        Click a node to jump to its section.
      </p>
    </main>
  );
}
