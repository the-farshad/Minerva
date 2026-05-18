'use client';

/**
 * Citation-timeline bubble chart for the connected-graph legs in
 * lit/. Plots each paper in the list at (publication year × citation
 * count) with bubble area scaled to the citation count, on a log-y
 * axis so a Nature-2015 paper and a 2024 preprint coexist legibly.
 *
 * The seed paper is highlighted with an open ring, drawn on top.
 * Hovering a bubble pops a tooltip with title / year / cites; click
 * delegates to onSelect, the same handler that powers click-to-
 * explore on the list rows.
 *
 * Pure SVG, no chart library, no D3 dependency — sticks with the
 * project's hand-rolled-vanilla-style charts on the rest of the app.
 */
import { useMemo, useState } from 'react';
import { ChartShell } from './chart-shell';

type Paper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  authors?: string | { name?: string }[];
  year?: string | number;
  venue?: string;
  citationCount?: number;
};

function yearOf(p: Paper): number | null {
  if (typeof p.year === 'number') return p.year;
  const n = Number(p.year);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function citesOf(p: Paper): number {
  return typeof p.citationCount === 'number' && p.citationCount > 0 ? p.citationCount : 0;
}

export function TimelineChart({
  seed,
  papers,
  onSelect,
}: {
  seed: Paper | null;
  papers: Paper[];
  onSelect: (p: Paper) => void;
}) {
  const datable = useMemo(
    () => papers.map((p, i) => ({ p, i, y: yearOf(p), c: citesOf(p) })).filter((d) => d.y !== null) as { p: Paper; i: number; y: number; c: number }[],
    [papers],
  );
  const seedYear = seed ? yearOf(seed) : null;
  const seedCites = seed ? citesOf(seed) : 0;
  const [hover, setHover] = useState<null | { x: number; y: number; p: Paper }>(null);

  if (datable.length === 0 && seedYear === null) {
    return (
      <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
        No publication-year data for this list — can't build a timeline.
      </p>
    );
  }

  const years = datable.map((d) => d.y);
  if (seedYear !== null) years.push(seedYear);
  const yMin = Math.min(...years);
  const yMax = Math.max(...years);
  const cites = datable.map((d) => d.c).concat([seedCites]).filter((n) => n > 0);
  const cMax = cites.length > 0 ? Math.max(...cites) : 1;

  const W = 760;
  const H = 360;
  // Padding has to leave room for the largest bubble (radius cap
  // R_MAX) plus the small text label some bubbles wear above them
  // (~10 px). The previous PAD.t=16 / PAD.r=14 cropped a max-cited
  // paper at the top-right corner — bubble centre at PAD.t with
  // r=28 puts the top edge at y=-12, outside the viewBox, which
  // SVG overflow:hidden clipped in exports too. With R_MAX=20 and
  // PAD.t/PAD.r at 40 we have enough headroom for label + ring.
  const PAD = { t: 40, r: 36, b: 32, l: 50 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  function xScale(year: number): number {
    if (yMax === yMin) return PAD.l + innerW / 2;
    return PAD.l + ((year - yMin) / (yMax - yMin)) * innerW;
  }
  // Log-y so a 0-cite preprint and an 80k-cite landmark fit in one
  // viewport. log10(cites + 1) keeps the zero-cite case at the bottom.
  const logMax = Math.log10(cMax + 1);
  function yScale(c: number): number {
    if (logMax <= 0) return PAD.t + innerH / 2;
    return PAD.t + innerH - (Math.log10(Math.max(0, c) + 1) / logMax) * innerH;
  }
  // Capped at R_MAX so the bubble + its top-label + the seed ring
  // (which adds +4 on top) stay inside the viewBox after PAD.
  // R_MAX must satisfy R_MAX + 4 + label_height (~12) ≤ PAD.t.
  const R_MAX = 20;
  function rFor(c: number): number {
    return Math.max(2.5, Math.min(R_MAX, Math.sqrt(Math.max(0, c)) * 0.7));
  }
  // Fill opacity scales with log(cites): 0-cite papers render as
  // pale dots, the top-cited paper fills almost solid. The visual
  // size already encodes cites; opacity is the second channel so a
  // dense cluster of low-cite papers doesn't drown out a 10 000-cite
  // landmark sitting at the same year.
  function opacityFor(c: number): number {
    if (logMax <= 0) return 0.65;
    return 0.25 + 0.7 * (Math.log10(Math.max(0, c) + 1) / logMax);
  }
  // Annotate the three highest-cited papers inline so the visual
  // story ("this paper is the most-cited one in this cohort")
  // doesn't depend on hovering.
  const labelTop = new Set(
    [...datable]
      .filter((d) => d.c > 0)
      .sort((a, b) => b.c - a.c)
      .slice(0, 3)
      .map((d) => d.i),
  );
  function citesLabel(c: number): string {
    if (c >= 1000) return `${(c / 1000).toFixed(c >= 10_000 ? 0 : 1)}k`;
    return String(c);
  }

  // X ticks: pick a step that gives ~4–8 labels.
  const span = Math.max(1, yMax - yMin);
  const step = span <= 4 ? 1 : span <= 10 ? 2 : span <= 25 ? 5 : 10;
  const xTicks: number[] = [];
  for (let y = Math.ceil(yMin / step) * step; y <= yMax; y += step) xTicks.push(y);
  if (xTicks.length === 0) xTicks.push(yMin);

  // Y ticks at log decades 0, 10, 100, …
  const yTicks: number[] = [0];
  for (let pow = 1; Math.pow(10, pow - 1) <= cMax; pow++) yTicks.push(Math.pow(10, pow));

  return (
    <ChartShell
      filename="lit-timeline"
      summary="Citation timeline · publication year × citation count"
      tableData={{
        rows: [
          ...(seed && seedYear !== null
            ? [{ title: seed.title ?? '', year: seedYear, citations: seedCites, role: 'seed', doi: seed.externalIds?.DOI ?? '', arxiv: seed.externalIds?.ArXiv ?? '' }]
            : []),
          ...datable.map(({ p, y, c }) => ({
            title: p.title ?? '',
            year: y,
            citations: c,
            role: 'neighbour',
            doi: p.externalIds?.DOI ?? '',
            arxiv: p.externalIds?.ArXiv ?? '',
          })),
        ],
      }}
    >
      {(svgRef) => (
    <div className="relative w-full">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block w-full text-zinc-900 dark:text-zinc-100" role="img" aria-label="Citation timeline">
        {/* grid lines + axis labels */}
        {xTicks.map((y) => (
          <g key={`x-${y}`}>
            <line
              x1={xScale(y)} x2={xScale(y)} y1={PAD.t} y2={PAD.t + innerH}
              stroke="currentColor" strokeWidth={0.5}
              className="text-zinc-200 dark:text-zinc-800"
            />
            <text x={xScale(y)} y={H - 10} textAnchor="middle" className="fill-zinc-500 text-[10px]">
              {y}
            </text>
          </g>
        ))}
        {yTicks.map((c) => (
          <g key={`y-${c}`}>
            <line
              x1={PAD.l} x2={PAD.l + innerW} y1={yScale(c)} y2={yScale(c)}
              stroke="currentColor" strokeWidth={0.5}
              className="text-zinc-200 dark:text-zinc-800"
            />
            <text x={PAD.l - 6} y={yScale(c) + 3} textAnchor="end" className="fill-zinc-500 text-[10px]">
              {c === 0 ? '0' : c >= 1000 ? `${c / 1000}k` : c}
            </text>
          </g>
        ))}
        {/* axis labels */}
        <text x={PAD.l + innerW / 2} y={H - 24} textAnchor="middle" className="fill-zinc-400 text-[10px]">
          Publication year
        </text>
        <text
          x={12} y={PAD.t + innerH / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${PAD.t + innerH / 2})`}
          className="fill-zinc-400 text-[10px]"
        >
          Citations (log)
        </text>

        {/* bubbles */}
        {datable.map(({ p, i, y, c }) => {
          const r = rFor(c);
          const cx = xScale(y);
          const cy = yScale(c);
          return (
            <g key={`pt-${i}-${p.paperId ?? p.title}`}>
              <circle
                cx={cx} cy={cy} r={r}
                fillOpacity={opacityFor(c)}
                className="cursor-pointer fill-zinc-700 transition hover:fill-zinc-900 dark:fill-zinc-300 dark:hover:fill-zinc-100"
                onMouseEnter={() => setHover({ x: cx, y: cy, p })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelect(p)}
              >
                <title>{`${p.title ?? ''} (${y}) · ${c} cites`}</title>
              </circle>
              {labelTop.has(i) && (
                <text
                  x={cx} y={cy - r - 4}
                  textAnchor="middle"
                  className="pointer-events-none fill-zinc-600 text-[9px] dark:fill-zinc-300"
                >
                  {citesLabel(c)}
                </text>
              )}
            </g>
          );
        })}

        {/* seed ring on top */}
        {seedYear !== null && seed && (
          <circle
            cx={xScale(seedYear)} cy={yScale(seedCites)}
            r={rFor(seedCites) + 4}
            fill="none" stroke="currentColor" strokeWidth={2}
            className="text-zinc-900 dark:text-zinc-100"
          >
            <title>{`${seed.title ?? ''} — seed paper`}</title>
          </circle>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-zinc-200 bg-white p-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
          style={{
            left: `${(hover.x / W) * 100}%`,
            top: `${(hover.y / H) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 10px))',
          }}
        >
          <div className="line-clamp-2 font-medium text-zinc-900 dark:text-zinc-100">
            {hover.p.title || '(untitled)'}
          </div>
          <div className="mt-0.5 text-zinc-500">
            {hover.p.year ? String(hover.p.year) : '?'} · {hover.p.citationCount ?? 0} cites
          </div>
        </div>
      )}
    </div>
      )}
    </ChartShell>
  );
}
