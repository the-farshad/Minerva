'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { sankey, sankeyLinkHorizontal, sankeyLeft } from 'd3-sankey';

/** Citation flow as a Sankey diagram. Each paper is a node; each
 *  citation (paper A cites paper B, where both are in the visible
 *  set) is a flow from A → B. Link thickness = citation weight
 *  (currently 1 per citation; could be augmented with a "common
 *  references" weight later if the API surfaces it). */

type Paper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  authors?: { name?: string }[];
  year?: number;
  venue?: string;
  openAccessPdf?: { url?: string };
  referencedWorks?: string[];
};

function paperKey(p: Paper): string {
  return p.paperId || p.externalIds?.DOI || p.externalIds?.ArXiv || p.title || '';
}

type SankeyNode = { id: string; label: string; year?: number };
type SankeyLink = { source: string; target: string; value: number };

export function RelatedSankey({
  seedTitle,
  papers,
  added,
}: {
  seedTitle: string;
  papers: Paper[];
  added: Set<string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 540 });
  const [focused, setFocused] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      // In fullscreen the height is the viewport minus the toolbar
      // strip; otherwise it's a 0.6× width ratio (same shape the
      // inline graph uses) so the diagram has reasonable airtime
      // without dominating the page.
      const h = fullscreen
        ? Math.max(360, window.innerHeight - 80)
        : Math.max(360, rect.width * 0.6);
      setSize({ w: rect.width || 800, h });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  // Esc exits fullscreen for keyboard users.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  /** Build the citation graph. Nodes include the seed and every
   *  visible paper; links exist whenever a paper's
   *  `referencedWorks` array contains the id of another visible
   *  paper. Self-citations are skipped. */
  const { nodes, links, dropped } = useMemo(() => {
    const SEED_ID = '__seed__';
    const idMap = new Map<string, SankeyNode>();
    idMap.set(SEED_ID, {
      id: SEED_ID,
      label: seedTitle.length > 50 ? seedTitle.slice(0, 47) + '…' : seedTitle,
    });
    for (const p of papers) {
      const id = paperKey(p);
      if (!id) continue;
      idMap.set(id, {
        id,
        label: (p.title || '').length > 50 ? (p.title || '').slice(0, 47) + '…' : (p.title || ''),
        year: p.year,
      });
    }

    const links: SankeyLink[] = [];
    let droppedCount = 0;
    // Build the visible id-set first so we don't add links to
    // references that aren't drawn.
    const visibleIds = new Set(idMap.keys());
    for (const p of papers) {
      const sourceId = paperKey(p);
      if (!sourceId) continue;
      const refs = p.referencedWorks || [];
      for (const targetId of refs) {
        if (targetId === sourceId) continue;
        if (!visibleIds.has(targetId)) { droppedCount += 1; continue; }
        links.push({ source: sourceId, target: targetId, value: 1 });
      }
    }
    // Always at least one edge from each non-seed paper to the seed,
    // so isolated nodes still attach to the graph and the layout
    // doesn't degenerate to a single column.
    for (const p of papers) {
      const id = paperKey(p);
      if (!id || id === SEED_ID) continue;
      if (!links.some((l) => l.source === id || l.target === id)) {
        links.push({ source: id, target: SEED_ID, value: 0.25 });
      }
    }
    return { nodes: Array.from(idMap.values()), links, dropped: droppedCount };
  }, [seedTitle, papers]);

  const layout = useMemo(() => {
    if (nodes.length === 0 || links.length === 0) return null;
    const margin = 12;
    const fontPad = 160; // label gutter on each side
    const layoutW = Math.max(400, size.w);
    const layoutH = Math.max(280, size.h);
    const gen = sankey<SankeyNode, SankeyLink>()
      .nodeId((n) => n.id)
      .nodeAlign(sankeyLeft)
      .nodeWidth(14)
      .nodePadding(10)
      .extent([
        [margin + fontPad, margin],
        [layoutW - margin - fontPad, layoutH - margin],
      ]);
    try {
      return gen({
        nodes: nodes.map((n) => ({ ...n })),
        links: links.map((l) => ({ ...l })),
      });
    } catch {
      return null;
    }
  }, [nodes, links, size]);

  const linkPath = useMemo(() => sankeyLinkHorizontal(), []);

  if (papers.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Nothing to flow — wait for the recommendations to load.
      </p>
    );
  }

  if (!layout || layout.nodes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
        No citation links between the visible papers. The Graph view&apos;s bibliographic-coupling edges still show shared-reference relationships.
      </p>
    );
  }

  const isFocused = (id: string) => focused === id;
  const isIncident = (sId: string, tId: string) => !focused || focused === sId || focused === tId;

  // Fullscreen wraps the entire panel in a fixed-inset overlay; the
  // toolbar strip + SVG canvas inside resize via the same
  // ResizeObserver path. Esc exits (see effect above).
  const outerClass = fullscreen
    ? 'fixed inset-0 z-50 flex flex-col bg-white p-2 dark:bg-zinc-950'
    : 'rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950';

  return (
    <div className={outerClass}>
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
        {fullscreen && <span className="ml-auto text-[10px] text-zinc-500">Press Esc to exit</span>}
      </div>
      <div ref={containerRef} className={fullscreen ? 'flex-1 w-full' : 'w-full'}>
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className="block"
          onClick={(e) => { if (e.target === e.currentTarget) setFocused(null); }}
        >
          {/* Links */}
          {layout.links.map((l, i) => {
            const sId = (l.source as unknown as SankeyNode).id;
            const tId = (l.target as unknown as SankeyNode).id;
            const active = isIncident(sId, tId);
            return (
              <path
                key={`l${i}`}
                d={linkPath(l) || ''}
                fill="none"
                stroke="#ea580c"
                strokeOpacity={active ? 0.45 : 0.07}
                strokeWidth={Math.max(1, l.width || 1)}
              />
            );
          })}
          {/* Nodes */}
          {layout.nodes.map((n) => {
            const x = n.x0 ?? 0;
            const y = n.y0 ?? 0;
            const w = (n.x1 ?? 0) - x;
            const h = Math.max(1, (n.y1 ?? 0) - y);
            const isAdded = added.has(n.id);
            const isSeed = n.id === '__seed__';
            const fill = isSeed
              ? '#1e40af'
              : isAdded
                ? '#16a34a'
                : '#71717a';
            const labelLeft = (n.depth ?? 0) === 0 ? (x + w + 6) : (x - 6);
            const labelAnchor = (n.depth ?? 0) === 0 ? 'start' : 'end';
            const fade = focused && !isFocused(n.id) && !layout.links.some((l) =>
              ((l.source as unknown as SankeyNode).id === n.id && (l.target as unknown as SankeyNode).id === focused) ||
              ((l.target as unknown as SankeyNode).id === n.id && (l.source as unknown as SankeyNode).id === focused),
            );
            return (
              <g key={n.id} opacity={fade ? 0.25 : 1} style={{ cursor: 'pointer' }} onClick={() => setFocused((cur) => (cur === n.id ? null : n.id))}>
                <rect x={x} y={y} width={w} height={h} fill={fill} rx={2} />
                <title>{n.label}{n.year ? ` (${n.year})` : ''}</title>
                <text
                  x={labelLeft}
                  y={y + h / 2}
                  dy="0.32em"
                  textAnchor={labelAnchor}
                  fontSize={11}
                  fontFamily="ui-sans-serif, system-ui"
                  fill="currentColor"
                  className="text-zinc-700 dark:text-zinc-300"
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10px] text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-2 rounded-sm bg-blue-700" />
          Seed
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-2 rounded-sm bg-emerald-500" />
          Already in library
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-2 rounded-sm bg-zinc-500" />
          Related paper
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-0.5 w-6 bg-orange-500 opacity-50" />
          Citation (thickness = times cited)
        </span>
        <span className="ml-auto">
          {layout.links.length} citation{layout.links.length === 1 ? '' : 's'} between visible papers
          {dropped > 0 && <> · {dropped} pointing out of view (paper not in the visible set)</>}
        </span>
      </div>
      <p className="mt-1 px-2 text-[10px] text-zinc-500">
        Click a node to focus it: edges incident to it stay lit, the rest fade. Click empty space (or the focused node again) to clear.
      </p>
    </div>
  );
}
